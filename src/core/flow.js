/**
 * Dense optical flow: how far, and which way, each small patch of the picture
 * moved between two frames. Lucas–Kanade, coarse to fine.
 *
 * For a patch, the brightness change between the frames (It) is explained by
 * the picture's own slopes (Ix, Iy) times the shift (dx, dy):
 *
 *     Ix·dx + Iy·dy = −It          for every pixel of the patch
 *
 * Summed over the patch that is a 2×2 system: the structure tensor
 * [[ΣIx², ΣIxIy], [ΣIxIy, ΣIy²]] against [ΣIxIt, ΣIyIt]. It holds only for
 * shifts under about a pixel, so larger motion is found on reduced copies
 * first (a pyramid): solve small, double the answer, shift the older frame by
 * it, solve for what is left one size up.
 *
 * The tensor's smaller eigenvalue says whether the patch had texture in both
 * directions. Where it is small (a flat wall, a straight edge) the answer is
 * not a measurement: that number is kept beside every vector as its
 * confidence, and a noise term on the diagonal pulls such answers to zero
 * rather than letting them blow up. Confidence is also withdrawn where the
 * shift found does not explain the change between the frames (the edge of a
 * moving thing, where one patch holds two motions; motion beyond reach), and
 * where "nothing moved" explains the two frames about as well as the shift
 * does: next to a moving thing the coarse sizes smear its motion onto the
 * still surroundings, and this is what removes that halo.
 *
 * Units and coordinates:
 * - brightness is luma in levels, 0..255 (half-float render targets cannot
 *   hold the squares of 0..1 slopes; they hold these);
 * - a flow vector is the shift in pixels of the size it was solved at, from
 *   the OLDER frame to the CURRENT one, x to the right and y DOWN;
 * - confidence is the smaller eigenvalue of the mean tensor, levels² per
 *   pixel²: about the square of the slope in the patch's weakest direction;
 *   scaled down, to zero at FLOW_MISFIT, by what the shift leaves unexplained,
 *   and by how little better than "no motion" it does (FLOW_STILL).
 *
 * Schlieren uses the same solve with a still reference picture as the
 * "older" frame: there the shift is how far the background appears displaced
 * by the air in front of it.
 *
 * This module is the source of truth for the shaders in app/flow.js.
 * Pure functions only — it imports nothing.
 */

// Rec.709 luma weights, as in core/magnify.js (core modules do not import each other).
const LUMA_R = 0.2126;
const LUMA_G = 0.7152;
const LUMA_B = 0.0722;

/** Half-width of the solve window: 3 gives 7×7 pixels. */
export const FLOW_RADIUS = 3;

/**
 * Added to the tensor's diagonal, in levels²: about the variance camera noise
 * puts into a slope. A patch whose own slopes are no stronger than this
 * returns a shift near zero.
 */
export const FLOW_NOISE = 1;

/** One solve cannot be trusted beyond this many pixels; longer answers are cut to it. */
export const FLOW_MAX_STEP = 2;

/**
 * What is left of the change between the frames once the shift is taken out,
 * expressed as the misregistration (pixels²) that would leave as much: the
 * residual divided by the patch's mean slope energy. A vector whose patch is
 * this far from explained has no confidence.
 */
export const FLOW_MISFIT = 1;

/**
 * A shift is believed in full when it explains at least this share of the
 * plain difference between the two frames, and not at all when it explains
 * under a quarter of that (the frames already match without it; fitting two
 * numbers to the noise of a 7×7 patch alone explains a few per cent). 0 turns
 * the test off: schlieren does that, where the shifts are far smaller than
 * the noise in any one pixel.
 */
export const FLOW_STILL = 0.4;

const clampIndex = (value, max) => (value < 0 ? 0 : value > max ? max : value);

/**
 * Luma of an RGBA frame, reduced by a whole factor: each output pixel is the
 * mean luma of a factor×factor block (blocks anchored at the top-left; a
 * block that overhangs the edge repeats the edge pixel).
 *
 * @param {Uint8ClampedArray|Uint8Array} rgba - width*height*4
 * @param {number} width
 * @param {number} height
 * @param {number} factor - 1, 2, 3…
 * @param {Float32Array} out - reducedSize(width, factor) * reducedSize(height, factor), in levels
 * @returns {Float32Array} out
 */
