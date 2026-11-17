// @ts-check
/**
 * How long a model-only find may be shown (records/design/naming.md). A find is
 * where the model saw something in ONE frame: it does not move, and the
 * answer arrives a look late. Drawn past its usefulness it is a box in
 * empty space, so its life is bounded and it fades to nothing.
 *
 * Ages are in seconds of media time since the frame the model looked at —
 * how far the picture has moved on, which is what makes a find stale. A
 * paused picture keeps its finds; a seek drops them.
 *
 * Pure functions; app/detect.js feeds them.
 */

/** A find may be shown for this many look periods: at a steady rate the
 * next look replaces it after about two, so three leaves a margin and a
 * stalled model's finds still go. */
export const FIND_LOOKS = 3;

/** …but never past this age, however slow the looks: by then anything
 * that moves has left the box. */
export const FIND_MAX_AGE = 1.5;

/** The last share of a find's life is its fade. */
export const FIND_FADE = 1 / 3;

/**
 * The age (s) at which a find is dropped: a few look periods, capped.
 * Before the look rate is known (`period` missing or not positive) the
 * cap alone applies.
 * @param {number|null|undefined} period - Seconds of media time between looks
 */
export function findBound(period) {
  if (!(period > 0)) return FIND_MAX_AGE;
  return Math.min(FIND_LOOKS * period, FIND_MAX_AGE);
}

/**
 * How strongly to draw a find, 0..1; 0 means do not draw it.
 *
 * Full strength while young, then a straight fade to nothing at `bound`.
 * A find that ARRIVED after its fade had begun is never drawn: it was
 * stale on arrival and would only blink in the wrong place. An age that
 * is not a number (no clock yet) draws nothing.
 *
 * @param {number} age - Seconds since the frame the model looked at
 * @param {number} arrivalAge - Its age when the model's answer came back
 * @param {number} bound - From findBound
 */
export function findOpacity(age, arrivalAge, bound) {
  const fadeFrom = bound * (1 - FIND_FADE);
  if (!(arrivalAge < fadeFrom) || !(age < bound)) return 0;
  if (age <= fadeFrom) return 1;
  return (bound - age) / (bound - fadeFrom);
}

/**
 * The look period for findBound: the median of the recent gaps between
 * looks (seconds of media time). Gaps that are not forward steps — a
 * pause, a seek, a loop — are not gaps between looks and are left out.
 * @param {number[]} times - Media times of recent looks, oldest first
 * @returns {number|null}
 */
export function lookPeriod(times) {
  const gaps = [];
  for (let i = 1; i < times.length; i++) {
    const gap = times[i] - times[i - 1];
    if (gap > 0) gaps.push(gap);
  }
  if (!gaps.length) return null;
  gaps.sort((a, b) => a - b);
  return gaps[Math.floor(gaps.length / 2)];
}
