// @ts-check
/**
 * Depth-stage helpers (records/design/depth-stage.md): pure maths over the coarse
 * inverse-depth grid a depth model publishes. Larger values are nearer;
 * the scale (and strictly the shift) are unknown, which is why everything
 * built on these is an estimate and the factor declines where the map is
 * not trusted.
 *
 * Pure functions; app/stages.js and app/depthstage.js feed them.
 */

/** A corrected speed may not leave raw speed by more than this factor. */
export const DEPTH_FACTOR_CLAMP = 4;
/** Share of the map's range above its minimum a box must sit at: below
 * this the box is in the far tail (sky, horizon) where a ratio explodes. */
export const DEPTH_FLOOR_SHARE = 0.05;
/** A map whose range is this small (relative to its top value) is flat —
 * one wall, one synthetic card — and supports no comparison. */
export const DEPTH_FLAT_SHARE = 0.1;

/** Median of a numeric array (not mutated). */
export function median(values) {
  if (!values.length) return NaN;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/**
 * Median inverse depth over the grid cells a box covers, or NaN when the
 * box covers none. Box and picture are in the same (picture) pixels.
 *
 * @param {Float32Array|number[]} grid - cols*rows inverse depth
 * @param {number} cols @param {number} rows
 * @param {{x: number, y: number, w: number, h: number}} box
 * @param {number} pictureWidth @param {number} pictureHeight
 */
export function boxDepth(grid, cols, rows, box, pictureWidth, pictureHeight) {
  const x0 = Math.max(0, Math.floor((box.x / pictureWidth) * cols));
  const x1 = Math.min(cols - 1, Math.ceil(((box.x + box.w) / pictureWidth) * cols) - 1);
  const y0 = Math.max(0, Math.floor((box.y / pictureHeight) * rows));
  const y1 = Math.min(rows - 1, Math.ceil(((box.y + box.h) / pictureHeight) * rows) - 1);
  if (x1 < x0 || y1 < y0) return NaN;
  const cells = [];
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) cells.push(grid[y * cols + x]);
  }
  return median(cells);
}

/**
 * The factor that scales a box's speed to what it would read at the
 * reference (scene median) depth, or null where the map declines:
 * a flat map, a far-tail box, or nothing to stand on.
 *
 * @param {number} reference - Scene median inverse depth
 * @param {number} value - The box's inverse depth
 * @param {number} min @param {number} max - The map's range
 * @returns {number|null}
 */
export function depthSpeedFactor(reference, value, min, max) {
  const range = max - min;
  if (!Number.isFinite(reference) || !Number.isFinite(value) || !(range > 0)) return null;
  if (range < DEPTH_FLAT_SHARE * Math.max(Math.abs(max), 1e-6)) return null;
  const floor = min + DEPTH_FLOOR_SHARE * range;
  if (value <= floor || reference <= floor) return null;
  const factor = reference / value;
  return Math.min(DEPTH_FACTOR_CLAMP, Math.max(1 / DEPTH_FACTOR_CLAMP, factor));
}
