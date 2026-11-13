import { describe, it, expect } from 'vitest';
import {
  FLOW_NOISE, flowLuma, reducedSize, halve, warp, upsampleFlow, flowProducts, boxMean,
  flowLevel, pyramidFlow, smoothFlow, smoothedVector, globalShift,
} from '../flow.js';

function lcg(seed) {
  let s = seed >>> 0;
  return () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296; };
}

/**
 * A smooth random texture as a function of position, so it can be drawn
 * shifted by any fraction of a pixel: a sum of sine waves 4 to 60 pixels
 * long, the long ones stronger, as in a natural picture. (A texture of short
 * waves only is beyond any pyramid: reducing it leaves nothing to match.)
 */
function texture(seed, waves = 24) {
  const random = lcg(seed);
  const parts = [];
  for (let n = 0; n < waves; n++) {
    const length = 4 + random() * 56; // wavelength in pixels
    const angle = random() * Math.PI;
    parts.push({ kx: (Math.cos(angle) * 2 * Math.PI) / length, ky: (Math.sin(angle) * 2 * Math.PI) / length, phase: random() * 7, gain: length * 0.6 });
  }
  return (x, y) => parts.reduce((sum, p) => sum + p.gain * Math.sin(p.kx * x + p.ky * y + p.phase), 128);
}

/** width*height luma from a function of (x, y). */
function image(width, height, fn) {
  const out = new Float32Array(width * height);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) out[y * width + x] = fn(x, y);
  return out;
}

/** Mean vector and mean confidence over the middle of a flow field. */
function middle(flow, width, height, margin = 8) {
  let dx = 0, dy = 0, confidence = 0, n = 0;
  for (let y = margin; y < height - margin; y++) {
    for (let x = margin; x < width - margin; x++) {
      const i = (y * width + x) * 3;
      dx += flow[i]; dy += flow[i + 1]; confidence += flow[i + 2]; n++;
    }
  }
  return { dx: dx / n, dy: dy / n, confidence: confidence / n };
}

/** Mean and largest distance of the vectors in the middle from the expected one. */
function error(flow, width, height, dx, dy, margin = 8) {
  let max = 0, sum = 0, n = 0;
  for (let y = margin; y < height - margin; y++) {
    for (let x = margin; x < width - margin; x++) {
      const i = (y * width + x) * 3;
      const e = Math.hypot(flow[i] - dx, flow[i + 1] - dy);
      max = Math.max(max, e); sum += e; n++;
    }
  }
  return { mean: sum / n, max };
}

const W = 96;
const H = 72;

describe('flowLuma, halve', () => {
  it('weights the channels as Rec.709 and keeps levels', () => {
    const out = flowLuma(Uint8ClampedArray.of(255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255, 255, 255, 255, 255), 4, 1, 1, new Float32Array(4));
    expect(out[0]).toBeCloseTo(0.2126 * 255, 3);
    expect(out[1]).toBeCloseTo(0.7152 * 255, 3);
    expect(out[2]).toBeCloseTo(0.0722 * 255, 3);
    expect(out[3]).toBeCloseTo(255, 3);
  });

  it('averages blocks, repeating the edge where a block overhangs', () => {
    // 3 wide, 1 high, grey levels 10, 20, 60: blocks of two → (10+20)/2 and 60
    const rgba = Uint8ClampedArray.from([10, 20, 60].flatMap((v) => [v, v, v, 255]));
    expect(reducedSize(3, 2)).toBe(2);
    const out = flowLuma(rgba, 3, 1, 2, new Float32Array(2));
    expect(out[0]).toBeCloseTo(15, 3);
    expect(out[1]).toBeCloseTo(60, 3);
    const half = halve(Float32Array.of(10, 20, 60), 3, 1, new Float32Array(2));
    expect(half[0]).toBeCloseTo(15, 5);
    expect(half[1]).toBeCloseTo(60, 5);
  });
});

describe('warp, upsampleFlow, boxMean', () => {
  it('warp pulls the older frame forward by the guess', () => {
    const fn = texture(3);
    const older = image(W, H, fn);
    const guess = new Float32Array(W * H * 3);
    for (let p = 0; p < W * H; p++) { guess[p * 3] = 2; guess[p * 3 + 1] = -1; }
    const out = warp(older, W, H, guess, new Float32Array(W * H));
    // out(p) = older(p − guess): the content has moved right 2 and up 1
    expect(out[20 * W + 30]).toBeCloseTo(older[21 * W + 28], 4);
  });

  it('upsampling doubles the vectors and keeps a uniform field uniform', () => {
    const coarse = new Float32Array(4 * 3 * 3);
    for (let p = 0; p < 12; p++) { coarse[p * 3] = 1.5; coarse[p * 3 + 1] = -0.5; coarse[p * 3 + 2] = 7; }
    const fine = upsampleFlow(coarse, 4, 3, 8, 6, new Float32Array(8 * 6 * 3));
    for (let p = 0; p < 48; p++) {
      expect(fine[p * 3]).toBeCloseTo(3, 5);
      expect(fine[p * 3 + 1]).toBeCloseTo(-1, 5);
      expect(fine[p * 3 + 2]).toBeCloseTo(7, 5);
    }
  });

  it('boxMean averages a window and repeats the edge', () => {
    const src = Float32Array.of(0, 0, 9, 0, 0);
    const out = boxMean(src, 5, 1, 1, 1, new Float32Array(5));
    expect(Array.from(out)).toEqual([0, 3, 3, 3, 0]);
    const edge = boxMean(Float32Array.of(9, 0, 0), 3, 1, 1, 1, new Float32Array(3));
    expect(edge[0]).toBeCloseTo(6, 5); // the 9 counted twice
  });
});

