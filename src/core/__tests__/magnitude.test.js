import { describe, it, expect } from 'vitest';
import { posyBlend, rawDiff } from '../diff.js';
import { cellEnergies } from '../energy.js';
import { bandMagnitude, diffMagnitude, poolMagnitude } from '../magnitude.js';

/** Solid grey RGBA frame with an optional brighter rectangle. */
function frameWithSquare(width, height, base, square) {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      const inside = square
        && x >= square.x && x < square.x + square.size
        && y >= square.y && y < square.y + square.size;
      const v = inside ? square.value : base;
      data[i] = data[i + 1] = data[i + 2] = v;
      data[i + 3] = 255;
    }
  }
  return data;
}

describe('diffMagnitude', () => {
  it('is 0 at the baseline of each mode', () => {
    const posy = new Uint8ClampedArray([128, 128, 128, 255]);
    const raw = new Uint8ClampedArray([0, 0, 0, 255]);

    expect(diffMagnitude(posy, true, new Float32Array(1))[0]).toBe(0);
    expect(diffMagnitude(raw, false, new Float32Array(1))[0]).toBe(0);
  });

  it('is unsigned: deviations above and below the Posy baseline count the same', () => {
    const above = new Uint8ClampedArray([168, 168, 168, 255]);
    const below = new Uint8ClampedArray([88, 88, 88, 255]);

    const a = diffMagnitude(above, true, new Float32Array(1))[0];
    const b = diffMagnitude(below, true, new Float32Array(1))[0];

    expect(a).toBeCloseTo(40 / 127, 6);
    expect(b).toBeCloseTo(a, 6);
  });

  it('averages the three channels', () => {
    const raw = new Uint8ClampedArray([255, 0, 0, 255]);
    expect(diffMagnitude(raw, false, new Float32Array(1))[0]).toBeCloseTo(1 / 3, 6);
  });

  it('reaches 1 at full scale and never exceeds it', () => {
    const posyMax = new Uint8ClampedArray([255, 255, 255, 255, 0, 0, 0, 255]);
    const out = diffMagnitude(posyMax, true, new Float32Array(2));

    expect(out[0]).toBeCloseTo(1, 6);
    expect(out[1]).toBe(1); // |0 - 128| / 127 > 1 is clamped
  });
});

describe('bandMagnitude', () => {
  it('is 0 when the two states agree', () => {
    const state = new Float32Array([0.3, 0.6, 0.9, 1]);
    expect(bandMagnitude(state, state, 20, new Float32Array(1))[0]).toBe(0);
  });

  it('is |amp · luma(fast − slow)| regardless of sign', () => {
    const fast = new Float32Array([0.52, 0.52, 0.52, 1]);
    const slow = new Float32Array([0.50, 0.50, 0.50, 1]);

    const up = bandMagnitude(fast, slow, 10, new Float32Array(1))[0];
    const down = bandMagnitude(slow, fast, 10, new Float32Array(1))[0];

    expect(up).toBeCloseTo(0.2, 5);
    expect(down).toBeCloseTo(0.2, 5);
  });

  it('is clamped to 1', () => {
    const fast = new Float32Array([1, 1, 1, 1]);
    const slow = new Float32Array([0, 0, 0, 1]);
    expect(bandMagnitude(fast, slow, 60, new Float32Array(1))[0]).toBe(1);
  });
});

