import { describe, it, expect } from 'vitest';
import { boxBlur, boxBlurFloat } from '../blur.js';
import {
  addBand,
  boxPool,
  emaStep,
  magnifyFrame,
  pooledSize,
  seedStates,
  seedStatesFloat,
} from '../magnify.js';

/** W x H RGBA frame from a per-pixel grey value function. */
function makeFrame(width, height, fn) {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      const v = fn(x, y);
      if (Array.isArray(v)) {
        data[i] = v[0]; data[i + 1] = v[1]; data[i + 2] = v[2];
      } else {
        data[i] = data[i + 1] = data[i + 2] = v;
      }
      data[i + 3] = 255;
    }
  }
  return data;
}

function pooledBuffer(width, height, factor) {
  const size = pooledSize(width, height, factor);
  return new Float32Array(size.width * size.height * 4);
}

describe('pooledSize', () => {
  it('divides exactly when it can', () => {
    expect(pooledSize(640, 360, 2)).toEqual({ width: 320, height: 180 });
    expect(pooledSize(640, 360, 4)).toEqual({ width: 160, height: 90 });
    expect(pooledSize(640, 360, 1)).toEqual({ width: 640, height: 360 });
  });

  it('rounds up so partial blocks keep a cell', () => {
    expect(pooledSize(641, 361, 4)).toEqual({ width: 161, height: 91 });
    expect(pooledSize(3, 3, 4)).toEqual({ width: 1, height: 1 });
  });
});

describe('boxPool', () => {
  it('factor 1 is a plain normalization', () => {
    const frame = makeFrame(2, 1, (x) => (x === 0 ? [255, 0, 51] : [102, 204, 153]));
    const out = boxPool(frame, 2, 1, 1, pooledBuffer(2, 1, 1));

    expect(Array.from(out.slice(0, 3))).toEqual([1, 0, 51 / 255].map(Math.fround));
    expect(out[4]).toBeCloseTo(102 / 255, 6);
    expect(out[3]).toBe(1);
  });

  it('averages every pixel of a 4x4 block, not just the middle 2x2', () => {
    // Only the block corners are lit. A bilinear tap at the block centre
    // reads the four middle pixels and would see nothing.
    const frame = makeFrame(4, 4, (x, y) => ((x === 0 || x === 3) && (y === 0 || y === 3) ? 255 : 0));
    const out = boxPool(frame, 4, 4, 4, pooledBuffer(4, 4, 4));

    expect(out[0]).toBeCloseTo(4 / 16, 6);
  });

  it('keeps precision finer than one 8-bit step', () => {
    // One pixel in sixteen is one level brighter: the mean moves by 1/16 of
    // a level, which an 8-bit target would round away.
    const flat = makeFrame(4, 4, () => 100);
    const nudged = makeFrame(4, 4, (x, y) => (x === 1 && y === 2 ? 101 : 100));

    const a = boxPool(flat, 4, 4, 4, pooledBuffer(4, 4, 4))[0];
    const b = boxPool(nudged, 4, 4, 4, pooledBuffer(4, 4, 4))[0];

    expect((b - a) * 255).toBeCloseTo(1 / 16, 3);
    expect(Math.round(a * 255)).toBe(Math.round(b * 255)); // invisible at 8 bits
  });

  it('averages partial edge blocks over the pixels they have', () => {
    // 3 wide, factor 2: cells cover [0,2) and [2,3)
    const frame = makeFrame(3, 1, (x) => [10, 30, 200][x]);
    const out = boxPool(frame, 3, 1, 2, pooledBuffer(3, 1, 2));

    expect(out[0]).toBeCloseTo(20 / 255, 6);
    expect(out[4]).toBeCloseTo(200 / 255, 6);
  });
});

