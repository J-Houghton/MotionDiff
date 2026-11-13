/**
 * Schlieren (background-oriented): seeing air by how it bends light.
 *
 * Air of uneven temperature (or a different gas) bends the light that passes
 * through it, so a textured background seen through it appears shifted, by a
 * fraction of a pixel. The shift at a point is proportional to the change of
 * the air's density ACROSS the line of sight, summed along it. It says where
 * the air is unevenly hot. It is not a velocity.
 *
 * The shift is measured with the Lucas–Kanade solve of core/flow.js, between
 * a reference picture of the background and the current picture. This module
 * holds what is particular to schlieren:
 *
 * - the reference: a running average of the scene. While it follows, only
 *   what changes faster than its time constant is shown; frozen ("held"), it
 *   is a picture of the background as it was, and everything since is shown;
 * - how a shift becomes a grey level (the knife-edge picture);
 * - judging the setup from the measured field: is there texture to measure
 *   against, is the camera still, how small a shift can be seen.
 *
 * Shifts are in pixels, x to the right and y down. Brightness is luma in
 * levels, 0..255.
 *
 * This module is the source of truth for the shaders in app/modes/schlieren.js.
 * Pure functions only — it imports nothing.
 */

/** Posy space: this level means "no shift" (as in core/diff.js). */
export const SCHLIEREN_BASE = 128;

/** The reference is the plain mean of the frames so far until this many have been seen. */
export const REFERENCE_WARMUP_FRAMES = 15;

/** Below this share of the picture with texture to measure against, the setup is not usable. */
export const MIN_USABLE_SHARE = 0.35;

/** A whole-picture shift beyond this many pixels means the camera has moved off its reference. */
export const MAX_CAMERA_SHIFT = 0.6;

/** The whole-picture shift may change by this many pixels between frames before the camera counts as shaking. */
export const MAX_CAMERA_JITTER = 0.12;

/**
 * Weight of a new frame in the reference.
 *
 * @param {number} dtMs - Media time since the previous frame
 * @param {number} seconds - Time constant of the running average
 * @param {number} seen - Frames already in the reference
 * @param {boolean} held - A held reference takes nothing new
 * @returns {number} 0..1
 */
export function referenceAlpha(dtMs, seconds, seen, held) {
  if (seen <= 0) return 1;
  if (held) return 0;
  // To begin with, a plain mean: every frame so far counts the same.
  const mean = 1 / (seen + 1);
  const running = seconds > 0 ? 1 - Math.exp(-Math.max(0, dtMs) / 1000 / seconds) : 1;
  return seen < REFERENCE_WARMUP_FRAMES ? Math.max(mean, running) : running;
}

/**
 * One step of a running average: out = previous + (frame − previous)·alpha.
 * The reference and the short average of the current frame both use it.
 *
 * @param {Float32Array} previous
 * @param {Float32Array} frame
 * @param {number} alpha
 * @param {Float32Array} out - May be `previous`
 * @returns {Float32Array} out
 */
export function averageStep(previous, frame, alpha, out) {
  for (let p = 0; p < out.length; p++) out[p] = previous[p] + (frame[p] - previous[p]) * alpha;
  return out;
}

/**
 * How much a measured shift counts, from its confidence: nothing below half
 * the trusted level, everything at it.
 *
 * @param {number} confidence - From core/flow.js
 * @param {number} trusted
 * @returns {number} 0..1
 */
export function shiftWeight(confidence, trusted) {
  return Math.min(1, Math.max(0, (confidence / trusted - 0.5) * 2));
}

/**
 * The knife-edge picture: one component of the shift as a grey level around
 * 128, like the light and dark sides of a classic schlieren photograph.
 *
 * @param {number} dx - Shift, pixels (the camera's own shift already taken out)
 * @param {number} dy
 * @param {'x'|'y'} axis - Which component the "knife" shows
 * @param {number} fullScale - Shift drawn as full white or black, pixels
 * @param {number} weight - From shiftWeight
 * @returns {number} Level 0..255
 */
export function knifeEdge(dx, dy, axis, fullScale, weight) {
  const part = (axis === 'y' ? dy : dx) / fullScale;
  const clamped = part < -1 ? -1 : part > 1 ? 1 : part;
  return SCHLIEREN_BASE + clamped * 127 * weight;
}

/**
 * The size of a shift as a share of full scale, 0..1.
 * @param {number} dx
 * @param {number} dy
 * @param {number} fullScale
 * @param {number} weight
 * @returns {number}
 */
export function shiftStrength(dx, dy, fullScale, weight) {
  return Math.min(1, Math.sqrt(dx * dx + dy * dy) / fullScale) * weight;
}

/**
 * The smallest shift that stands out: the median size of the shifts over the
 * trusted part of the picture, once the camera's own shift is taken out. A
 * plume covering less than half the picture does not move a median.
 *
 * @param {Float32Array} field - `stride` values per cell: dx, dy, confidence
 * @param {number} count - Cells
 * @param {number} stride
 * @param {number} trusted
 * @param {{dx: number, dy: number}} camera - The whole-picture shift
 * @returns {number} Pixels; 0 when nothing is trusted
 */
export function noiseFloor(field, count, stride, trusted, camera) {
  const sizes = [];
  for (let p = 0; p < count; p++) {
    if (field[p * stride + 2] < trusted) continue;
    sizes.push(Math.hypot(field[p * stride] - camera.dx, field[p * stride + 1] - camera.dy));
  }
  if (!sizes.length) return 0;
  sizes.sort((a, b) => a - b);
  return sizes[sizes.length >> 1];
}

/**
 * What is wrong with the setup, if anything: the first of these that applies.
 *
 *   'plain'     too little of the picture has texture to measure against
 *   'moved'     the camera has shifted away from a held reference
 *   'shaking'   the camera is moving from frame to frame
 *   'settling'  the reference has not seen enough frames yet
 *   null        ready
 *
 * @param {object} state
 * @param {number} state.usable - Share of the picture that is trusted, 0..1
 * @param {{dx: number, dy: number}} state.camera - Whole-picture shift now, pixels
 * @param {{dx: number, dy: number}|null} state.previous - The same, one frame ago
 * @param {number} state.seen - Frames in the reference
 * @param {boolean} state.held
 * @returns {'plain'|'moved'|'shaking'|'settling'|null}
 */
export function setupProblem({ usable, camera, previous, seen, held }) {
  if (usable < MIN_USABLE_SHARE) return 'plain';
  if (held && Math.hypot(camera.dx, camera.dy) > MAX_CAMERA_SHIFT) return 'moved';
  if (previous && Math.hypot(camera.dx - previous.dx, camera.dy - previous.dy) > MAX_CAMERA_JITTER) return 'shaking';
  if (seen < REFERENCE_WARMUP_FRAMES) return 'settling';
  return null;
}
