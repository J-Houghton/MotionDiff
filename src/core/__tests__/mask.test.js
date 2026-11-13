import { describe, it, expect } from 'vitest';
import { MASK_VOTES_STRICT, threeFrameDifference, thresholdMask, majority3x3 } from '../mask.js';
import { boxBlur } from '../blur.js';

function makePixels(...pixels) {
  const data = new Uint8ClampedArray(pixels.length * 4);
  pixels.forEach((p, i) => data.set(p, i * 4));
  return data;
}

/** A width x height frame: `background` everywhere, `colour` in the given box. */
function frameWithBox(width, height, background, colour, x0, y0, size) {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const inside = x >= x0 && x < x0 + size && y >= y0 && y < y0 + size;
      data.set(inside ? colour : background, (y * width + x) * 4);
    }
  }
  return data;
}

function lcg(seed) {
  let s = seed >>> 0;
  return () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296; };
}

/** Add the same seeded noise of ±amplitude to every channel of a copy. */
function withNoise(frame, amplitude, seed) {
  const random = lcg(seed);
  const out = new Uint8ClampedArray(frame);
  for (let i = 0; i < out.length; i += 4) {
    const n = Math.round((random() - 0.5) * 2 * amplitude);
    out[i] += n; out[i + 1] += n; out[i + 2] += n;
  }
  return out;
}

function mask(cur, old1, old2, width, height, threshold, { blur = false, clean = false } = {}) {
  const frames = [cur, old1, old2].map((f) => {
    if (!blur) return f;
    const copy = new Uint8ClampedArray(f);
    boxBlur(copy, width, height);
    return copy;
  });
  const diff = threeFrameDifference(frames[0], frames[1], frames[2], new Uint16Array(width * height));
  const raw = thresholdMask(diff, threshold, new Uint8Array(width * height));
  return clean ? majority3x3(raw, width, height, new Uint8Array(width * height)) : raw;
}

const countIn = (m, width, x0, x1, y0, y1) => {
  let n = 0;
  for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) n += m[y * width + x];
  return n;
};

describe('threeFrameDifference', () => {
  it('keeps the smaller of the two differences, summed over the channels', () => {
    const cur = makePixels([100, 100, 100, 255], [10, 20, 30, 255]);
    const old1 = makePixels([90, 100, 110, 255], [10, 20, 30, 255]);   // sums 20, 0
    const old2 = makePixels([100, 100, 40, 255], [200, 20, 30, 255]);  // sums 60, 190
    expect(Array.from(threeFrameDifference(cur, old1, old2, new Uint16Array(2)))).toEqual([20, 0]);
  });

  it('is zero when the pixel matches either old frame', () => {
    const cur = makePixels([50, 60, 70, 255]);
    const same = makePixels([50, 60, 70, 255]);
    const other = makePixels([255, 255, 255, 255]);
    expect(threeFrameDifference(cur, same, other, new Uint16Array(1))[0]).toBe(0);
    expect(threeFrameDifference(cur, other, same, new Uint16Array(1))[0]).toBe(0);
  });
});

describe('thresholdMask', () => {
  it('compares the mean channel difference with the threshold, inclusive', () => {
    // sums 59, 60, 61 are means of 19.67, 20, 20.33
    const out = thresholdMask(Uint16Array.of(59, 60, 61), 20, new Uint8Array(3));
    expect(Array.from(out)).toEqual([0, 1, 1]);
  });

  it('never marks an unchanged pixel, even at threshold 0', () => {
    expect(Array.from(thresholdMask(Uint16Array.of(0, 1), 0, new Uint8Array(2)))).toEqual([0, 1]);
  });
});