describe('flowLevel: one size', () => {
  it('recovers a sub-pixel shift of a textured patch: 0.05 px on average, no vector 0.3 px out', () => {
    const fn = texture(11);
    for (const [dx, dy] of [[0.3, 0], [0, -0.4], [0.25, 0.35], [-0.5, 0.2]]) {
      const older = image(W, H, fn);
      const current = image(W, H, (x, y) => fn(x - dx, y - dy)); // content moved by (dx, dy)
      const flow = flowLevel(older, current, W, H, null);
      const e = error(flow, W, H, dx, dy, 12);
      expect(e.mean).toBeLessThan(0.05);
      expect(e.max).toBeLessThan(0.3);
      expect(middle(flow, W, H).confidence).toBeGreaterThan(10);
    }
  });

  it('measures a shift of a fiftieth of a pixel', () => {
    const fn = texture(12);
    const flow = flowLevel(image(W, H, fn), image(W, H, (x, y) => fn(x - 0.02, y + 0.02)), W, H, null);
    const m = middle(flow, W, H);
    expect(m.dx).toBeCloseTo(0.02, 2);
    expect(m.dy).toBeCloseTo(-0.02, 2);
  });

  it('a flat patch has no confidence and no flow, whatever the brightness did', () => {
    const flow = flowLevel(image(W, H, () => 100), image(W, H, () => 104), W, H, null);
    const m = middle(flow, W, H);
    expect(m.confidence).toBe(0);
    expect(Math.hypot(m.dx, m.dy)).toBe(0);
  });

  it('a straight edge has low confidence: the aperture problem', () => {
    // Vertical stripes moving diagonally: only the motion across them can be seen.
    const stripes = (x) => 128 + 40 * Math.sin(x * 0.5);
    const flow = flowLevel(image(W, H, stripes), image(W, H, (x) => stripes(x - 0.4)), W, H, null);
    const m = middle(flow, W, H);
    expect(m.confidence).toBeLessThan(FLOW_NOISE * 0.01);
    expect(m.dx).toBeCloseTo(0.4, 1); // across the stripes: measured
    expect(Math.abs(m.dy)).toBeLessThan(0.01); // along them: nothing claimed
  });

  it('weak texture under noise answers near zero instead of blowing up', () => {
    const random = lcg(5);
    const noisy = () => image(W, H, () => 100 + (random() - 0.5) * 2);
    const flow = flowLevel(noisy(), noisy(), W, H, null);
    expect(error(flow, W, H, 0, 0).max).toBeLessThan(0.5);
  });

  it('has no confidence where nothing moved, however good the texture', () => {
    const fn = texture(13);
    const random = lcg(8);
    const noisy = () => image(W, H, (x, y) => fn(x, y) + (random() - 0.5) * 4);
    const flow = flowLevel(noisy(), noisy(), W, H, null);
    expect(middle(flow, W, H).confidence).toBeLessThan(0.5);
    // With the test turned off (schlieren), the texture counts in full.
    expect(middle(flowLevel(noisy(), noisy(), W, H, null, { still: 0 }), W, H).confidence).toBeGreaterThan(10);
  });

  it('fails on a shift of 3 px at one size…', () => {
    const fn = texture(21);
    const flow = flowLevel(image(W, H, fn), image(W, H, (x, y) => fn(x - 3, y)), W, H, null);
    expect(Math.abs(middle(flow, W, H).dx - 3)).toBeGreaterThan(0.5);
  });
});

