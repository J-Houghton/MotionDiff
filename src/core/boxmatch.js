// @ts-check
/**
 * Matching a model's boxes to the tracker's boxes (docs/naming-poc.md):
 * greedy best-overlap-first, so each side's finds pair up or stand alone.
 * The unmatched remainders are the two kinds of disagreement the picture
 * shows: found by motion only, found by the model only.
 *
 * Pure functions; app/detect.js feeds them.
 */

/**
 * @typedef {{x: number, y: number, w: number, h: number}} Box
 */

/**
 * Intersection over union of two boxes, 0..1.
 * @param {Box} a @param {Box} b
 */
export function iou(a, b) {
  const left = Math.max(a.x, b.x);
  const top = Math.max(a.y, b.y);
  const right = Math.min(a.x + a.w, b.x + b.w);
  const bottom = Math.min(a.y + a.h, b.y + b.h);
  if (right <= left || bottom <= top) return 0;
  const shared = (right - left) * (bottom - top);
  const union = a.w * a.h + b.w * b.h - shared;
  return union > 0 ? shared / union : 0;
}

/** Overlap below this is no match. The bar is deliberately low: the mask's
 * box is a clump or a leading edge (a thin strip over a car reads ~0.2
 * against the car's true box), so demanding a snug fit would call most
 * true pairs disagreements. Ranking is still best-overlap-first. */
export const MATCH_IOU = 0.15;

/**
 * Pair tracks with detections, greedy highest-overlap-first. One partner
 * each; what finds no partner is returned as the disagreement.
 *
 * @template {Box} T
 * @template {Box} D
 * @param {T[]} tracks
 * @param {D[]} detections
 * @param {number} [minIou]
 * @returns {{pairs: {track: T, detection: D, overlap: number}[], trackOnly: T[], detectionOnly: D[]}}
 */
export function matchBoxes(tracks, detections, minIou = MATCH_IOU) {
  const candidates = [];
  tracks.forEach((track, ti) => {
    detections.forEach((detection, di) => {
      const overlap = iou(track, detection);
      if (overlap >= minIou) candidates.push({ ti, di, overlap });
    });
  });
  candidates.sort((a, b) => b.overlap - a.overlap);
  const trackTaken = new Set();
  const detectionTaken = new Set();
  const pairs = [];
  for (const { ti, di, overlap } of candidates) {
    if (trackTaken.has(ti) || detectionTaken.has(di)) continue;
    trackTaken.add(ti);
    detectionTaken.add(di);
    pairs.push({ track: tracks[ti], detection: detections[di], overlap });
  }
  return {
    pairs,
    trackOnly: tracks.filter((_, ti) => !trackTaken.has(ti)),
    detectionOnly: detections.filter((_, di) => !detectionTaken.has(di)),
  };
}
