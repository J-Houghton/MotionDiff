/**
 * Motion history: where things moved, how long ago, and which way.
 *
 * One value per pixel: its age, the time since the motion mask last fired
 * there, as a share of the history length (0 = moving now, 1 = expired or
 * never). Storing time-since rather than a timestamp keeps the buffer
 * meaningful at any frame rate and playback speed: each frame adds the media
 * time that passed.
 *
 * Direction comes from the slope of the age field. Behind a moving object
 * age rises steadily, so the field falls towards where the object is now:
 * motion points down the slope. The slope at a single pixel is square to the
 * object's outline as it passed, not to its heading (behind a ball the
 * outline is an arc, and the slopes fan out to both sides), so directions
 * are only meaningful averaged over a patch about as wide as the object.
 *
 * Coordinates are the image's: x to the right, y DOWN, angles clockwise on
 * screen from "to the right".
 *
 * This module is the source of truth for the shaders in app/modes/history.js.
 * Pure functions only — it imports nothing.
 */

/**
 * A slope is trusted only where the ages around a pixel span no more than
 * this share of the history: a larger jump is the seam between two separate
 * passes (or the reset at an object's edge), not a gradient.
 */
export const HISTORY_MAX_DELTA = 0.25;

/**
 * Advance the history by one frame.
 *
 * @param {Float32Array} prev - Age per pixel before this frame
 * @param {Uint8Array} mask - 1 where the pixel is moving now
 * @param {number} ageStep - Media time since the previous frame, in history lengths
 * @param {Float32Array} next - Written; may be `prev`
 * @returns {Float32Array} next
 */
export function historyStep(prev, mask, ageStep, next) {
  for (let p = 0; p < next.length; p++) {
    next[p] = mask[p] ? 0 : Math.min(prev[p] + ageStep, 1);
  }
  return next;
}

/**
 * Direction of motion at each pixel, from the Sobel slope of the age field.
 *
 * @param {Float32Array} age - width*height ages
 * @param {number} width
 * @param {number} height
 * @param {number} maxDelta - See HISTORY_MAX_DELTA
 * @param {Float32Array} out - 3 values per pixel: unit vector (x, y) and a
 *   validity flag (1 or 0). Invalid pixels are all zero: on the border, next
 *   to an expired pixel, on a flat patch, or across a jump.
 * @returns {Float32Array} out
 */
export function historyGradient(age, width, height, maxDelta, out) {
  out.fill(0);
  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      const i = y * width + x;
      const a00 = age[i - width - 1], a01 = age[i - width], a02 = age[i - width + 1];
      const a10 = age[i - 1], a11 = age[i], a12 = age[i + 1];
      const a20 = age[i + width - 1], a21 = age[i + width], a22 = age[i + width + 1];
      const lo = Math.min(a00, a01, a02, a10, a11, a12, a20, a21, a22);
      const hi = Math.max(a00, a01, a02, a10, a11, a12, a20, a21, a22);
      if (hi >= 1 || hi - lo <= 1e-5 || hi - lo > maxDelta) continue;
      const gx = (a02 + 2 * a12 + a22) - (a00 + 2 * a10 + a20);
      const gy = (a20 + 2 * a21 + a22) - (a00 + 2 * a01 + a02);
      const length = Math.hypot(gx, gy);
      if (length < 1e-6) continue;
      // Motion runs from old to new: down the slope.
      out[i * 3] = -gx / length;
      out[i * 3 + 1] = -gy / length;
      out[i * 3 + 2] = 1;
    }
  }
  return out;
}

/**
 * Average the directions over patches. The result is a coarse grid, one cell
 * per `cell` x `cell` pixels (anchored at the image's top-left), each
 * holding the mean of the valid unit vectors in a patch: the cell itself and
 * `spread` cells on every side. The length of the mean says how well they
 * agree (1 = all the same way, 0 = cancelling out).
 *
 * A patch made of whole cells can be summed in two cheap steps (per cell,
 * then over neighbouring cells), which is how the shaders do it.
 *
 * @param {Float32Array} gradient - From historyGradient
 * @param {number} width
 * @param {number} height
 * @param {number} cell - Cell size in pixels
 * @param {number} spread - Cells added on every side of each cell
 * @param {Float32Array} out - ceil(width/cell) * ceil(height/cell) * 3:
 *   mean x, mean y, share of the patch's pixels that were valid
 * @returns {Float32Array} out
 */
export function poolDirection(gradient, width, height, cell, spread, out) {
  const cols = Math.ceil(width / cell);
  const rows = Math.ceil(height / cell);
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      let sumX = 0, sumY = 0, valid = 0, total = 0;
      for (let y = (r - spread) * cell; y < (r + spread + 1) * cell; y++) {
        if (y < 0 || y >= height) continue;
        for (let x = (c - spread) * cell; x < (c + spread + 1) * cell; x++) {
          if (x < 0 || x >= width) continue;
          const i = (y * width + x) * 3;
          sumX += gradient[i];
          sumY += gradient[i + 1];
          valid += gradient[i + 2];
          total++;
        }
      }
      const o = (r * cols + c) * 3;
      out[o] = valid > 0 ? sumX / valid : 0;
      out[o + 1] = valid > 0 ? sumY / valid : 0;
      out[o + 2] = total > 0 ? valid / total : 0;
    }
  }
  return out;
}

/**
 * Heading of a vector in degrees, 0..360: 0 = right, 90 = down, 180 = left,
 * 270 = up (y points down).
 * @param {number} x
 * @param {number} y
 * @returns {number}
 */
export function headingDegrees(x, y) {
  const degrees = (Math.atan2(y, x) * 180) / Math.PI;
  return degrees < 0 ? degrees + 360 : degrees;
}
