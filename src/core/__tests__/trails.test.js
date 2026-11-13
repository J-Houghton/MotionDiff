import { describe, it, expect } from 'vitest';
import {
  TRAIL_HOLD,
  TRAIL_REFRESH,
  clearTrailState,
  createTrailState,
  trailEnvelope,
  trailStep,
} from '../trails.js';

/**
 * Build a Uint8ClampedArray from RGBA quads.
 * Usage: makePixels([R,G,B,A], [R,G,B,A], ...)
 */
function makePixels(...channels) {
  const arr = new Uint8ClampedArray(channels.length * 4);
  for (let i = 0; i < channels.length; i++) {
    arr[i * 4]     = channels[i][0];
    arr[i * 4 + 1] = channels[i][1];
    arr[i * 4 + 2] = channels[i][2];
    arr[i * 4 + 3] = channels[i][3];
  }
  return arr;
}

/**
 * Run a sequence of one-pixel diffs through the trail and return the red
 * channel shown after each. `frames` are [value, ageStep] pairs.
 */
function run(frames, { isPosy = true, hold = TRAIL_HOLD } = {}) {
  let prev = createTrailState(1);
  let next = createTrailState(1);
  const out = new Uint8ClampedArray(4);
  return frames.map(([value, ageStep]) => {
    trailStep(prev, next, makePixels([value, value, value, 255]), out, { isPosy, ageStep, hold });
    [prev, next] = [next, prev];
    return out[0];
  });
}

describe('trailEnvelope', () => {
  it('holds full strength, then fades linearly to zero at the end of the window', () => {
    expect(trailEnvelope(0, 0.5)).toBe(1);
    expect(trailEnvelope(0.5, 0.5)).toBe(1);
    expect(trailEnvelope(0.75, 0.5)).toBeCloseTo(0.5, 9);
    expect(trailEnvelope(1, 0.5)).toBe(0);
    expect(trailEnvelope(3, 0.5)).toBe(0);
  });

  it('hold 0 is a plain linear fade, hold 1 a hard cut', () => {
    expect(trailEnvelope(0.25, 0)).toBeCloseTo(0.75, 9);
    expect(trailEnvelope(0.99, 1)).toBe(1);
    expect(trailEnvelope(1, 1)).toBe(0);
  });

  it('never increases with age', () => {
    let last = 1;
    for (let age = 0; age <= 1.2; age += 0.01) {
      const e = trailEnvelope(age);
      expect(e).toBeLessThanOrEqual(last + 1e-12);
      last = e;
    }
  });
});