describe('majority3x3', () => {
  const run = (rows) => {
    const height = rows.length;
    const width = rows[0].length;
    const out = majority3x3(Uint8Array.from(rows.join('').split('').map(Number)), width, height, new Uint8Array(width * height));
    return Array.from({ length: height }, (_, y) => Array.from(out.slice(y * width, (y + 1) * width)).join(''));
  };

  it('removes a lone pixel and a one-pixel line', () => {
    expect(run(['00000', '00100', '00000'])).toEqual(['00000', '00000', '00000']);
    expect(run(['00000', '11111', '00000'])).toEqual(['00000', '00000', '00000']);
  });

  it('keeps the body of a block and fills a one-pixel hole', () => {
    expect(run(['11111', '11011', '11111'])[1]).toBe('11111');
    expect(run(['00000', '01110', '01110', '01110', '00000'])[2]).toBe('01110');
  });

  it('the strict vote also removes a two-pixel line but keeps the inside of a band', () => {
    const strict = (rows) => {
      const height = rows.length;
      const width = rows[0].length;
      const out = majority3x3(Uint8Array.from(rows.join('').split('').map(Number)), width, height, new Uint8Array(width * height), MASK_VOTES_STRICT);
      return Array.from({ length: height }, (_, y) => Array.from(out.slice(y * width, (y + 1) * width)).join(''));
    };
    expect(run(['000000', '111111', '111111', '000000'])[1]).toBe('011110');   // a majority keeps it
    expect(strict(['000000', '111111', '111111', '000000'])[1]).toBe('000000'); // seven of nine does not
    expect(strict(['00000', '11111', '11111', '11111', '11111', '00000'])[2]).toBe('01110');
  });

  it('counts cells outside the image as not set', () => {
    // A corner pixel has four cells; even all set, that is fewer than five.
    expect(run(['11', '11'])).toEqual(['00', '00']);
  });
});

describe('motion mask on a moving object', () => {
  const W = 64;
  const H = 16;
  const BG = [40, 50, 60, 255];
  const OBJECT = [230, 230, 230, 255];
  const SIZE = 8;
  const at = (x) => frameWithBox(W, H, BG, OBJECT, x, 4, SIZE);

  it('marks the object where it is now and leaves no ghost where it was', () => {
    // Moving right 4 px per gap; the second gap is far enough back that the
    // object had not reached the place it later left.
    const cur = at(40);
    const old1 = at(36);
    const old2 = at(20);
    const m = mask(cur, old1, old2, W, H, 20);
    const leading = countIn(m, W, 44, 48, 4, 12);   // newly covered: [44, 48)
    const ghost = countIn(m, W, 36, 40, 4, 12);     // just vacated: [36, 40)
    expect(leading).toBe(4 * SIZE);
    expect(ghost).toBe(0);
    expect(m.reduce((a, b) => a + b, 0)).toBe(leading); // and nothing anywhere else
  });

  it('a single difference (both old frames the same) does leave the ghost', () => {
    const m = mask(at(40), at(36), at(36), W, H, 20);
    expect(countIn(m, W, 36, 40, 4, 12)).toBe(4 * SIZE);
  });

  it('keeps part of the ghost when the second gap is too short for the object\'s width', () => {
    // Between old2 and old1 the object moved 4 px, less than its 8 px width.
    const m = mask(at(40), at(36), at(32), W, H, 20);
    expect(countIn(m, W, 36, 40, 4, 12)).toBeGreaterThan(0);
  });

  it('marks nothing once the object has stopped', () => {
    const m = mask(at(40), at(40), at(40), W, H, 20);
    expect(m.reduce((a, b) => a + b, 0)).toBe(0);
  });
});

describe('motion mask under noise', () => {
  const W = 96;
  const H = 48;
  const still = frameWithBox(W, H, [90, 90, 90, 255], [90, 90, 90, 255], 0, 0, 0);
  const cur = withNoise(still, 16, 1);
  const old1 = withNoise(still, 16, 2);
  const old2 = withNoise(still, 16, 3);
  const total = (m) => m.reduce((a, b) => a + b, 0);

  it('speckles less than a single difference at the same threshold, and far less after blur and clean-up', () => {
    const single = total(mask(cur, old1, old1, W, H, 8));
    const three = total(mask(cur, old1, old2, W, H, 8));
    const cleaned = total(mask(cur, old1, old2, W, H, 8, { blur: true, clean: true }));
    expect(single).toBeGreaterThan(W * H * 0.2);  // the noise really is above the threshold
    expect(three).toBeLessThan(single * 0.75);
    expect(cleaned).toBeLessThan(single * 0.02);
  });

  it('still finds a moving object through the noise', () => {
    const box = (x, seed) => withNoise(frameWithBox(W, H, [90, 90, 90, 255], [220, 220, 220, 255], x, 16, 16), 16, seed);
    const m = mask(box(60, 1), box(52, 2), box(20, 3), W, H, 20, { blur: true, clean: true });
    // The newly covered strip [68, 76) x [16, 32).
    expect(countIn(m, W, 68, 76, 16, 32)).toBeGreaterThan(8 * 16 * 0.8);
    // The blur also leaves a thin rim on the object's other edge (x = 60):
    // still its current outline. Nothing where it used to be, nothing else.
    expect(countIn(m, W, 52, 58, 14, 34)).toBe(0);
    expect(total(m) - countIn(m, W, 58, 78, 14, 34)).toBeLessThan(8);
  });
});
