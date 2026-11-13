import { describe, it, expect } from 'vitest';
import {
  BG_HOLD_SECONDS, BG_VAR_MAX, BG_VAR_MIN, backgroundAlpha, backgroundStep, createBackgroundState,
} from '../background.js';

function makePixels(...pixels) {
  const data = new Uint8ClampedArray(pixels.length * 4);
  pixels.forEach((p, i) => data.set(p, i * 4));
  return data;
}

const FPS = 30;
const grey = (v) => makePixels([v, v, v, 255]);

/** One pixel followed over time. `frame(n)` gives its value, `moving(n)` the mask. */
function run(frames, { absorbSeconds = 2, threshold = 20, value, moving = () => false }) {
  let prev = createBackgroundState(1);
  let next = createBackgroundState(1);
  const fg = new Uint8Array(1);
  const history = [];
  const opts = { alpha: backgroundAlpha(1000 / FPS, absorbSeconds), holdStep: 1 / FPS / BG_HOLD_SECONDS, threshold };
  for (let n = 0; n < frames; n++) {
    backgroundStep(prev, next, grey(value(n)), Uint8Array.of(moving(n) ? 1 : 0), opts, fg);
    history.push(fg[0]);
    [prev, next] = [next, prev];
  }
  return { history, state: prev };
}

const at = (seconds) => Math.round(seconds * FPS);

describe('backgroundAlpha', () => {
  it('gives the same learning over the same media time at any frame rate', () => {
    const thirty = 1 - (1 - backgroundAlpha(1000 / 30, 2)) ** 30;
    const sixty = 1 - (1 - backgroundAlpha(1000 / 60, 2)) ** 60;
    expect(thirty).toBeCloseTo(sixty, 6);
  });

  it('learns nothing in no time', () => {
    expect(backgroundAlpha(0, 2)).toBe(0);
  });
});