describe('trailStep', () => {
  it('an empty trail shows the baseline of the mode', () => {
    expect(run([[128, 0.1]], { isPosy: true })).toEqual([128]);
    expect(run([[0, 0.1]], { isPosy: false })).toEqual([0]);
  });

  it('shows a new diff value at once', () => {
    expect(run([[180, 0.1]])).toEqual([180]);
    expect(run([[60, 0.1]])).toEqual([60]);
    expect(run([[200, 0.1]], { isPosy: false })).toEqual([200]);
  });

  it('holds a peak, fades it, and drops it when the window ends (Posy)', () => {
    // Peak deviation +40, then five still frames a quarter-window apart.
    const shown = run([[168, 0.25], [128, 0.25], [128, 0.25], [128, 0.25], [128, 0.25], [128, 0.25]]);
    // ages: 0, .25, .5 (held) → .75 (half) → 1 (gone)
    expect(shown).toEqual([168, 168, 168, 148, 128, 128]);
  });

  it('fades toward 0 in Raw space', () => {
    const shown = run([[200, 0.25], [0, 0.25], [0, 0.25], [0, 0.25], [0, 0.25]], { isPosy: false });
    expect(shown).toEqual([200, 200, 200, 100, 0]);
  });

  it('negative Posy deviations trail the same way', () => {
    const shown = run([[88, 0.25], [128, 0.25], [128, 0.25], [128, 0.25], [128, 0.25]]);
    expect(shown).toEqual([88, 88, 88, 108, 128]);
  });

  it('a stronger new value replaces the peak and restarts the window', () => {
    const shown = run([[150, 0.4], [190, 0.4], [128, 0.4], [128, 0.4]]);
    // 190 written at step 2: age .4 (held) at step 3, age .8 at step 4
    expect(shown[1]).toBe(190);
    expect(shown[2]).toBe(190);
    expect(shown[3]).toBe(Math.floor(128 + 62 * 0.4 + 0.5));
  });

  it('a weaker value does not replace a peak that is still stronger', () => {
    const shown = run([[190, 0.2], [140, 0.2], [128, 0.2]]);
    expect(shown).toEqual([190, 190, 190]);
  });

  it('a weaker, newer value takes over once the old peak has faded below it', () => {
    // Strong +60 at t0, then a steady weak +10.
    const shown = run([[188, 0.2], [138, 0.2], [138, 0.2], [138, 0.2], [138, 0.2], [138, 0.2]]);
    // The strong peak is held, fades (age .6 → .8, .8 → .4 of 60) and is
    // replaced when it drops to the weak value's level; it never dips to 128.
    expect(shown[0]).toBe(188);
    expect(Math.min(...shown)).toBeGreaterThanOrEqual(138);
    expect(shown[shown.length - 1]).toBe(138);
  });

  it('a pixel still moving at similar strength keeps its trail fresh', () => {
    // An edge passing: the value wobbles with noise for four frames, then
    // stops. The window must start when the motion stops, not at whichever
    // frame happened to be strongest.
    const moving = [[170, 0.25], [166, 0.25], [169, 0.25], [165, 0.25]];
    const still = [[128, 0.25], [128, 0.25], [128, 0.25], [128, 0.25]];
    const shown = run([...moving, ...still]);

    // Strongest value is kept while moving…
    expect(shown.slice(0, 4)).toEqual([170, 170, 170, 170]);
    // …and the full window (hold, fade, gone) follows the last moving frame.
    expect(shown.slice(4)).toEqual([170, 170, 149, 128]);
  });

  it('noise-level differences between channels do not turn into colour', () => {
    // The same edge seen by three channels, each peaking on a different frame.
    let prev = createTrailState(1);
    let next = createTrailState(1);
    const out = new Uint8ClampedArray(4);
    const frames = [[172, 168, 170], [168, 172, 169], [169, 167, 172], [128, 128, 128], [128, 128, 128], [128, 128, 128]];
    const spreads = frames.map(([r, g, b]) => {
      trailStep(prev, next, makePixels([r, g, b, 255]), out, { isPosy: true, ageStep: 0.25 });
      [prev, next] = [next, prev];
      return Math.max(out[0], out[1], out[2]) - Math.min(out[0], out[1], out[2]);
    });

    // All three channels fade together: never further apart than the noise.
    expect(Math.max(...spreads)).toBeLessThanOrEqual(4);
  });

  it('a value below the refresh share leaves the trail alone', () => {
    const below = Math.floor(128 + 60 * TRAIL_REFRESH - 1);
    const shown = run([[188, 0.25], [below, 0.25], [128, 0.25], [128, 0.25]]);
    // Not refreshed at step 2: by step 4 the peak is at age 0.75 and fading.
    expect(shown).toEqual([188, 188, 188, 158]);
  });

  it('lasts the same media time however many frames it is split into', () => {
    // One window of stillness after a peak, as 4 steps or as 16 steps.
    const coarse = run([[168, 0], ...Array.from({ length: 4 }, () => [128, 0.25])]);
    const fine = run([[168, 0], ...Array.from({ length: 16 }, () => [128, 0.0625])]);
    // Same value at the same time: halfway, three quarters, end.
    expect(fine[8]).toBe(coarse[2]);
    expect(fine[12]).toBe(coarse[3]);
    expect(fine[16]).toBe(coarse[4]);
  });

  it('a zero-length step changes nothing (re-rendering the same frame)', () => {
    const prev = createTrailState(1);
    const mid = createTrailState(1);
    const out = new Uint8ClampedArray(4);
    trailStep(prev, mid, makePixels([170, 128, 128, 255]), out, { isPosy: true, ageStep: 0.3 });

    // Re-render from the same `prev` with a different diff: the result must
    // not depend on the first attempt.
    const again = createTrailState(1);
    trailStep(prev, again, makePixels([128, 128, 128, 255]), out, { isPosy: true, ageStep: 0.3 });
    expect(out[0]).toBe(128);
  });

  it('channels trail independently', () => {
    const prev = createTrailState(1);
    const next = createTrailState(1);
    const out = new Uint8ClampedArray(4);
    trailStep(prev, next, makePixels([180, 128, 128, 255]), out, { isPosy: true, ageStep: 0.1 });
    trailStep(next, prev, makePixels([128, 90, 128, 255]), out, { isPosy: true, ageStep: 0.1 });

    expect(Array.from(out)).toEqual([180, 90, 128, 255]);
  });

  it('does not modify the previous state or the diff', () => {
    const prev = createTrailState(2);
    const next = createTrailState(2);
    const diff = makePixels([150, 128, 100, 255], [128, 128, 128, 255]);
    const diffCopy = new Uint8ClampedArray(diff);
    trailStep(prev, next, diff, new Uint8ClampedArray(8), { isPosy: true, ageStep: 0.1 });

    expect(Array.from(prev.ages)).toEqual(new Array(8).fill(1));
    expect(diff).toEqual(diffCopy);
  });

  it('clearTrailState empties a used state', () => {
    const state = createTrailState(1);
    const next = createTrailState(1);
    const out = new Uint8ClampedArray(4);
    trailStep(state, next, makePixels([200, 200, 200, 255]), out, { isPosy: true, ageStep: 0 });
    clearTrailState(next);
    trailStep(next, state, makePixels([128, 128, 128, 255]), out, { isPosy: true, ageStep: 0 });

    expect(out[0]).toBe(128);
  });
});