describe('emaStep', () => {
  it('moves each state toward the frame by its alpha', () => {
    const frame = new Float32Array([1, 0, 0.5, 1]);
    const fast = new Float32Array([0, 1, 0.5, 1]);
    const slow = new Float32Array([0, 1, 0.5, 1]);

    emaStep(frame, fast, slow, 0.5, 0.1);

    expect(fast[0]).toBeCloseTo(0.5, 6);
    expect(slow[0]).toBeCloseTo(0.1, 6);
    expect(fast[1]).toBeCloseTo(0.5, 6);
    expect(slow[1]).toBeCloseTo(0.9, 6);
    expect(fast[2]).toBe(0.5);
  });

  it('seeded states stay put on a static frame', () => {
    const frame = boxPool(makeFrame(4, 4, (x, y) => 40 + x * 20 + y * 7), 4, 4, 2, pooledBuffer(4, 4, 2));
    const fast = new Float32Array(frame.length);
    const slow = new Float32Array(frame.length);
    seedStatesFloat(frame, fast, slow);

    for (let n = 0; n < 50; n++) emaStep(frame, fast, slow, 0.342, 0.136);

    for (let i = 0; i < frame.length; i++) {
      expect(fast[i]).toBeCloseTo(frame[i], 6);
      expect(slow[i]).toBeCloseTo(frame[i], 6);
    }
  });
});

describe('addBand', () => {
  it('with no band the output is the input frame', () => {
    const W = 8;
    const H = 6;
    const base = makeFrame(W, H, (x, y) => [x * 30, y * 40, 128]);
    const state = boxPool(base, W, H, 2, pooledBuffer(W, H, 2));
    const out = new Uint8ClampedArray(W * H * 4);

    addBand(base, W, H, state, state, 2, 40, 1, out);

    expect(Array.from(out)).toEqual(Array.from(base));
  });

  it('a uniform band adds the same amount everywhere', () => {
    const W = 8;
    const H = 4;
    const base = makeFrame(W, H, () => 100);
    const size = pooledSize(W, H, 4);
    const fast = new Float32Array(size.width * size.height * 4).fill(0.51);
    const slow = new Float32Array(size.width * size.height * 4).fill(0.5);
    const out = new Uint8ClampedArray(W * H * 4);

    addBand(base, W, H, fast, slow, 4, 10, 1, out);

    // 100 + 10 · 0.01 · 255 = 125.5
    for (let i = 0; i < out.length; i += 4) {
      expect(out[i]).toBeGreaterThanOrEqual(125);
      expect(out[i]).toBeLessThanOrEqual(126);
    }
  });

  it('interpolates the band between grid cells and clamps at the edges', () => {
    // 8x1 frame, factor 4 → two cells; band is 0 in the left cell and
    // 0.1 in the right one.
    const W = 8;
    const base = makeFrame(W, 1, () => 0);
    const fast = new Float32Array([0, 0, 0, 1, 0.1, 0.1, 0.1, 1]);
    const slow = new Float32Array(8);
    slow[3] = slow[7] = 1;
    const out = new Uint8ClampedArray(W * 4);

    addBand(base, W, 1, fast, slow, 4, 1, 1, out);

    const row = Array.from({ length: W }, (_, x) => out[x * 4]);
    // Flat up to the centre of the left cell, flat from the centre of the
    // right one, a ramp in between.
    expect(row[0]).toBe(0);
    expect(row[1]).toBe(0);
    expect(row[6]).toBe(Math.round(0.1 * 255));
    expect(row[7]).toBe(Math.round(0.1 * 255));
    for (let x = 1; x < W; x++) expect(row[x]).toBeGreaterThanOrEqual(row[x - 1]);
    expect(row[3]).toBeGreaterThan(row[2]);
    expect(row[4]).toBeGreaterThan(row[3]);
  });

  it('clamps the output to 0..255', () => {
    const base = makeFrame(2, 1, (x) => (x === 0 ? 250 : 5));
    const fast = new Float32Array([1, 1, 1, 1, 0, 0, 0, 1]);
    const slow = new Float32Array([0, 0, 0, 1, 1, 1, 1, 1]);
    const out = new Uint8ClampedArray(8);

    addBand(base, 2, 1, fast, slow, 1, 60, 1, out);

    expect(out[0]).toBe(255);
    expect(out[4]).toBe(0);
  });
});

