/**
 * Motion mask: causal three-frame differencing.
 *
 * Plain frame differencing (Raw) marks every mover twice: where it is now and
 * where it was one gap ago, because both places changed. Comparing the
 * current frame against TWO earlier frames and keeping only what differs from
 * both removes the second copy: the place the object left looks like the
 * older frame again once the object had not yet arrived there.
 *
 *   moving = min(|cur − old1|, |cur − old2|) ≥ threshold
 *
 * For that to hold, the object must have moved by more than its own width
 * between old2 and old1; otherwise both old frames still show it in the
 * place it left and part of the ghost survives.
 *
 * Requiring two independent differences to exceed the threshold also squares
 * the chance that noise alone does, so the mask speckles far less than a
 * single difference at the same threshold. Blurring the frames first (the
 * caller's job: core/blur.js boxBlur) and a 3x3 majority vote afterwards
 * remove most of what is left.
 *
 * Everything is in whole numbers so the shader in app/modes/mask.js can match
 * it exactly. Pure functions only — this module imports nothing.
 */

/**
 * The smaller of the two frame differences, per pixel, as the SUM of the
 * three channels' absolute differences (0..765). A sum, not a mean, so it
 * stays a whole number.
 *
 * @param {Uint8ClampedArray|Uint8Array} cur - RGBA
 * @param {Uint8ClampedArray|Uint8Array} old1 - RGBA, one gap back
 * @param {Uint8ClampedArray|Uint8Array} old2 - RGBA, the second gap back
 * @param {Uint16Array} out - One value per pixel (cur.length / 4)
 * @returns {Uint16Array} out
 */
export function threeFrameDifference(cur, old1, old2, out) {
  const count = Math.min(out.length, cur.length >> 2);
  for (let p = 0, i = 0; p < count; p++, i += 4) {
    const d1 = Math.abs(cur[i] - old1[i]) + Math.abs(cur[i + 1] - old1[i + 1]) + Math.abs(cur[i + 2] - old1[i + 2]);
    const d2 = Math.abs(cur[i] - old2[i]) + Math.abs(cur[i + 1] - old2[i + 1]) + Math.abs(cur[i + 2] - old2[i + 2]);
    out[p] = d1 < d2 ? d1 : d2;
  }
  return out;
}

/**
 * Threshold a difference into a mask. The threshold is the same unit as in
 * every other mode: the mean absolute channel difference, 0..255. A pixel
 * that did not change at all is never moving, even at threshold 0.
 *
 * @param {Uint16Array} difference - From threeFrameDifference (channel sums)
 * @param {number} threshold - Mean channel difference, 0..255
 * @param {Uint8Array} out - 1 = moving, 0 = still
 * @returns {Uint8Array} out
 */
export function thresholdMask(difference, threshold, out) {
  const limit = threshold * 3;
  const count = Math.min(out.length, difference.length);
  for (let p = 0; p < count; p++) {
    const d = difference[p];
    out[p] = d > 0 && d >= limit ? 1 : 0;
  }
  return out;
}

/** Votes needed by majority3x3: a simple majority of the nine cells. */
export const MASK_VOTES = 5;
/**
 * A stricter vote for consumers that integrate the mask over time (motion
 * history): seven of nine also removes two-pixel lines, such as the hairline
 * the pre-blur leaves on a flat object's trailing edge. That hairline skips
 * pixels as it moves and would reset the history in stripes.
 */
export const MASK_VOTES_STRICT = 7;

/**
 * 3x3 vote: a pixel is set when at least `votes` of the nine cells around it
 * (itself included) are set. Cells outside the image count as not set. With
 * five (a majority) it removes lone speckles and one-pixel lines and fills
 * one-pixel holes.
 *
 * @param {Uint8Array} mask - width*height values, 0 or 1
 * @param {number} width
 * @param {number} height
 * @param {Uint8Array} out - Must not be `mask`
 * @param {number} [votes] - 1..9
 * @returns {Uint8Array} out
 */
export function majority3x3(mask, width, height, out, votes = MASK_VOTES) {
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let count = 0;
      for (let dy = -1; dy <= 1; dy++) {
        const ny = y + dy;
        if (ny < 0 || ny >= height) continue;
        for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx;
          if (nx < 0 || nx >= width) continue;
          count += mask[ny * width + nx];
        }
      }
      out[y * width + x] = count >= votes ? 1 : 0;
    }
  }
  return out;
}
