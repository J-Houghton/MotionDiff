import { describe, it, expect } from 'vitest';
import {
  MAX_CAMERA_SHIFT, MIN_USABLE_SHARE, REFERENCE_WARMUP_FRAMES, SCHLIEREN_BASE,
  referenceAlpha, averageStep, shiftWeight, knifeEdge, shiftStrength, noiseFloor, setupProblem,
} from '../schlieren.js';
import { flowLevel, globalShift } from '../flow.js';

function lcg(seed) {
  let s = seed >>> 0;
  return () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296; };
}

describe('referenceAlpha, averageStep', () => {
  it('takes the first frame whole, then averages the first frames evenly', () => {
    expect(referenceAlpha(33, 2, 0, false)).toBe(1);
    expect(referenceAlpha(33, 2, 1, false)).toBeCloseTo(1 / 2, 6);
    expect(referenceAlpha(33, 2, 9, false)).toBeCloseTo(1 / 10, 6);
    // A plain mean: after n frames each has counted 1/n.
    let reference = Float32Array.of(0);
    [10, 20, 30, 40].forEach((value, seen) => {
      reference = averageStep(reference, Float32Array.of(value), referenceAlpha(33, 60, seen, false), reference);
    });
    expect(reference[0]).toBeCloseTo(25, 4);
  });

  it('then follows with its time constant, whatever the frame interval', () => {
    const seen = REFERENCE_WARMUP_FRAMES;
    const one = referenceAlpha(100, 2, seen, false);
    const two = referenceAlpha(50, 2, seen, false);
    expect(1 - one).toBeCloseTo((1 - two) ** 2, 6);
    expect(one).toBeCloseTo(1 - Math.exp(-0.05), 6);
  });

  it('a held reference takes nothing new, but an empty one still takes its first frame', () => {
    expect(referenceAlpha(33, 2, 50, true)).toBe(0);
    expect(referenceAlpha(33, 2, 0, true)).toBe(1);
  });
});

describe('knifeEdge, shiftStrength, shiftWeight', () => {
  it('no shift is the baseline of 128', () => {
    expect(knifeEdge(0, 0, 'x', 0.25, 1)).toBe(SCHLIEREN_BASE);
  });

  it('shows one component, light one way and dark the other, clipped at full scale', () => {
    expect(knifeEdge(0.125, 9, 'x', 0.25, 1)).toBeCloseTo(128 + 63.5, 5);
    expect(knifeEdge(-0.125, 9, 'x', 0.25, 1)).toBeCloseTo(128 - 63.5, 5);
    expect(knifeEdge(9, -0.25, 'y', 0.25, 1)).toBe(1);
    expect(knifeEdge(5, 0, 'x', 0.25, 1)).toBe(255);
  });

  it('an untrusted shift shows as nothing', () => {
    expect(knifeEdge(0.2, 0, 'x', 0.25, 0)).toBe(SCHLIEREN_BASE);
    expect(shiftStrength(0.2, 0, 0.25, 0)).toBe(0);
    expect(shiftWeight(1, 4)).toBe(0);
    expect(shiftWeight(2, 4)).toBe(0);
    expect(shiftWeight(3, 4)).toBeCloseTo(0.5, 6);
    expect(shiftWeight(40, 4)).toBe(1);
  });

  it('strength is the size of the shift over full scale', () => {
    expect(shiftStrength(0.03, 0.04, 0.1, 1)).toBeCloseTo(0.5, 6);
    expect(shiftStrength(3, 4, 0.1, 1)).toBe(1);
  });
});

