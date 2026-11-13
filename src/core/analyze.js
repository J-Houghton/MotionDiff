/**
 * Auto-configuration: pick a frame gap and a threshold from sampled frames.
 *
 * The input is a handful of short bursts of consecutive frames. Within a
 * burst, neighbouring frames are one sampling interval apart, so their
 * difference is per-frame motion plus sensor/codec noise — not the scene
 * change you get from frames spread across a whole clip.
 *
 * 1. Noise floor: the median per-pixel difference between neighbouring
 *    frames. In ordinary footage most pixels are static, so the median
 *    lands on the noise, not on the motion.
 * 2. Threshold: a margin above that noise floor.
 * 3. Gap: the shortest gap at which a visible share of the pixels rises
 *    above the threshold. Slow motion needs a longer gap before it clears
 *    the noise; fast motion clears it immediately.
 *
 * Differences and thresholds are in raw units: the mean absolute channel
 * difference between two frames, 0..255.
 *
 * Pure functions only — this module imports nothing (core layer rule).
 */

/** Must match core/timebase.js: frameOffset is in frames of this rate. */
const REFERENCE_FPS = 30;

/** Returned when there is nothing to analyse. */
export const DEFAULT_ANALYSIS = { frameOffset: 5, threshold: 10 };

/** Threshold = noise floor × margin + headroom, clamped. */
const NOISE_MARGIN = 3;
const NOISE_HEADROOM = 2;
const MIN_THRESHOLD = 3;
const MAX_THRESHOLD = 60;

/** Share of pixels that must clear the threshold for a gap to "show motion". */
const TARGET_ACTIVE = 0.01;
/** Below this share at the longest sampled gap, the scene counts as still. */
const MIN_ACTIVE = 0.001;
/** Gap suggested for a scene with no measurable motion. */
const STILL_SCENE_OFFSET = 15;

const MIN_OFFSET = 1;
const MAX_OFFSET = 90;

/** Sum of three channel differences ranges over 0..765. */
const HISTOGRAM_BINS = 766;

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

/**
 * Add the per-pixel difference of two frames to a histogram, binned by the
 * sum of the three channel differences (3x the raw-unit magnitude).
 * @returns {number} Pixels counted, or 0 when the frames are identical
 */
function accumulateDifference(a, b, histogram) {
  const len = Math.min(a.length, b.length);
  const local = new Uint32Array(HISTOGRAM_BINS);
  let total = 0;
  for (let i = 0; i + 2 < len; i += 4) {
    const sum = Math.abs(a[i] - b[i]) + Math.abs(a[i + 1] - b[i + 1]) + Math.abs(a[i + 2] - b[i + 2]);
    local[sum]++;
    total += sum;
  }
  // A seek that lands on the same decoded frame twice yields an identical
  // pair. Counting it would drag the noise floor to zero.
  if (total === 0) return 0;

  let pixels = 0;
  for (let bin = 0; bin < HISTOGRAM_BINS; bin++) {
    histogram[bin] += local[bin];
    pixels += local[bin];
  }
  return pixels;
}

/** Share of pixels whose difference is at or above a threshold (raw units). */
function activeFraction(a, b, threshold) {
  const len = Math.min(a.length, b.length);
  const limit = threshold * 3;
  let active = 0;
  let pixels = 0;
  for (let i = 0; i + 2 < len; i += 4) {
    const sum = Math.abs(a[i] - b[i]) + Math.abs(a[i + 1] - b[i + 1]) + Math.abs(a[i + 2] - b[i + 2]);
    if (sum >= limit) active++;
    pixels++;
  }
  return pixels ? active / pixels : 0;
}

function histogramMedian(histogram, pixels) {
  if (!pixels) return 0;
  const half = pixels / 2;
  let seen = 0;
  for (let bin = 0; bin < HISTOGRAM_BINS; bin++) {
    seen += histogram[bin];
    if (seen >= half) return bin / 3;
  }
  return 0;
}

/**
 * @param {Uint8ClampedArray[][]} bursts - Each burst is a run of consecutive
 *   RGBA frames, one sampling interval apart. A flat array of frames is
 *   treated as a single burst.
 * @param {number} fps - Rate the burst frames were sampled at. Converts the
 *   chosen gap from sampled frames to `frameOffset` units (frames at 30 fps).
 * @returns {{frameOffset: number, threshold: number, noiseFloor: number,
 *   gapSeconds: number, activeFraction: number}} frameOffset in 1/30 s
 *   units, threshold and noiseFloor in raw units (0..255)
 */
export function analyzeSample(bursts, fps) {
  const sampleFps = Number.isFinite(fps) && fps > 0 ? fps : REFERENCE_FPS;
  const fallback = { ...DEFAULT_ANALYSIS, noiseFloor: 0, gapSeconds: DEFAULT_ANALYSIS.frameOffset / REFERENCE_FPS, activeFraction: 0 };

  if (!Array.isArray(bursts) || bursts.length === 0) return fallback;
  const runs = (Array.isArray(bursts[0]) ? bursts : [bursts]).filter((run) => Array.isArray(run) && run.length >= 2);
  if (runs.length === 0) return fallback;

  // ── 1. Noise floor from neighbouring frames ──
  const histogram = new Float64Array(HISTOGRAM_BINS);
  let pixels = 0;
  for (const run of runs) {
    for (let i = 1; i < run.length; i++) {
      pixels += accumulateDifference(run[i], run[i - 1], histogram);
    }
  }
  const noiseFloor = histogramMedian(histogram, pixels);

  // ── 2. Threshold: a margin above the noise ──
  const threshold = Math.round(clamp(noiseFloor * NOISE_MARGIN + NOISE_HEADROOM, MIN_THRESHOLD, MAX_THRESHOLD));

  // ── 3. Shortest gap that shows motion ──
  const maxGap = Math.max(...runs.map((run) => run.length - 1));
  let gapFrames = 0;
  let active = 0;
  for (let gap = 1; gap <= maxGap; gap++) {
    let sum = 0;
    let pairs = 0;
    for (const run of runs) {
      for (let i = gap; i < run.length; i++) {
        sum += activeFraction(run[i], run[i - gap], threshold);
        pairs++;
      }
    }
    active = pairs ? sum / pairs : 0;
    if (active >= TARGET_ACTIVE) {
      gapFrames = gap;
      break;
    }
  }

  let frameOffset;
  if (gapFrames > 0) {
    frameOffset = (gapFrames * REFERENCE_FPS) / sampleFps;
  } else if (active >= MIN_ACTIVE) {
    // Motion is there but too slow for the burst to reach the target. The
    // moving area grows roughly in proportion to the gap, so extrapolate.
    frameOffset = (maxGap * (TARGET_ACTIVE / active) * REFERENCE_FPS) / sampleFps;
  } else {
    frameOffset = STILL_SCENE_OFFSET;
  }
  frameOffset = Math.round(clamp(frameOffset, MIN_OFFSET, MAX_OFFSET));

  return {
    frameOffset,
    threshold,
    noiseFloor,
    gapSeconds: frameOffset / REFERENCE_FPS,
    activeFraction: active,
  };
}
