import { describe, it, expect } from 'vitest';
import { HISTORY_MAX_DELTA, historyStep, historyGradient, poolDirection, headingDegrees } from '../history.js';

/** Age field from a function of (x, y). */
function field(width, height, fn) {
  const age = new Float32Array(width * height);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) age[y * width + x] = fn(x, y);
  return age;
}

const gradientAt = (g, width, x, y) => Array.from(g.slice((y * width + x) * 3, (y * width + x) * 3 + 3));
const angleBetween = (a, b) => Math.abs(((a - b + 540) % 360) - 180);

describe('historyStep', () => {
  it('resets moving pixels to 0 and ages the rest by the time that passed', () => {
    const next = historyStep(Float32Array.of(0.2, 0.2, 0.95, 1), Uint8Array.of(1, 0, 0, 0), 0.1, new Float32Array(4));
    expect(next[0]).toBe(0);
    expect(next[1]).toBeCloseTo(0.3, 6);
    expect(next[2]).toBe(1); // expired, and stays there
    expect(next[3]).toBe(1);
  });

  it('lasts the same media time whatever the frame interval', () => {
    const one = Float32Array.of(0);
    const two = Float32Array.of(0);
    for (let n = 0; n < 10; n++) historyStep(one, Uint8Array.of(0), 0.05, one);
    for (let n = 0; n < 5; n++) historyStep(two, Uint8Array.of(0), 0.1, two);
    expect(one[0]).toBeCloseTo(two[0], 5);
  });
});

describe('historyGradient', () => {
  const W = 12;
  const H = 9;

  it('points down the slope: towards the newest motion', () => {
    // Older to the left, so the thing moved right.
    const right = historyGradient(field(W, H, (x) => 0.5 - x * 0.02), W, H, HISTORY_MAX_DELTA, new Float32Array(W * H * 3));
    const [dx, dy, valid] = gradientAt(right, W, 5, 4);
    expect(valid).toBe(1);
    expect(dx).toBeCloseTo(1, 5);
    expect(dy).toBeCloseTo(0, 5);

    // Older towards the top, so it moved down: heading 90 degrees.
    const down = historyGradient(field(W, H, (x, y) => 0.5 - y * 0.02), W, H, HISTORY_MAX_DELTA, new Float32Array(W * H * 3));
    expect(headingDegrees(...gradientAt(down, W, 5, 4).slice(0, 2))).toBeCloseTo(90, 3);
  });

  it('gives a unit vector at any steepness', () => {
    const g = historyGradient(field(W, H, (x, y) => 0.6 - x * 0.03 - y * 0.01), W, H, HISTORY_MAX_DELTA, new Float32Array(W * H * 3));
    const [dx, dy] = gradientAt(g, W, 6, 4);
    expect(Math.hypot(dx, dy)).toBeCloseTo(1, 5);
    expect(headingDegrees(dx, dy)).toBeCloseTo((Math.atan2(0.01, 0.03) * 180) / Math.PI, 2);
  });

  it('rejects flat patches, borders, expired neighbours and jumps', () => {
    const out = new Float32Array(W * H * 3);
    expect(gradientAt(historyGradient(field(W, H, () => 0.3), W, H, HISTORY_MAX_DELTA, out), W, 5, 4)[2]).toBe(0);
    const ramp = field(W, H, (x) => 0.5 - x * 0.02);
    expect(gradientAt(historyGradient(ramp, W, H, HISTORY_MAX_DELTA, out), W, 0, 4)[2]).toBe(0);
    const edge = field(W, H, (x) => (x < 6 ? 0.5 - x * 0.02 : 1));
    historyGradient(edge, W, H, HISTORY_MAX_DELTA, out);
    expect(gradientAt(out, W, 5, 4)[2]).toBe(0); // touches an expired pixel
    expect(gradientAt(out, W, 3, 4)[2]).toBe(1);
    const jump = field(W, H, (x) => (x < 6 ? 0.1 : 0.6) - x * 0.005);
    historyGradient(jump, W, H, HISTORY_MAX_DELTA, out);
    expect(gradientAt(out, W, 6, 4)[2]).toBe(0); // the seam between two passes
    expect(gradientAt(out, W, 2, 4)[2]).toBe(1);
  });
});

