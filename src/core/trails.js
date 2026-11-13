/**
 * Trails: how long a pixel's motion stays on screen.
 *
 * One feedback state per pixel and channel instead of a ring of past diff
 * frames: the strongest diff value seen recently (its "peak") and how long
 * ago it was written (its "age", in trail windows). Each frame the ages
 * advance by the media time that passed, so a trail lasts the same time at
 * any frame rate, fps cap or playback speed.
 *
 * What is shown is the peak scaled by an envelope of its age: full strength
 * for the first part of the window, then a linear fade to nothing at the end
 * of it.
 *
 * A new diff value refreshes the trail (age back to 0) when it is at least
 * TRAIL_REFRESH of what is currently shown; the stronger of the two is kept.
 * So a pixel that is still moving keeps its trail at full strength even
 * though noise makes each frame's value a little different, and a weaker but
 * newer motion takes over once the old trail has faded to near its level
 * instead of being lost behind it.
 *
 * Posy space: values deviate from the 128 baseline in either direction and
 * "strength" is the size of the deviation. Raw space: baseline 0.
 *
 * This module is the source of truth for the trail shader in
 * app/renderer.webgl.js. Pure functions only — it imports nothing.
 */

/** Share of the trail window a peak is held at full strength before fading. */
export const TRAIL_HOLD = 0.5;

/**
 * A new value refreshes the trail when it is at least this share of what is
 * shown. Requiring a strict maximum instead makes a pixel's age depend on
 * which frame of a passing edge happened to be the noisiest, and the fade
 * then turns that into speckle.
 */
export const TRAIL_REFRESH = 0.75;

const POSY_BASELINE = 128;
/** Largest deviation Posy space normalizes against (matches core/magnitude.js). */
const POSY_RANGE = 127;

/**
 * Strength of a peak of the given age.
 *
 * @param {number} age - Age in trail windows (0 = just written, 1 = expired)
 * @param {number} [hold] - Share of the window held at full strength (0..1)
 * @returns {number} 0..1
 */
export function trailEnvelope(age, hold = TRAIL_HOLD) {
  if (age >= 1) return 0;
  if (age <= hold) return 1;
  return (1 - age) / (1 - hold);
}

/**
 * Allocate an empty trail state for `pixelCount` pixels.
 * Both arrays use the RGBA layout of the frames (alpha unused) so the same
 * index addresses a pixel everywhere.
 *
 * @param {number} pixelCount
 * @returns {{peaks: Uint8ClampedArray, ages: Float32Array}}
 */
export function createTrailState(pixelCount) {
  const state = {
    peaks: new Uint8ClampedArray(pixelCount * 4),
    ages: new Float32Array(pixelCount * 4),
  };
  clearTrailState(state);
  return state;
}

/**
 * Empty a trail state: every peak is expired, so nothing is shown.
 * @param {{peaks: Uint8ClampedArray, ages: Float32Array}} state
 */
export function clearTrailState(state) {
  state.peaks.fill(0);
  state.ages.fill(1);
}

/**
 * Advance the trail by one frame.
 *
 * Reads `prev`, writes `next` (two states, so re-rendering the same frame
 * after a parameter change can start from the same `prev` again instead of
 * stacking onto its own earlier result) and writes the image to show.
 *
 * @param {{peaks: Uint8ClampedArray, ages: Float32Array}} prev - State before this frame
 * @param {{peaks: Uint8ClampedArray, ages: Float32Array}} next - State after it (written)
 * @param {Uint8ClampedArray} diff - This frame's diff (posyBlend / rawDiff output)
 * @param {Uint8ClampedArray} out - Trail image to display (written)
 * @param {object} opts
 * @param {boolean} opts.isPosy - Posy space (baseline 128) vs Raw space (baseline 0)
 * @param {number} opts.ageStep - Media time since the previous frame, in trail windows
 * @param {number} [opts.hold] - See trailEnvelope
 * @param {number} [opts.refresh] - See TRAIL_REFRESH
 * @param {number[]} [opts.ageColorNew] - With ageColorOld: show Posy motion
 *   as a colour by age instead of its own values. [r, g, b] in 0..1
 * @param {number[]} [opts.ageColorOld]
 */
export function trailStep(prev, next, diff, out, opts) {
  const { isPosy, ageStep } = opts;
  const hold = opts.hold ?? TRAIL_HOLD;
  const refresh = opts.refresh ?? TRAIL_REFRESH;
  const ageColor = isPosy && opts.ageColorNew && opts.ageColorOld;
  const base = isPosy ? POSY_BASELINE : 0;
  const len = diff.length;
  // Per-channel scratch
  const shown = [0, 0, 0];
  const strength = [0, 0, 0];
  const aged = [0, 0, 0];

  for (let i = 0; i < len; i += 4) {
    for (let c = 0; c < 3; c++) {
      const k = i + c;
      let age = Math.min(prev.ages[k] + ageStep, 1);
      let peak = prev.peaks[k];
      let env = trailEnvelope(age, hold);

      const fresh = diff[k];
      const freshDev = Math.abs(fresh - base);
      const held = (peak - base) * env; // what the trail shows now, signed
      if (freshDev > 0 && freshDev >= refresh * Math.abs(held)) {
        // Still moving here: restart the window, keeping the stronger of
        // the new value and what the old peak had faded to.
        peak = freshDev >= Math.abs(held) ? fresh : Math.floor(base + held + 0.5);
        age = 0;
        env = 1;
      }

      next.peaks[k] = peak;
      next.ages[k] = age;
      shown[c] = (peak - base) * env; // signed deviation from the baseline
      strength[c] = age < 1 ? Math.abs(peak - base) : 0; // unfaded, until it expires
      aged[c] = age;
    }

    if (ageColor) {
      // The colour slides from "new" to "old" with the strength-weighted
      // age. Brightness is the peak's mean deviation over the Posy range,
      // not faded: the colour already says how old the motion is, and
      // fading on top would hide the "old" end of the gradient.
      const dR = strength[0];
      const dG = strength[1];
      const dB = strength[2];
      const sum = dR + dG + dB;
      if (sum > 0) {
        const mag = Math.min(1, sum / (3 * POSY_RANGE));
        const t = (dR * aged[0] + dG * aged[1] + dB * aged[2]) / sum;
        for (let c = 0; c < 3; c++) {
          const tint = opts.ageColorNew[c] + (opts.ageColorOld[c] - opts.ageColorNew[c]) * t;
          out[i + c] = Math.floor(tint * mag * 255 + 0.5);
        }
      } else {
        out[i] = out[i + 1] = out[i + 2] = 0;
      }
    } else {
      // floor(x + 0.5), not the typed array's round-half-to-even, so the
      // shader can reproduce it.
      out[i] = Math.floor(base + shown[0] + 0.5);
      out[i + 1] = Math.floor(base + shown[1] + 0.5);
      out[i + 2] = Math.floor(base + shown[2] + 0.5);
    }
    out[i + 3] = 255;
  }
}
