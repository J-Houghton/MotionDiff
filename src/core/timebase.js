/**
 * Media-time base for frame history.
 *
 * Frames are stamped with media time in seconds, and "the frame k back" is
 * found by time, not by counting processed frames. That keeps a gap meaning
 * the same thing whatever the source frame rate, the processing fps cap, the
 * playback rate, or how many frames were dropped along the way.
 *
 * Pure functions only — this module imports nothing (core layer rule).
 */

/**
 * `frameOffset`, `channelSpread` and friends are expressed in frames of this
 * rate: one unit is 1/30 s of media time. Presets tuned by counting frames of
 * ordinary 30 fps footage keep their look.
 */
export const REFERENCE_FPS = 30;

/**
 * During playback, a forward step longer than this means frames in between
 * were never seen (a seek, a stall): history from before it is not usable.
 */
export const MAX_CONTINUOUS_GAP = 1.0;

/**
 * Right after a seek, a forward step up to this long still counts as
 * stepping through the video (frame-step buttons, short nudges). Anything
 * longer is a jump to somewhere else.
 */
export const MAX_SEEK_STEP = 0.25;

/** Two stamps closer than this are the same frame. */
export const SAME_FRAME_EPSILON = 1e-4;

/**
 * During playback (no seek), a stamp this little before the previous one is
 * the clock, not the video, going backwards: frames can be stamped from two
 * sources (a frame callback's mediaTime, or currentTime when callbacks are
 * not arriving) that disagree by up to a frame. Treated as the same frame.
 */
export const MAX_CLOCK_JITTER = 0.1;

/**
 * A frame gap may be widened by at most this fraction of the shortest
 * requested gap when history is thinned to fit the ring. See storeInterval.
 */
export const MAX_GAP_JITTER = 0.25;

/** Assumed frame interval when there is nothing to measure it from. */
const DEFAULT_DELTA_MS = 1000 / REFERENCE_FPS;
/** A single delta longer than this would collapse a temporal filter in one step. */
const MAX_DELTA_MS = 1000;

/**
 * Convert a gap in reference frames to seconds of media time.
 * @param {number} frames
 * @returns {number}
 */
export function framesToSeconds(frames) {
  return frames / REFERENCE_FPS;
}

/**
 * Media time of the frame each colour channel is compared against.
 * Channel 0 (R) looks back `frameOffset`, channel 1 (G) one `channelSpread`
 * further, channel 2 (B) two.
 *
 * @param {number} time - Stamp of the current frame, seconds
 * @param {number} frameOffset - Gap in reference frames
 * @param {number} channelSpread - Extra gap per channel in reference frames
 * @param {number} channel - 0, 1 or 2
 * @returns {number}
 */
export function lookbackTime(time, frameOffset, channelSpread, channel) {
  return time - framesToSeconds(frameOffset + channelSpread * channel);
}

/**
 * How a newly stamped frame relates to the previous one.
 *
 * - `first`   no previous frame
 * - `repeat`  the same frame again (re-render after a parameter change)
 * - `advance` continuous with the previous frame: playback, or a frame step
 * - `rewind`  earlier than the previous frame: a loop, a backward seek or a
 *             backward frame step. History stamped at or after the new time
 *             is now in the future and must be dropped; anything older is
 *             still valid. (A backward step of under MAX_CLOCK_JITTER with
 *             no seek is clock jitter and counts as `repeat`.)
 * - `jump`    too far forward to be continuous: all history is stale
 *
 * @param {number} prevTime - Stamp of the previous frame, or NaN
 * @param {number} time - Stamp of this frame
 * @param {boolean} [seeked] - Whether a seek completed since the previous frame
 * @returns {'first'|'repeat'|'advance'|'rewind'|'jump'}
 */
export function classifyStep(prevTime, time, seeked = false) {
  if (!Number.isFinite(prevTime)) return 'first';
  const delta = time - prevTime;
  if (Math.abs(delta) < SAME_FRAME_EPSILON) return 'repeat';
  if (delta < 0) return !seeked && delta > -MAX_CLOCK_JITTER ? 'repeat' : 'rewind';
  return delta > (seeked ? MAX_SEEK_STEP : MAX_CONTINUOUS_GAP) ? 'jump' : 'advance';
}

/**
 * Milliseconds of media time a temporal filter should advance by for this
 * frame. A repeated frame advances nothing; a frame with no usable
 * predecessor gets the reference interval (the caller re-seeds its state in
 * that case, so the value only has to be sane).
 *
 * @param {'first'|'repeat'|'advance'|'rewind'|'jump'} step
 * @param {number} prevTime
 * @param {number} time
 * @returns {number}
 */
export function frameDeltaMs(step, prevTime, time) {
  if (step === 'repeat') return 0;
  if (step !== 'advance') return DEFAULT_DELTA_MS;
  const delta = (time - prevTime) * 1000;
  return Math.min(Math.max(delta, 0), MAX_DELTA_MS);
}

/**
 * Minimum spacing, in seconds, between frames kept as history.
 *
 * Ideally every frame is kept. When the ring is too short to span the
 * longest lookback at the rate frames arrive, frames are kept less often so
 * the ring still reaches far enough back. Thinning makes the nearest stored
 * frame miss its target time by up to one spacing, so the spacing is capped
 * at a fraction of the shortest gap: a long RGB spread may then fall short
 * of its target (it clamps to the oldest frame) rather than make the main
 * gap flicker between two lengths.
 *
 * A result of 0 — or anything below the real frame interval — keeps every frame.
 *
 * @param {number} frameOffset - Gap in reference frames
 * @param {number} channelSpread - Extra gap per channel in reference frames
 * @param {number} capacity - Ring length in frames
 * @returns {number}
 */
export function storeInterval(frameOffset, channelSpread, capacity) {
  const shortest = framesToSeconds(Math.max(0, frameOffset));
  const longest = framesToSeconds(Math.max(0, frameOffset + channelSpread * 2));
  // Two slots of slack: one because the newest stored frame may be the
  // current one, one so a frame at or before the oldest target exists.
  const toSpan = longest / Math.max(1, capacity - 2);
  return Math.min(toSpan, shortest * MAX_GAP_JITTER);
}

/**
 * Whether a frame should be kept as history.
 *
 * @param {number} lastStoredTime - Stamp of the newest stored frame, or NaN
 * @param {number} time - Stamp of the candidate frame
 * @param {number} interval - From storeInterval
 * @returns {boolean}
 */
export function shouldStore(lastStoredTime, time, interval) {
  if (!Number.isFinite(lastStoredTime)) return true;
  return time - lastStoredTime >= interval - SAME_FRAME_EPSILON;
}