describe('pooled pipeline at factor 1 equals magnifyFrame', () => {
  it('produces the same frames over a short sequence', () => {
    const W = 6;
    const H = 4;
    const frames = [0, 1, 2, 3].map((k) => makeFrame(W, H, (x, y) => [
      60 + x * 20 + Math.round(8 * Math.sin(k + x)),
      90 + y * 25 - Math.round(6 * Math.cos(k * 2 + y)),
      128 + Math.round(10 * Math.sin(k * 3)),
    ]));

    // Reference: the single-resolution loop.
    const refFast = new Float32Array(W * H * 4);
    const refSlow = new Float32Array(W * H * 4);
    seedStates(frames[0], refFast, refSlow);
    // Pooled pipeline with a 1x1 block.
    const fast = new Float32Array(W * H * 4);
    const slow = new Float32Array(W * H * 4);
    const pooled = new Float32Array(W * H * 4);
    seedStatesFloat(boxPool(frames[0], W, H, 1, pooled), fast, slow);

    for (const frame of frames) {
      const ref = new Uint8ClampedArray(W * H * 4);
      magnifyFrame(frame, refFast, refSlow, ref, 0.342, 0.136, 15, 0.8);

      const out = new Uint8ClampedArray(W * H * 4);
      emaStep(boxPool(frame, W, H, 1, pooled), fast, slow, 0.342, 0.136);
      addBand(frame, W, H, fast, slow, 1, 15, 0.8, out);

      for (let i = 0; i < out.length; i++) {
        expect(Math.abs(out[i] - ref[i])).toBeLessThanOrEqual(1);
      }
    }
  });
});

describe('pooling in float recovers a change an 8-bit pool loses', () => {
  it('a 1/16-level flicker survives amplification only with float pooling', () => {
    // A 4x4 block where one pixel alternates between 100 and 101.
    const W = 4;
    const flat = makeFrame(W, W, () => 100);
    const nudged = makeFrame(W, W, (x, y) => (x === 1 && y === 2 ? 101 : 100));

    const run = (quantize) => {
      const pooled = pooledBuffer(W, W, 4);
      const fast = new Float32Array(pooled.length);
      const slow = new Float32Array(pooled.length);
      const pool = (frame) => {
        boxPool(frame, W, W, 4, pooled);
        if (quantize) for (let i = 0; i < pooled.length; i++) pooled[i] = Math.round(pooled[i] * 255) / 255;
        return pooled;
      };
      seedStatesFloat(pool(flat), fast, slow);
      let peak = 0;
      for (let n = 0; n < 60; n++) {
        emaStep(pool(n % 20 < 10 ? nudged : flat), fast, slow, 0.342, 0.136);
        peak = Math.max(peak, Math.abs(fast[0] - slow[0]));
      }
      return peak;
    };

    expect(run(true)).toBe(0);           // rounded to 8 bits: nothing left to amplify
    expect(run(false)).toBeGreaterThan(5e-5);
  });
});

describe('boxBlurFloat', () => {
  it('matches boxBlur on 8-bit data up to rounding', () => {
    const W = 5;
    const H = 4;
    const bytes = makeFrame(W, H, (x, y) => (x * 53 + y * 31) % 256);
    const floats = new Float32Array(bytes.length);
    for (let i = 0; i < bytes.length; i++) floats[i] = bytes[i] / 255;

    boxBlur(bytes, W, H);
    boxBlurFloat(floats, W, H);

    for (let i = 0; i < bytes.length; i += 4) {
      expect(Math.abs(floats[i] * 255 - bytes[i])).toBeLessThanOrEqual(0.5 + 1e-4);
    }
  });

  it('corner pixels average only the four neighbours that exist', () => {
    const data = new Float32Array(3 * 3 * 4);
    data[0] = 0.9;
    boxBlurFloat(data, 3, 3);
    expect(data[0]).toBeCloseTo(0.9 / 4, 6);
  });

  it('leaves a uniform image unchanged', () => {
    const data = new Float32Array(4 * 4 * 4).fill(0.37);
    boxBlurFloat(data, 4, 4);
    for (let i = 0; i < data.length; i += 4) expect(data[i]).toBeCloseTo(0.37, 6);
  });
});
