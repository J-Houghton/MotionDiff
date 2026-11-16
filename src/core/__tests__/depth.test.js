import { describe, expect, it } from 'vitest';
import { DEPTH_FACTOR_CLAMP, boxDepth, depthSpeedFactor, median } from '../depth.js';

describe('median', () => {
  it('odd, even, empty', () => {
    expect(median([3, 1, 2])).toBe(2);
    expect(median([4, 1, 2, 3])).toBe(2.5);
    expect(Number.isNaN(median([]))).toBe(true);
  });
});

describe('boxDepth', () => {
  // A 4×2 grid over a 400×200 picture: left half near (8), right half far (2).
  const grid = [8, 8, 2, 2, 8, 8, 2, 2];

  it('reads the cells under the box', () => {
    expect(boxDepth(grid, 4, 2, { x: 0, y: 0, w: 200, h: 200 }, 400, 200)).toBe(8);
    expect(boxDepth(grid, 4, 2, { x: 200, y: 0, w: 200, h: 200 }, 400, 200)).toBe(2);
  });

  it('a box across the divide reads the median', () => {
    expect(boxDepth(grid, 4, 2, { x: 100, y: 0, w: 200, h: 200 }, 400, 200)).toBe(5);
  });

  it('a box outside the picture reads nothing', () => {
    expect(Number.isNaN(boxDepth(grid, 4, 2, { x: 500, y: 0, w: 50, h: 50 }, 400, 200))).toBe(true);
  });
});

describe('depthSpeedFactor', () => {
  // A map from 0 (far) to 8 (near), median 4.
  it('boosts the far, damps the near', () => {
    expect(depthSpeedFactor(4, 2, 0, 8)).toBe(2);
    expect(depthSpeedFactor(4, 8, 0, 8)).toBe(0.5);
    expect(depthSpeedFactor(4, 4, 0, 8)).toBe(1);
  });

  it('clamps at four to one', () => {
    expect(depthSpeedFactor(8, 0.5, 0, 8)).toBe(DEPTH_FACTOR_CLAMP);
    expect(depthSpeedFactor(0.5, 8, 0, 8)).toBe(1 / DEPTH_FACTOR_CLAMP);
  });

  it('declines a flat map', () => {
    // Range 0.4 against a top of 8: under the 10% flat bar.
    expect(depthSpeedFactor(8, 8.2, 8, 8.4)).toBeNull();
  });

  it('declines the far tail, where a ratio explodes', () => {
    // Floor is 0 + 5% of 8 = 0.4: at or below it, no factor.
    expect(depthSpeedFactor(4, 0.3, 0, 8)).toBeNull();
    expect(depthSpeedFactor(0.3, 4, 0, 8)).toBeNull();
  });

  it('declines on nothing to stand on', () => {
    expect(depthSpeedFactor(NaN, 4, 0, 8)).toBeNull();
    expect(depthSpeedFactor(4, NaN, 0, 8)).toBeNull();
    expect(depthSpeedFactor(4, 4, 5, 5)).toBeNull();
  });
});
