/**
 * Background model: what is usually at each pixel, and what is not.
 *
 * Per pixel a running mean of the colour and a running variance of how far
 * frames stray from it (one Gaussian, the simplest background model). A
 * pixel is foreground when the current frame differs from the mean by more
 * than the threshold AND by more than BG_K standard deviations.
 *
 * Unlike frame differencing this marks the whole of an object, not just the
 * edges that changed since a moment ago, and keeps marking it after it stops,
 * until the model has learnt it.
 *
 * Learning is gated by motion. Where the motion mask fired recently (within
 * BG_HOLD_SECONDS) the model is frozen, so something moving through neither
 * smears into the background nor inflates its variance. Gating on motion
 * rather than on "is foreground" is what lets a stopped object, or the hole
 * left by one that drove off, be absorbed: nothing moves there, so the model
 * catches up. The variance is learnt only from pixels that match the
 * background, so it measures the background's own noise.
 *
 * Values are 0..1 here (frames are divided by 255); the threshold argument
 * is in the usual 0..255 unit.
 *
 * This module is the source of truth for the shaders in
 * app/modes/background.js. Pure functions only — it imports nothing.
 */

/** Foreground must also exceed this many standard deviations. */
export const BG_K = 2.5;
/** The model is frozen for this long after the motion mask fired at a pixel. */
export const BG_HOLD_SECONDS = 0.5;
/** Variance limits and starting value, as squared 0..1 levels (2, 20 and 6 of 255). */
export const BG_VAR_MIN = (2 / 255) ** 2;
export const BG_VAR_MAX = (20 / 255) ** 2;
export const BG_VAR_INIT = (6 / 255) ** 2;
/**
 * The smallest step the mean takes towards the frame. Half-float textures
 * cannot hold a smaller one near 1.0, and a slow model would stall a few
 * levels short of its target.
 */
export const BG_MIN_STEP = 1 / 2048;

/**
 * Learning rate for one frame. "Absorb after" is the time a typical stopped
 * object takes to stop being foreground. One that is several times the
 * threshold in contrast needs about two time constants of the exponential
 * approach, after the hold; a time constant of a third of the setting puts
 * the total near it (measured on the truth clip: docs/verdicts.md, V4).
 *
 * @param {number} dtMs - Media time since the previous frame
 * @param {number} absorbSeconds
 * @returns {number} 0..1
 */
export function backgroundAlpha(dtMs, absorbSeconds) {
  const tau = Math.max(absorbSeconds, 0.01) / 3;
  return 1 - Math.exp(-Math.max(dtMs, 0) / 1000 / tau);
}

/**
 * @param {number} pixelCount
 * @returns {{mean: Float32Array, variance: Float32Array, since: Float32Array, empty: boolean}}
 *   mean: RGB per pixel; since: time since the motion mask fired, in holds
 */
export function createBackgroundState(pixelCount) {
  return {
    mean: new Float32Array(pixelCount * 3),
    variance: new Float32Array(pixelCount).fill(BG_VAR_INIT),
    since: new Float32Array(pixelCount).fill(1),
    empty: true,
  };
}

/**
 * Classify one frame against the model, then let the model learn from it.
 * Reads `prev`, writes `next` (two states, so a frame rendered again can be
 * recomputed from the same `prev`).
 *
 * @param {object} prev - State before this frame (createBackgroundState)
 * @param {object} next - State after it (written)
 * @param {Uint8ClampedArray|Uint8Array} cur - RGBA frame
 * @param {Uint8Array} mask - Motion mask: 1 where the pixel is moving now
 * @param {object} opts
 * @param {number} opts.alpha - From backgroundAlpha
 * @param {number} opts.holdStep - Media time since the previous frame, in holds
 * @param {number} opts.threshold - Mean channel difference, 0..255
 * @param {Uint8Array} foreground - Written: 1 = foreground
 * @param {Float32Array} [strength] - Written: mean channel difference from the model, 0..1
 */
export function backgroundStep(prev, next, cur, mask, opts, foreground, strength) {
  const { alpha, holdStep } = opts;
  const threshold = opts.threshold / 255;
  const count = foreground.length;

  for (let p = 0; p < count; p++) {
    const i = p * 4;
    const m = p * 3;
    const r = cur[i] / 255;
    const g = cur[i + 1] / 255;
    const b = cur[i + 2] / 255;

    if (prev.empty) {
      // Nothing learnt yet: this frame is the background.
      next.mean[m] = r;
      next.mean[m + 1] = g;
      next.mean[m + 2] = b;
      next.variance[p] = BG_VAR_INIT;
      next.since[p] = mask[p] ? 0 : 1;
      foreground[p] = 0;
      if (strength) strength[p] = 0;
      continue;
    }

    const er = r - prev.mean[m];
    const eg = g - prev.mean[m + 1];
    const eb = b - prev.mean[m + 2];
    const d = (Math.abs(er) + Math.abs(eg) + Math.abs(eb)) / 3;
    const isForeground = d > threshold && d > BG_K * Math.sqrt(prev.variance[p]);
    foreground[p] = isForeground ? 1 : 0;
    if (strength) strength[p] = d;

    const since = mask[p] ? 0 : Math.min(prev.since[p] + holdStep, 1);
    next.since[p] = since;
    if (since < 1) {
      // Something moved here a moment ago: learn nothing.
      next.mean[m] = prev.mean[m];
      next.mean[m + 1] = prev.mean[m + 1];
      next.mean[m + 2] = prev.mean[m + 2];
      next.variance[p] = prev.variance[p];
      continue;
    }
    next.mean[m] = prev.mean[m] + approach(er, alpha);
    next.mean[m + 1] = prev.mean[m + 1] + approach(eg, alpha);
    next.mean[m + 2] = prev.mean[m + 2] + approach(eb, alpha);
    // The variance describes the background, so only matching pixels teach it.
    next.variance[p] = isForeground
      ? prev.variance[p]
      : Math.min(BG_VAR_MAX, Math.max(BG_VAR_MIN, prev.variance[p] + alpha * (d * d - prev.variance[p])));
  }
  next.empty = false;
}

/** A step of `alpha` of the way along `error`, but never less than BG_MIN_STEP (or all of it). */
function approach(error, alpha) {
  const size = Math.abs(error);
  const step = Math.max(size * alpha, Math.min(size, BG_MIN_STEP));
  return error < 0 ? -step : step;
}
