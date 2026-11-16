// @ts-check
/**
 * Matching a model's boxes to the tracker's boxes (docs/naming-poc.md).
 * The two do not box the same things the same way: the detector hugs an
 * object, the motion mask boxes whatever moved together — a thin leading
 * strip of a car, two clumps of one car, or one clump over a queue of
 * cars. So a match is judged on **containment** as well as overlap: how
 * much of the smaller box lies inside the larger.
 *
 * Each motion box takes one name, from the detection that fits it best;
 * several motion boxes may take the same detection's name. What fits
 * nothing is the disagreement the picture shows: found by motion only,
 * found by the model only.
 *
 * Pure functions; app/detect.js feeds them.
 */

/**
 * @typedef {{x: number, y: number, w: number, h: number}} Box
 */

/** @param {Box} a @param {Box} b */
function sharedArea(a, b) {
  const left = Math.max(a.x, b.x);
  const top = Math.max(a.y, b.y);
  const right = Math.min(a.x + a.w, b.x + b.w);
  const bottom = Math.min(a.y + a.h, b.y + b.h);
  return right > left && bottom > top ? (right - left) * (bottom - top) : 0;
}

/**
 * Intersection over union of two boxes, 0..1.
 * @param {Box} a @param {Box} b
 */
export function iou(a, b) {
  const shared = sharedArea(a, b);
  const union = a.w * a.h + b.w * b.h - shared;
  return shared > 0 && union > 0 ? shared / union : 0;
}

/**
 * The share of the smaller box's area that lies inside the larger, 0..1:
 * 1 for a strip wholly inside a car's box, and for a car's box wholly
 * inside a clump.
 * @param {Box} a @param {Box} b
 */
export function containment(a, b) {
  const smaller = Math.min(a.w * a.h, b.w * b.h);
  return smaller > 0 ? sharedArea(a, b) / smaller : 0;
}

/** Overlap at or above this is a match on its own. Deliberately low: the
 * mask's box rarely hugs a thing the way the detector's box does. */
export const MATCH_IOU = 0.15;

/** …and so is this much of the smaller box lying inside the larger,
 * whatever the IoU: a thin strip inside a car's box overlaps it by a
 * tenth and is plainly part of it. */
export const MATCH_INSIDE = 0.6;

/** Containment only counts between boxes of comparable size: the smaller
 * at least this share of the larger. A speck inside a bus's box is not
 * the bus, and a false detection the width of the frame must not name
 * everything in it. */
export const MATCH_SIZE = 0.05;

/**
 * How well a motion box and a detection go together: 0 when they do not
 * match, otherwise containment plus IoU — so of two detections that both
 * hold a strip, the snugger one wins.
 * @param {Box} track @param {Box} detection
 */
export function fit(track, detection) {
  const overlap = iou(track, detection);
  if (!overlap) return 0;
  const held = containment(track, detection);
  const trackArea = track.w * track.h;
  const detectionArea = detection.w * detection.h;
  const comparable = Math.min(trackArea, detectionArea) >= MATCH_SIZE * Math.max(trackArea, detectionArea);
  if (overlap < MATCH_IOU && !(held >= MATCH_INSIDE && comparable)) return 0;
  return held + overlap;
}

/**
 * Give each motion box the detection that fits it best. A detection may
 * name several motion boxes (one car in two clumps); a motion box takes
 * one name (a clump over two cars is called after the one that fits it
 * better).
 *
 * - `pairs`: each matched motion box with the detection it takes its name from.
 * - `trackOnly`: motion boxes no detection fits — found by motion only.
 * - `detectionOnly`: detections that fit no motion box — found by the
 *   model only.
 * - `covered`: detections that fit a motion box which took another's
 *   name. Motion found them too, so they are not the model's own finds.
 *
 * @template {Box} T
 * @template {Box} D
 * @param {T[]} tracks
 * @param {D[]} detections
 * @returns {{pairs: {track: T, detection: D, fit: number}[], trackOnly: T[], detectionOnly: D[], covered: D[]}}
 */
export function matchBoxes(tracks, detections) {
  const pairs = [];
  const trackOnly = [];
  const named = new Set();
  const fitted = new Set();
  for (const track of tracks) {
    let best = -1;
    let bestFit = 0;
    detections.forEach((detection, di) => {
      const score = fit(track, detection);
      if (!score) return;
      fitted.add(di);
      if (score > bestFit) { bestFit = score; best = di; }
    });
    if (best < 0) { trackOnly.push(track); continue; }
    named.add(best);
    pairs.push({ track, detection: detections[best], fit: bestFit });
  }
  return {
    pairs,
    trackOnly,
    detectionOnly: detections.filter((_, di) => !fitted.has(di)),
    covered: detections.filter((_, di) => fitted.has(di) && !named.has(di)),
  };
}