export function flowLuma(rgba, width, height, factor, out) {
  const w = reducedSize(width, factor);
  const h = reducedSize(height, factor);
  const share = 1 / (factor * factor);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let sum = 0;
      for (let dy = 0; dy < factor; dy++) {
        const row = clampIndex(y * factor + dy, height - 1) * width;
        for (let dx = 0; dx < factor; dx++) {
          const i = (row + clampIndex(x * factor + dx, width - 1)) * 4;
          sum += LUMA_R * rgba[i] + LUMA_G * rgba[i + 1] + LUMA_B * rgba[i + 2];
        }
      }
      out[y * w + x] = sum * share;
    }
  }
  return out;
}

/** Size of one side after reducing by a whole factor (rounded up). */
export function reducedSize(size, factor) {
  return Math.ceil(size / factor);
}

/**
 * Halve a single-channel image: each output pixel is the mean of a 2×2 block.
 *
 * @param {Float32Array} src - width*height
 * @param {number} width
 * @param {number} height
 * @param {Float32Array} out - reducedSize(width, 2) * reducedSize(height, 2)
 * @returns {Float32Array} out
 */
export function halve(src, width, height, out) {
  const w = reducedSize(width, 2);
  const h = reducedSize(height, 2);
  for (let y = 0; y < h; y++) {
    const r0 = clampIndex(y * 2, height - 1) * width;
    const r1 = clampIndex(y * 2 + 1, height - 1) * width;
    for (let x = 0; x < w; x++) {
      const c0 = clampIndex(x * 2, width - 1);
      const c1 = clampIndex(x * 2 + 1, width - 1);
      out[y * w + x] = (src[r0 + c0] + src[r0 + c1] + src[r1 + c0] + src[r1 + c1]) * 0.25;
    }
  }
  return out;
}

/** Read a single-channel image between pixels (bilinear, edge repeated). */
function sample(src, width, height, x, y) {
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const fx = x - x0;
  const fy = y - y0;
  const xa = clampIndex(x0, width - 1);
  const xb = clampIndex(x0 + 1, width - 1);
  const ra = clampIndex(y0, height - 1) * width;
  const rb = clampIndex(y0 + 1, height - 1) * width;
  const top = src[ra + xa] + (src[ra + xb] - src[ra + xa]) * fx;
  const bottom = src[rb + xa] + (src[rb + xb] - src[rb + xa]) * fx;
  return top + (bottom - top) * fy;
}

/**
 * Pull the older frame forward by a flow guess, so that what is left between
 * it and the current frame is small: out(p) = older(p − guess(p)).
 *
 * @param {Float32Array} older - width*height
 * @param {number} width
 * @param {number} height
 * @param {Float32Array} guess - 3 per pixel (dx, dy, confidence), in this size's pixels
 * @param {Float32Array} out - width*height
 * @returns {Float32Array} out
 */
export function warp(older, width, height, guess, out) {
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const p = y * width + x;
      out[p] = sample(older, width, height, x - guess[p * 3], y - guess[p * 3 + 1]);
    }
  }
  return out;
}

/**
 * Double a flow field onto the next size up: vectors are interpolated
 * between the coarse pixels' centres and their lengths doubled.
 *
 * @param {Float32Array} coarse - 3 per pixel, coarseWidth*coarseHeight
 * @param {number} coarseWidth
 * @param {number} coarseHeight
 * @param {number} width - Size of `out`'s grid
 * @param {number} height
 * @param {Float32Array} out - 3 per pixel; confidence is carried over, not doubled
 * @returns {Float32Array} out
 */
export function upsampleFlow(coarse, coarseWidth, coarseHeight, width, height, out) {
  for (let y = 0; y < height; y++) {
    const cy = (y + 0.5) * 0.5 - 0.5;
    const y0 = Math.floor(cy);
    const fy = cy - y0;
    const ra = clampIndex(y0, coarseHeight - 1) * coarseWidth;
    const rb = clampIndex(y0 + 1, coarseHeight - 1) * coarseWidth;
    for (let x = 0; x < width; x++) {
      const cx = (x + 0.5) * 0.5 - 0.5;
      const x0 = Math.floor(cx);
      const fx = cx - x0;
      const xa = clampIndex(x0, coarseWidth - 1);
      const xb = clampIndex(x0 + 1, coarseWidth - 1);
      const o = (y * width + x) * 3;
      for (let c = 0; c < 3; c++) {
        const top = coarse[(ra + xa) * 3 + c] + (coarse[(ra + xb) * 3 + c] - coarse[(ra + xa) * 3 + c]) * fx;
        const bottom = coarse[(rb + xa) * 3 + c] + (coarse[(rb + xb) * 3 + c] - coarse[(rb + xa) * 3 + c]) * fx;
        out[o + c] = (top + (bottom - top) * fy) * (c < 2 ? 2 : 1);
      }
    }
  }
  return out;
}