describe('poolDirection', () => {
  it('averages a fan of directions to the heading they share', () => {
    // Left half points up-right, right half down-right: together, right.
    const W = 16;
    const H = 16;
    const g = new Float32Array(W * H * 3);
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const tilt = y < 8 ? -0.6 : 0.6;
        g.set([Math.cos(tilt), Math.sin(tilt), 1], (y * W + x) * 3);
      }
    }
    const pooled = poolDirection(g, W, H, 16, 0, new Float32Array(3));
    expect(headingDegrees(pooled[0], pooled[1])).toBeCloseTo(0, 3);
    expect(Math.hypot(pooled[0], pooled[1])).toBeCloseTo(Math.cos(0.6), 4); // partial agreement
    expect(pooled[2]).toBe(1);
  });

  it('ignores invalid pixels and reports how many were valid', () => {
    const W = 8;
    const H = 8;
    const g = new Float32Array(W * H * 3);
    g.set([0, 1, 1], (3 * W + 3) * 3);
    g.set([0, 1, 1], (4 * W + 4) * 3);
    const pooled = poolDirection(g, W, H, 8, 0, new Float32Array(3));
    expect(Array.from(pooled.slice(0, 2))).toEqual([0, 1]);
    expect(pooled[2]).toBeCloseTo(2 / 64, 6);
  });

  it('a patch is the cell and its neighbours on every side', () => {
    // Three cells in a row, only the left one holds a direction.
    const W = 12;
    const H = 4;
    const g = new Float32Array(W * H * 3);
    for (let y = 0; y < H; y++) for (let x = 0; x < 4; x++) g.set([1, 0, 1], (y * W + x) * 3);
    const alone = poolDirection(g, W, H, 4, 0, new Float32Array(9));
    expect([alone[0], alone[3], alone[6]]).toEqual([1, 0, 0]);
    const spread = poolDirection(g, W, H, 4, 1, new Float32Array(9));
    expect([spread[0], spread[3], spread[6]]).toEqual([1, 1, 0]); // the middle cell now sees its neighbour
    expect(spread[5]).toBeCloseTo(1 / 3, 6);                      // a third of its patch was valid
  });

  it('is zero where nothing is valid', () => {
    expect(Array.from(poolDirection(new Float32Array(8 * 8 * 3), 8, 8, 8, 0, new Float32Array(3)))).toEqual([0, 0, 0]);
  });
});

describe('motion history of a moving disc', () => {
  // A disc of radius 9 crossing a 160x96 frame at 30 degrees, 3 px per frame,
  // fully marked by the mask each frame (a textured object).
  const W = 160;
  const H = 96;
  const HEADING = 30;
  const SPEED = 3;
  const FRAMES = 36;
  const STEP = 1 / 30; // a history of 30 frames
  const centre = (frame) => [20 + Math.cos((HEADING * Math.PI) / 180) * SPEED * frame, 16 + Math.sin((HEADING * Math.PI) / 180) * SPEED * frame];

  let age = new Float32Array(W * H).fill(1);
  for (let frame = 0; frame < FRAMES; frame++) {
    const [cx, cy] = centre(frame);
    const mask = new Uint8Array(W * H);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) if (Math.hypot(x - cx, y - cy) <= 9) mask[y * W + x] = 1;
    age = historyStep(age, mask, STEP, new Float32Array(W * H));
  }
  const [endX, endY] = centre(FRAMES - 1);

  it('age rises steadily along the path behind the object', () => {
    const along = [];
    for (let back = 12; back <= 78; back += 6) {
      const x = Math.round(endX - Math.cos((HEADING * Math.PI) / 180) * back);
      const y = Math.round(endY - Math.sin((HEADING * Math.PI) / 180) * back);
      along.push(age[y * W + x]);
    }
    for (let n = 1; n < along.length; n++) expect(along[n]).toBeGreaterThan(along[n - 1]);
    expect(along[0]).toBeLessThan(0.1);
    expect(along[along.length - 1]).toBeGreaterThan(0.7);
  });

  it('the pooled direction matches the heading, though single pixels fan out', () => {
    const gradient = historyGradient(age, W, H, HISTORY_MAX_DELTA, new Float32Array(W * H * 3));
    // Single pixels at the two sides of the trail disagree by a wide margin…
    let widest = 0;
    for (let i = 0; i < W * H; i++) {
      if (gradient[i * 3 + 2]) widest = Math.max(widest, angleBetween(headingDegrees(gradient[i * 3], gradient[i * 3 + 1]), HEADING));
    }
    expect(widest).toBeGreaterThan(40);
    // …but a patch across the trail agrees with the heading.
    const cols = Math.ceil(W / 8);
    const pooled = poolDirection(gradient, W, H, 8, 1, new Float32Array(cols * Math.ceil(H / 8) * 3));
    const midX = Math.round(endX - Math.cos((HEADING * Math.PI) / 180) * 40);
    const midY = Math.round(endY - Math.sin((HEADING * Math.PI) / 180) * 40);
    const o = (Math.floor(midY / 8) * cols + Math.floor(midX / 8)) * 3;
    expect(pooled[o + 2]).toBeGreaterThan(0.1);
    expect(angleBetween(headingDegrees(pooled[o], pooled[o + 1]), HEADING)).toBeLessThan(10);
  });
});