describe('poolMagnitude', () => {
  it('averages each cell', () => {
    // 4x2 magnitudes, pooled to 2x1: left cell mean 0.25, right cell mean 0.75
    const mag = new Float32Array([0, 0.5, 0.5, 1, 0, 0.5, 0.5, 1]);
    const grid = poolMagnitude(mag, 4, 2, 2, 1);

    expect(grid.length).toBe(2);
    expect(grid[0]).toBeCloseTo(0.25, 6);
    expect(grid[1]).toBeCloseTo(0.75, 6);
  });

  it('row 0 is the top of the image', () => {
    const mag = new Float32Array([1, 1, 0, 0]); // 2x2: top row lit
    const grid = poolMagnitude(mag, 2, 2, 1, 2);

    expect(grid[0]).toBe(1);
    expect(grid[1]).toBe(0);
  });

  it('last column and row absorb remainder pixels', () => {
    // 5 wide into 2 columns: cells are [0,2) and [2,5)
    const mag = new Float32Array([1, 1, 0, 0, 1]);
    const grid = poolMagnitude(mag, 5, 1, 2, 1);

    expect(grid[0]).toBe(1);
    expect(grid[1]).toBeCloseTo(1 / 3, 6);
  });

  it('reuses a matching output buffer', () => {
    const out = new Float32Array(2);
    const grid = poolMagnitude(new Float32Array([1, 0]), 2, 1, 2, 1, out);
    expect(grid).toBe(out);
  });

  it('returns zeros for empty or invalid input', () => {
    expect(Array.from(poolMagnitude(null, 4, 4, 2, 2))).toEqual([0, 0, 0, 0]);
    expect(Array.from(poolMagnitude(new Float32Array(0), 0, 0, 2, 1))).toEqual([0, 0]);
  });
});

describe('magnitude before pooling (the moving-square case)', () => {
  // A bright square moves 6 px to the right inside one grid cell. Its Posy
  // diff has a band above 128 where it arrived and an equal band below 128
  // where it left.
  const W = 32;
  const H = 16;
  const prev = frameWithSquare(W, H, 60, { x: 4, y: 4, size: 6, value: 200 });
  const next = frameWithSquare(W, H, 60, { x: 10, y: 4, size: 6, value: 200 });
  const diff = new Uint8ClampedArray(W * H * 4);
  posyBlend(next, prev, diff, 0);

  it('pooling the signed diff first cancels to nothing', () => {
    // What a mip-average of the Posy texture measures: the mean VALUE of
    // the cell, then its deviation from 128.
    let sum = 0;
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W / 2; x++) sum += diff[(y * W + x) * 4];
    }
    const meanValue = sum / ((W / 2) * H);

    expect(Math.abs(meanValue - 128) / 127).toBeLessThan(0.001);
  });

  it('pooling the unsigned magnitude sees the motion', () => {
    const mag = diffMagnitude(diff, true, new Float32Array(W * H));
    const grid = poolMagnitude(mag, W, H, 2, 1);

    // 72 moved pixels of deviation 70 in a 16x16 cell.
    expect(grid[0]).toBeCloseTo((72 * 70) / 127 / 256, 4);
    expect(grid[0]).toBeGreaterThan(0.1);
    expect(grid[1]).toBe(0);
  });
});

describe('cellEnergies is poolMagnitude of diffMagnitude', () => {
  it('matches on a Posy diff with remainder cells', () => {
    const W = 37;
    const H = 23;
    const a = new Uint8ClampedArray(W * H * 4);
    const b = new Uint8ClampedArray(W * H * 4);
    for (let i = 0; i < a.length; i++) {
      a[i] = (i * 37) % 256;
      b[i] = (i * 91 + 13) % 256;
    }
    const diff = new Uint8ClampedArray(W * H * 4);
    posyBlend(a, b, diff, 6);

    const direct = cellEnergies(diff, W, H, 5, 3, true);
    const pooled = poolMagnitude(diffMagnitude(diff, true, new Float32Array(W * H)), W, H, 5, 3);

    for (let i = 0; i < direct.length; i++) expect(pooled[i]).toBeCloseTo(direct[i], 5);
  });

  it('matches on a Raw diff', () => {
    const W = 16;
    const H = 8;
    const a = new Uint8ClampedArray(W * H * 4);
    const b = new Uint8ClampedArray(W * H * 4);
    for (let i = 0; i < a.length; i++) {
      a[i] = (i * 53) % 256;
      b[i] = (i * 17 + 5) % 256;
    }
    const diff = new Uint8ClampedArray(W * H * 4);
    rawDiff(a, b, diff, 10);

    const direct = cellEnergies(diff, W, H, 4, 2, false);
    const pooled = poolMagnitude(diffMagnitude(diff, false, new Float32Array(W * H)), W, H, 4, 2);

    for (let i = 0; i < direct.length; i++) expect(pooled[i]).toBeCloseTo(direct[i], 5);
  });
});