/**
 * The per-pixel terms of the Lucas–Kanade system for two frames. Slopes are
 * central differences averaged over both frames (which cancels the error a
 * one-sided slope makes on a half-pixel shift).
 *
 * @param {Float32Array} older - width*height (already warped by any guess)
 * @param {Float32Array} current - width*height
 * @param {number} width
 * @param {number} height
 * @param {Float32Array} tensor - Written, 4 per pixel: Ix², Ix·Iy, Iy², and the
 *   squared difference between the current frame and the older one as it was
 *   before warping (what "nothing moved" leaves unexplained)
 * @param {Float32Array} mismatch - Written, 3 per pixel: Ix·It, Iy·It, It²
 * @param {Float32Array} [unwarped] - The older frame before warping; default `older`
 */
export function flowProducts(older, current, width, height, tensor, mismatch, unwarped = older) {
  for (let y = 0; y < height; y++) {
    const up = clampIndex(y - 1, height - 1) * width;
    const down = clampIndex(y + 1, height - 1) * width;
    const row = y * width;
    for (let x = 0; x < width; x++) {
      const left = clampIndex(x - 1, width - 1);
      const right = clampIndex(x + 1, width - 1);
      const ix = (older[row + right] - older[row + left] + current[row + right] - current[row + left]) * 0.25;
      const iy = (older[down + x] - older[up + x] + current[down + x] - current[up + x]) * 0.25;
      const it = current[row + x] - older[row + x];
      const p = row + x;
      const plain = current[p] - unwarped[p];
      tensor[p * 4] = ix * ix;
      tensor[p * 4 + 1] = ix * iy;
      tensor[p * 4 + 2] = iy * iy;
      tensor[p * 4 + 3] = plain * plain;
      mismatch[p * 3] = ix * it;
      mismatch[p * 3 + 1] = iy * it;
      mismatch[p * 3 + 2] = it * it;
    }
  }
}

/**
 * Mean over a (2·radius+1)² window, done as a row pass and a column pass.
 * Pixels beyond the edge repeat the edge.
 *
 * @param {Float32Array} src - `channels` values per pixel
 * @param {number} width
 * @param {number} height
 * @param {number} channels
 * @param {number} radius
 * @param {Float32Array} out - Same shape as src; may not be src
 * @returns {Float32Array} out
 */
export function boxMean(src, width, height, channels, radius, out) {
  const rows = new Float32Array(src.length);
  const share = 1 / (2 * radius + 1);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      for (let c = 0; c < channels; c++) {
        let sum = 0;
        for (let d = -radius; d <= radius; d++) sum += src[(y * width + clampIndex(x + d, width - 1)) * channels + c];
        rows[(y * width + x) * channels + c] = sum * share;
      }
    }
  }
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      for (let c = 0; c < channels; c++) {
        let sum = 0;
        for (let d = -radius; d <= radius; d++) sum += rows[(clampIndex(y + d, height - 1) * width + x) * channels + c];
        out[(y * width + x) * channels + c] = sum * share;
      }
    }
  }
  return out;
}

/**
 * Solve one pixel's system from its window means.
 *
 * @param {Float32Array|number[]} tensor - Window means, 4 values from `t`: Ix², Ix·Iy, Iy², plain difference²
 * @param {number} t
 * @param {Float32Array|number[]} mismatch - Window means, 3 values from `m`: Ix·It, Iy·It, It²
 * @param {number} m
 * @param {number} noise - See FLOW_NOISE
 * @param {number} maxStep - See FLOW_MAX_STEP
 * @param {number} still - See FLOW_STILL
 * @param {number[]|Float32Array} out - Written at `at`: dx, dy, confidence
 * @param {number} at
 */