describe('pyramidFlow', () => {
  const PW = 160;
  const PH = 96;

  it('…and the pyramid recovers it', () => {
    const fn = texture(21);
    const flow = pyramidFlow(image(PW, PH, fn), image(PW, PH, (x, y) => fn(x - 3, y)), PW, PH, { levels: 3 });
    expect(error(flow, PW, PH, 3, 0, 16).mean).toBeLessThan(0.15);
  });

  it('recovers a shift of (6, −3) px with three sizes', () => {
    const fn = texture(31, 20);
    const flow = pyramidFlow(image(PW, PH, fn), image(PW, PH, (x, y) => fn(x - 6, y + 3)), PW, PH, { levels: 3 });
    expect(error(flow, PW, PH, 6, -3, 20).mean).toBeLessThan(0.25);
  });

  it('gives each of two regions its own motion', () => {
    const fn = texture(41, 20);
    // Left half still, right half moving down 2 px.
    const flow = pyramidFlow(image(PW, PH, fn), image(PW, PH, (x, y) => (x < PW / 2 ? fn(x, y) : fn(x, y - 2))), PW, PH, { levels: 3 });
    const at = (x, y) => [flow[(y * PW + x) * 3], flow[(y * PW + x) * 3 + 1]];
    expect(Math.hypot(...at(30, 48))).toBeLessThan(0.15);
    expect(at(130, 48)[1]).toBeCloseTo(2, 0);
  });

  it('leaves no confident halo on the still surroundings of a moving band', () => {
    const still = texture(61);
    const band = texture(62);
    const random = lcg(4);
    const frame = (shift) => image(PW, PH, (x, y) => (y >= 30 && y < 60 ? band(x - shift, y) : still(x, y)) + (random() - 0.5) * 3);
    const flow = pyramidFlow(frame(0), frame(3), PW, PH, { levels: 4 });
    let halo = 0;
    let n = 0;
    for (let y = 66; y < PH - 4; y++) {
      for (let x = 12; x < PW - 12; x++) {
        const i = (y * PW + x) * 3;
        n++;
        if (Math.hypot(flow[i], flow[i + 1]) > 0.25 && flow[i + 2] >= 4) halo++;
      }
    }
    expect(halo / n).toBeLessThan(0.01);
    // …while the band itself is measured, and trusted.
    const inside = (30 + 14) * PW + 80;
    expect(flow[inside * 3]).toBeCloseTo(3, 0);
    expect(flow[inside * 3 + 2]).toBeGreaterThan(4);
  });

  it('works on sizes that do not halve evenly', () => {
    const fn = texture(51, 20);
    const flow = pyramidFlow(image(135, 77, fn), image(135, 77, (x, y) => fn(x - 2, y - 1)), 135, 77, { levels: 3 });
    const m = middle(flow, 135, 77, 16);
    expect(Math.hypot(m.dx - 2, m.dy - 1)).toBeLessThan(0.2);
  });
});

describe('smoothFlow, smoothedVector', () => {
  const vector = (state, i = 0, floor = 0.25) => Array.from(smoothedVector(state, i, floor, [0, 0, 0]));

  it('averages confident measurements over time', () => {
    let state = new Float32Array(3);
    state = smoothFlow(state, Float32Array.of(2, -2, 8), 0.5, 4, state);
    expect(vector(state)).toEqual([2, -2, 0.5]); // one measurement: its value, half present
    state = smoothFlow(state, Float32Array.of(4, 0, 8), 0.5, 4, state);
    const [dx, dy, presence] = vector(state);
    // (1/4·2 + 1/2·4) / (3/4): the newer measurement counts double
    expect(dx).toBeCloseTo(10 / 3, 6);
    expect(dy).toBeCloseTo(-2 / 3, 6);
    expect(presence).toBe(0.75);
  });

  it('an unsure measurement counts for less, without dragging the vector to zero', () => {
    let state = Float32Array.of(3, 0, 1); // settled on (3, 0), fully present
    state = smoothFlow(state, Float32Array.of(9, 9, 0), 0.5, 4, state); // no confidence at all
    const [dx, dy, presence] = vector(state);
    expect(dx).toBeCloseTo(3, 6); // still (3, 0)…
    expect(dy).toBeCloseTo(0, 6);
    expect(presence).toBeCloseTo(0.5, 6); // …but fading
    state = smoothFlow(state, Float32Array.of(9, 9, 0), 0.5, 4, state);
    state = smoothFlow(state, Float32Array.of(9, 9, 0), 0.5, 4, state);
    expect(vector(state)).toEqual([0, 0, 0.125]); // below the floor: not measured
  });

  it('alpha 1 is no smoothing', () => {
    const out = smoothFlow(Float32Array.of(9, 9, 1), Float32Array.of(1, 2, 5), 1, 4, new Float32Array(3));
    expect(vector(out)).toEqual([1, 2, 1]);
  });
});

describe('globalShift', () => {
  it('is the median of the trusted vectors, so a moving object does not drag it', () => {
    const count = 100;
    const flow = new Float32Array(count * 3);
    for (let p = 0; p < count; p++) {
      const object = p < 20; // a fifth of the picture moves on its own
      flow[p * 3] = object ? 5 : 0.3;
      flow[p * 3 + 1] = object ? 5 : -0.2;
      flow[p * 3 + 2] = p % 10 === 9 ? 0 : 6; // every tenth vector has no confidence
    }
    const shift = globalShift(flow, count, 4);
    expect(shift.dx).toBeCloseTo(0.3, 5);
    expect(shift.dy).toBeCloseTo(-0.2, 5);
    expect(shift.share).toBeCloseTo(0.9, 5);
  });

  it('reports nothing when nothing is trusted', () => {
    expect(globalShift(new Float32Array(30), 10, 4)).toEqual({ dx: 0, dy: 0, share: 0 });
  });
});