describe('trailStep colour by age', () => {
  const NEW = [1, 0, 0];
  const OLD = [0, 0, 1];
  const opts = (ageStep) => ({ isPosy: true, ageStep, ageColorNew: NEW, ageColorOld: OLD });

  it('static pixels are black', () => {
    const out = new Uint8ClampedArray(4);
    trailStep(createTrailState(1), createTrailState(1), makePixels([128, 128, 128, 255]), out, opts(0.1));
    expect(Array.from(out)).toEqual([0, 0, 0, 255]);
  });

  it('fresh motion takes the "new" colour, scaled by its strength', () => {
    const out = new Uint8ClampedArray(4);
    // Full deviation on every channel → magnitude 1
    trailStep(createTrailState(1), createTrailState(1), makePixels([255, 255, 255, 255]), out, opts(0.1));
    expect(Array.from(out)).toEqual([255, 0, 0, 255]);
  });

  it('slides toward the "old" colour as the peak ages, at full brightness', () => {
    let prev = createTrailState(1);
    let next = createTrailState(1);
    const out = new Uint8ClampedArray(4);
    trailStep(prev, next, makePixels([255, 255, 255, 255]), out, opts(0));
    [prev, next] = [next, prev];
    trailStep(prev, next, makePixels([128, 128, 128, 255]), out, opts(0.75));

    // age 0.75: colour 75% of the way to blue, not dimmed by the fade
    expect(out[0]).toBe(Math.floor(0.25 * 255 + 0.5));
    expect(out[1]).toBe(0);
    expect(out[2]).toBe(Math.floor(0.75 * 255 + 0.5));
  });

  it('goes black when the window ends', () => {
    let prev = createTrailState(1);
    let next = createTrailState(1);
    const out = new Uint8ClampedArray(4);
    trailStep(prev, next, makePixels([255, 255, 255, 255]), out, opts(0));
    [prev, next] = [next, prev];
    trailStep(prev, next, makePixels([128, 128, 128, 255]), out, opts(1));

    expect(Array.from(out)).toEqual([0, 0, 0, 255]);
  });

  it('mixed style: a pixel that keeps moving shows new and old at once', () => {
    // Full-strength motion on every frame for more than a whole window.
    let prev = createTrailState(1);
    let next = createTrailState(1);
    const latest = new Uint8ClampedArray(4);
    const mixed = new Uint8ClampedArray(4);
    let prevL = createTrailState(1);
    let nextL = createTrailState(1);
    for (let n = 0; n < 6; n++) {
      trailStep(prev, next, makePixels([255, 255, 255, 255]), mixed, { ...opts(0.25), ageColorMixed: true });
      trailStep(prevL, nextL, makePixels([255, 255, 255, 255]), latest, { ...opts(0.25), ageColorMixed: false });
      [prev, next] = [next, prev];
      [prevL, nextL] = [nextL, prevL];
    }
    // Latest-only: still the "new" colour. Mixed: red from the newest motion
    // and blue from the start of the burst, a full window ago.
    expect(Array.from(latest)).toEqual([255, 0, 0, 255]);
    expect(Array.from(mixed)).toEqual([255, 0, 255, 255]);
  });

  it('mixed style: a burst that has only just begun is the "new" colour', () => {
    const out = new Uint8ClampedArray(4);
    trailStep(createTrailState(1), createTrailState(1), makePixels([255, 255, 255, 255]), out, { ...opts(0.25), ageColorMixed: true });
    expect(Array.from(out)).toEqual([255, 0, 0, 255]);
  });

  it('mixed style: the burst ends when the trail expires, so the next one starts new', () => {
    let prev = createTrailState(1);
    let next = createTrailState(1);
    const out = new Uint8ClampedArray(4);
    const step = (value, ageStep) => {
      trailStep(prev, next, makePixels([value, value, value, 255]), out, { ...opts(ageStep), ageColorMixed: true });
      [prev, next] = [next, prev];
    };
    for (let n = 0; n < 6; n++) step(255, 0.25); // a long burst
    step(128, 1);                                // stillness for a whole window
    expect(Array.from(out)).toEqual([0, 0, 0, 255]);
    step(255, 0.25);                             // motion returns
    expect(Array.from(out)).toEqual([255, 0, 0, 255]);
  });

  it('mixed style: the old colour carries the burst\'s typical strength, not its strongest frame', () => {
    let prev = createTrailState(1);
    let next = createTrailState(1);
    const out = new Uint8ClampedArray(4);
    const step = (value) => {
      trailStep(prev, next, makePixels([value, value, value, 255]), out, { ...opts(0.05), ageColorMixed: true });
      [prev, next] = [next, prev];
    };
    // Weak motion (deviation 20 of 127) for a whole window, with one strong frame in it.
    for (let n = 0; n < 12; n++) step(148);
    step(255);
    for (let n = 0; n < 12; n++) step(148);
    // The burst is a window old, so its colour is the "old" one (blue), but
    // only as bright as the weak motion that has been going on (40 of 255),
    // while red still shows the strong frame fading from "new".
    expect(prev.peaks[3]).toBeGreaterThan(30);
    expect(prev.peaks[3]).toBeLessThan(80);
    expect(out[2]).toBeLessThan(160);
    expect(out[0]).toBeGreaterThan(out[2] / 2);
  });

  it('mixed style: the burst strength follows the motion even in small steps', () => {
    let prev = createTrailState(1);
    let next = createTrailState(1);
    const out = new Uint8ClampedArray(4);
    const step = (value) => {
      trailStep(prev, next, makePixels([value, value, value, 255]), out, { ...opts(0.01), ageColorMixed: true });
      [prev, next] = [next, prev];
    };
    step(138); // deviation 10 → strength 20
    expect(prev.peaks[3]).toBe(20);
    for (let n = 0; n < 12; n++) step(142); // deviation 14 → strength 28
    // 8 levels away at 1% a frame would never move in 8 bits; it must arrive.
    expect(prev.peaks[3]).toBe(28);
  });

  it('is ignored in Raw space', () => {
    const out = new Uint8ClampedArray(4);
    trailStep(createTrailState(1), createTrailState(1), makePixels([90, 90, 90, 255]), out, {
      isPosy: false, ageStep: 0.1, ageColorNew: NEW, ageColorOld: OLD,
    });
    expect(Array.from(out)).toEqual([90, 90, 90, 255]);
  });
});