export function solvePixel(tensor, t, mismatch, m, noise, maxStep, still, out, at) {
  const jxx = tensor[t];
  const jxy = tensor[t + 1];
  const jyy = tensor[t + 2];
  const plain = tensor[t + 3];
  const bx = mismatch[m];
  const by = mismatch[m + 1];
  const tt = mismatch[m + 2];
  const a = jxx + noise;
  const c = jyy + noise;
  const det = a * c - jxy * jxy; // > 0 for any noise > 0
  let dx = -(c * bx - jxy * by) / det;
  let dy = -(a * by - jxy * bx) / det;
  const length = Math.sqrt(dx * dx + dy * dy);
  if (length > maxStep) {
    dx *= maxStep / length;
    dy *= maxStep / length;
  }
  // Mean of (It + Ix·dx + Iy·dy)²: the change the shift does not account for.
  const residual = Math.max(0, tt + 2 * (dx * bx + dy * by) + jxx * dx * dx + 2 * jxy * dx * dy + jyy * dy * dy);
  const misfit = residual / ((jxx + jyy) * 0.5 + noise);
  const half = (jxx - jyy) * 0.5;
  const texture = Math.max(0, (jxx + jyy) * 0.5 - Math.sqrt(half * half + jxy * jxy));
  out[at] = dx;
  out[at + 1] = dy;
  // The share of the plain frame difference that the whole shift (guess and all) explains.
  const explained = plain > 0 ? 1 - residual / plain : 0;
  const moved = still > 0 ? Math.min(1, Math.max(0, (explained - still * 0.25) / (still * 0.75))) : 1;
  out[at + 2] = texture * Math.max(0, 1 - misfit / FLOW_MISFIT) * moved;
}

/**
 * The flow at one size, from the window means of flowProducts.
 *
 * @param {Float32Array} tensor - 4 per pixel, window means
 * @param {Float32Array} mismatch - 3 per pixel, window means
 * @param {Float32Array|null} guess - 3 per pixel: the shift the older frame was already warped by
 * @param {number} count - Pixels
 * @param {Float32Array} out - 3 per pixel: dx, dy, confidence
 * @param {{noise?: number, maxStep?: number, still?: number}} [options]
 * @returns {Float32Array} out
 */
export function flowSolve(tensor, mismatch, guess, count, out, options = {}) {
  const noise = options.noise ?? FLOW_NOISE;
  const maxStep = options.maxStep ?? FLOW_MAX_STEP;
  const still = options.still ?? FLOW_STILL;
  for (let p = 0; p < count; p++) {
    solvePixel(tensor, p * 4, mismatch, p * 3, noise, maxStep, still, out, p * 3);
    if (guess) {
      out[p * 3] += guess[p * 3];
      out[p * 3 + 1] += guess[p * 3 + 1];
    }
  }
  return out;
}

/**
 * One size of the pyramid: warp by the guess (if any), build the system,
 * average it over the window, solve.
 *
 * @param {Float32Array} older
 * @param {Float32Array} current
 * @param {number} width
 * @param {number} height
 * @param {Float32Array|null} guess - 3 per pixel at this size, or null
 * @param {{radius?: number, noise?: number, maxStep?: number, still?: number}} [options]
 * @returns {Float32Array} 3 per pixel: dx, dy, confidence
 */
export function flowLevel(older, current, width, height, guess, options = {}) {
  const count = width * height;
  const radius = options.radius ?? FLOW_RADIUS;
  const from = guess ? warp(older, width, height, guess, new Float32Array(count)) : older;
  const tensor = new Float32Array(count * 4);
  const mismatch = new Float32Array(count * 3);
  flowProducts(from, current, width, height, tensor, mismatch, older);
  const tensorMean = boxMean(tensor, width, height, 4, radius, new Float32Array(count * 4));
  const mismatchMean = boxMean(mismatch, width, height, 3, radius, new Float32Array(count * 3));
  return flowSolve(tensorMean, mismatchMean, guess, count, new Float32Array(count * 3), options);
}

/**
 * Flow between two single-channel images, coarse to fine.
 *
 * @param {Float32Array} older - width*height, luma in levels
 * @param {Float32Array} current
 * @param {number} width
 * @param {number} height
 * @param {{levels?: number, radius?: number, noise?: number, maxStep?: number, still?: number}} [options]
 *   levels: how many sizes, each half the one before (default 3). With 3,
 *   shifts up to about 2·FLOW_MAX_STEP·2² pixels are in reach.
 * @returns {Float32Array} 3 per pixel at full size: dx, dy (pixels, older → current), confidence
 */