describe('backgroundStep', () => {
  it('takes the first frame as the background', () => {
    const { history, state } = run(1, { value: () => 200 });
    expect(history).toEqual([0]);
    expect(state.mean[0]).toBeCloseTo(200 / 255, 6);
  });

  it('marks something new at once, whole, without it having to move', () => {
    // Background 60 for a second, then a bright object arrives and stays.
    const { history } = run(at(1.5), { value: (n) => (n < at(1) ? 60 : 220) });
    expect(history[at(1) - 1]).toBe(0);
    expect(history[at(1)]).toBe(1);
    expect(history[at(1.4)]).toBe(1);
  });

  it('absorbs a stopped object in roughly the set time', () => {
    const { history } = run(at(8), { absorbSeconds: 2, value: (n) => (n < at(1) ? 60 : 220) });
    const absorbedAt = history.indexOf(0, at(1)) / FPS - 1;
    expect(history[at(1 + 0.5)]).toBe(1);          // still there half a second in
    expect(absorbedAt).toBeGreaterThan(2 * 0.5);   // not before half the set time
    expect(absorbedAt).toBeLessThan(2 * 1.5);      // gone by one and a half times it
    expect(history.slice(at(1 + 3))).not.toContain(1);
  });

  it('a fainter object is absorbed sooner, a longer setting takes longer', () => {
    const absorbed = (opts) => run(at(20), opts).history.indexOf(0, at(1)) / FPS - 1;
    const strong = absorbed({ absorbSeconds: 2, value: (n) => (n < at(1) ? 60 : 220) });
    const faint = absorbed({ absorbSeconds: 2, value: (n) => (n < at(1) ? 60 : 100) });
    const slow = absorbed({ absorbSeconds: 6, value: (n) => (n < at(1) ? 60 : 220) });
    expect(faint).toBeLessThan(strong);
    expect(slow).toBeGreaterThan(strong * 2.5);
    expect(slow).toBeLessThan(6 * 1.5);
  });

  it('leaves no permanent ghost when an absorbed object moves away', () => {
    // Object from 1 s, long enough to be absorbed, gone again at 7 s.
    const { history } = run(at(12), { absorbSeconds: 2, value: (n) => (n >= at(1) && n < at(7) ? 220 : 60) });
    expect(history[at(6.9)]).toBe(0);  // absorbed: the model now expects the object
    expect(history[at(7.1)]).toBe(1);  // so the bare background reads as foreground…
    expect(history.slice(at(7 + 3))).not.toContain(1); // …but not for long
  });

  it('does not learn while the pixel is moving, nor for the hold after', () => {
    // The object is there from 1 s and keeps moving (mask on) until 5 s.
    const { history, state } = run(at(5) + 1, { value: (n) => (n < at(1) ? 60 : 220), moving: (n) => n >= at(1) && n < at(5) });
    expect(history.slice(at(1))).not.toContain(0);       // foreground the whole time
    expect(state.mean[0]).toBeCloseTo(60 / 255, 3);      // and the model has not shifted
    // Once it stops moving, the hold passes and then it is absorbed as usual.
    const after = run(at(9), { value: (n) => (n < at(1) ? 60 : 220), moving: (n) => n >= at(1) && n < at(5) });
    const absorbedAt = after.history.indexOf(0, at(5)) / FPS - 5;
    expect(absorbedAt).toBeGreaterThan(BG_HOLD_SECONDS + 1);
    expect(absorbedAt).toBeLessThan(BG_HOLD_SECONDS + 3);
  });

  it('learns the background\'s own noise and stops calling it foreground', () => {
    // A noisy background: ±14 levels, above the threshold of 8 on its own.
    let seed = 99;
    const noise = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return (seed / 4294967296 - 0.5) * 28; };
    const values = Array.from({ length: at(10) }, () => Math.round(120 + noise()));
    const { history, state } = run(values.length, { threshold: 8, value: (n) => values[n] });
    const early = history.slice(1, at(1)).reduce((a, b) => a + b, 0);
    const late = history.slice(at(8)).reduce((a, b) => a + b, 0);
    expect(early).toBeGreaterThan(0);
    expect(late).toBeLessThan(early);
    expect(late).toBeLessThanOrEqual(3);
    expect(state.variance[0]).toBeGreaterThan(BG_VAR_MIN);
    expect(state.variance[0]).toBeLessThanOrEqual(BG_VAR_MAX);
  });

  it('a moving object does not inflate the variance', () => {
    // Variance just before something bright crosses for a second, and after.
    const before = run(at(1), { value: () => 60 }).state.variance[0];
    const crossed = run(at(3), { value: (n) => (n >= at(1) && n < at(2) ? 240 : 60), moving: (n) => n >= at(1) && n < at(2) }).state.variance[0];
    expect(crossed).toBeLessThanOrEqual(before);
  });

  it('reaches its target even with a very slow setting', () => {
    // 4 levels away at a time constant of a minute: plain exponential steps
    // would be far below what a half-float texture can hold.
    const { state } = run(at(8), { absorbSeconds: 120, threshold: 20, value: (n) => (n < 2 ? 100 : 104) });
    expect(state.mean[0]).toBeCloseTo(104 / 255, 4);
  });

  it('recomputes from the same previous state when a frame is rendered again', () => {
    const prev = createBackgroundState(1);
    const seeded = createBackgroundState(1);
    const fg = new Uint8Array(1);
    const opts = { alpha: 0.1, holdStep: 0.1, threshold: 20 };
    backgroundStep(prev, seeded, grey(60), Uint8Array.of(0), opts, fg);
    const once = createBackgroundState(1);
    const twice = createBackgroundState(1);
    backgroundStep(seeded, once, grey(200), Uint8Array.of(0), opts, fg);
    backgroundStep(seeded, twice, grey(200), Uint8Array.of(0), opts, fg);
    backgroundStep(seeded, twice, grey(200), Uint8Array.of(0), opts, fg);
    expect(Array.from(twice.mean)).toEqual(Array.from(once.mean));
  });
});