describe('noiseFloor, setupProblem', () => {
  it('is the median shift once the camera shift is out, and a small plume does not move it', () => {
    const count = 100;
    const field = new Float32Array(count * 4);
    for (let p = 0; p < count; p++) {
      const plume = p < 30;
      field.set([0.5 + (plume ? 0.4 : p % 2 ? 0.02 : -0.02), -0.2, 8, 0], p * 4);
    }
    const camera = globalShift(field, count, 4, 4);
    expect(camera.dx).toBeCloseTo(0.5, 1);
    expect(noiseFloor(field, count, 4, 4, camera)).toBeLessThan(0.05);
  });

  it('names the first thing that is wrong', () => {
    const ok = { usable: 0.8, camera: { dx: 0.05, dy: 0 }, previous: { dx: 0.04, dy: 0 }, seen: 40, held: false };
    expect(setupProblem(ok)).toBe(null);
    expect(setupProblem({ ...ok, usable: MIN_USABLE_SHARE - 0.01 })).toBe('plain');
    expect(setupProblem({ ...ok, held: true, camera: { dx: MAX_CAMERA_SHIFT + 0.1, dy: 0 }, previous: { dx: MAX_CAMERA_SHIFT + 0.1, dy: 0 } })).toBe('moved');
    // While following, a large shift is absorbed by the reference: only the shaking counts.
    expect(setupProblem({ ...ok, camera: { dx: 0.9, dy: 0 }, previous: { dx: 0.9, dy: 0 } })).toBe(null);
    expect(setupProblem({ ...ok, camera: { dx: 0.3, dy: 0 }, previous: { dx: 0, dy: 0 } })).toBe('shaking');
    expect(setupProblem({ ...ok, seen: 3 })).toBe('settling');
  });
});

describe('the measurement itself: a sub-pixel shift under noise', () => {
  // A printed-style background: random 3 px squares, softened; drawn shifted
  // by a field that is zero except in a "plume" down the middle.
  const W = 96;
  const H = 64;
  const cells = (() => { const r = lcg(31); return Array.from({ length: 40 * 30 }, () => (r() < 0.5 ? 205 : 50)); })();
  const pattern = (x, y) => {
    // Bilinear between cell centres: a square pattern seen through a soft lens.
    const fx = x / 3, fy = y / 3;
    const x0 = Math.floor(fx), y0 = Math.floor(fy);
    const at = (cx, cy) => cells[((cy % 30 + 30) % 30) * 40 + ((cx % 40) + 40) % 40];
    const tx = fx - x0, ty = fy - y0;
    return (at(x0, y0) * (1 - tx) + at(x0 + 1, y0) * tx) * (1 - ty) + (at(x0, y0 + 1) * (1 - tx) + at(x0 + 1, y0 + 1) * tx) * ty;
  };
  const shiftAt = (x) => 0.12 * Math.exp(-((x - 48) ** 2) / (2 * 8 * 8)); // peak 0.12 px, to the right

  it('recovers a 0.12 px plume from averaged frames, and is quiet beside it', () => {
    const random = lcg(77);
    const frame = (shifted) => {
      const out = new Float32Array(W * H);
      for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) out[y * W + x] = pattern(x - (shifted ? shiftAt(x) : 0), y) + (random() - 0.5) * 6;
      return out;
    };
    // Reference: the mean of 15 frames. Current: a short average of 4.
    let reference = new Float32Array(W * H);
    for (let n = 0; n < 15; n++) reference = averageStep(reference, frame(false), referenceAlpha(33, 2, n, false), reference);
    let current = frame(true);
    for (let n = 0; n < 3; n++) current = averageStep(current, frame(true), 0.4, current);

    const flow = flowLevel(reference, current, W, H, null, { radius: 4, still: 0 });
    const column = (x) => { let s = 0; for (let y = 12; y < H - 12; y++) s += flow[(y * W + x) * 3]; return s / (H - 24); };
    expect(column(48)).toBeGreaterThan(0.08);
    expect(column(48)).toBeLessThan(0.15);
    expect(Math.abs(column(14))).toBeLessThan(0.02);
    expect(Math.abs(column(82))).toBeLessThan(0.02);
    // The pattern gives every patch confidence to spare.
    expect(flow[(32 * W + 48) * 3 + 2]).toBeGreaterThan(50);
  });
});