export function pyramidFlow(older, current, width, height, options = {}) {
  const levels = Math.max(1, options.levels ?? 3);
  const sizes = [{ width, height, older, current }];
  for (let l = 1; l < levels; l++) {
    const above = sizes[l - 1];
    const w = reducedSize(above.width, 2);
    const h = reducedSize(above.height, 2);
    sizes.push({
      width: w,
      height: h,
      older: halve(above.older, above.width, above.height, new Float32Array(w * h)),
      current: halve(above.current, above.width, above.height, new Float32Array(w * h)),
    });
  }
  let flow = null;
  for (let l = levels - 1; l >= 0; l--) {
    const size = sizes[l];
    let guess = null;
    if (flow) {
      const coarse = sizes[l + 1];
      guess = upsampleFlow(flow, coarse.width, coarse.height, size.width, size.height, new Float32Array(size.width * size.height * 3));
    }
    flow = flowLevel(size.older, size.current, size.width, size.height, guess, options);
  }
  return flow;
}

/**
 * Blend a new flow field into a running one, so a field read by something
 * slow (particles) does not jump about. Each new vector counts in proportion
 * to its confidence. The state is a weighted sum and the sum of the weights,
 * so the average it yields (smoothedVector) is not dragged towards zero by
 * unsure measurements: they simply count for less.
 *
 * @param {Float32Array} previous - 3 per pixel: running sums of weight·dx, weight·dy, and of the weight
 * @param {Float32Array} measured - 3 per pixel: dx, dy, confidence
 * @param {number} alpha - Weight of the new field, 0..1 (1 = no smoothing)
 * @param {number} trusted - Confidence at and above which a vector counts fully
 * @param {Float32Array} out - 3 per pixel, as `previous`; may be `previous`
 * @returns {Float32Array} out
 */
export function smoothFlow(previous, measured, alpha, trusted, out) {
  for (let i = 0; i < out.length; i += 3) {
    const weight = Math.min(1, measured[i + 2] / trusted);
    out[i] = previous[i] + (measured[i] * weight - previous[i]) * alpha;
    out[i + 1] = previous[i + 1] + (measured[i + 1] * weight - previous[i + 1]) * alpha;
    out[i + 2] = previous[i + 2] + (weight - previous[i + 2]) * alpha;
  }
  return out;
}

/**
 * The averaged vector at one pixel of smoothFlow's state, and how present a
 * measurement is there (0..1: the running share of frames that had one).
 * Below `floor` the place counts as not measured and the vector is zero.
 *
 * @param {Float32Array} state - From smoothFlow
 * @param {number} i - Offset of the pixel (3 per pixel)
 * @param {number} floor
 * @param {number[]|Float32Array} out - Written: dx, dy, presence
 * @returns {number[]|Float32Array} out
 */
export function smoothedVector(state, i, floor, out) {
  const presence = state[i + 2];
  const known = presence >= floor && presence > 0;
  out[0] = known ? state[i] / presence : 0;
  out[1] = known ? state[i + 1] / presence : 0;
  out[2] = presence;
  return out;
}

/**
 * The typical shift of the whole picture: the confidence-weighted median of
 * each component over a coarse sampling of the field. A camera that moved
 * shifts everything by about this much; subtracting it leaves what moved
 * within the picture.
 *
 * @param {Float32Array} flow - 3 per pixel
 * @param {number} count - Pixels
 * @param {number} trusted - Only vectors with at least this confidence count
 * @param {number} [stride] - Use every stride-th pixel
 * @returns {{dx: number, dy: number, share: number}} share: how much of the
 *   sampled field was trusted
 */
export function globalShift(flow, count, trusted, stride = 1) {
  const xs = [];
  const ys = [];
  let sampled = 0;
  for (let p = 0; p < count; p += stride) {
    sampled++;
    if (flow[p * 3 + 2] >= trusted) {
      xs.push(flow[p * 3]);
      ys.push(flow[p * 3 + 1]);
    }
  }
  if (!xs.length) return { dx: 0, dy: 0, share: 0 };
  const median = (values) => {
    values.sort((a, b) => a - b);
    const mid = values.length >> 1;
    return values.length % 2 ? values[mid] : (values[mid - 1] + values[mid]) / 2;
  };
  return { dx: median(xs), dy: median(ys), share: xs.length / sampled };
}
