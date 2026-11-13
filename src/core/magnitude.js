/**
 * Shared motion magnitude.
 *
 * Every mode reduces its result to the same thing: one unsigned number per
 * pixel, 0 (no motion) to 1 (as much as the mode can express). Whatever
 * wants to know "how much motion, where" — the sonification grid today,
 * other consumers later — works from that buffer and never from a mode's own
 * output, so it needs no knowledge of Posy baselines, signs or colour.
 *
 * The magnitude must be taken per pixel BEFORE any spatial averaging. A
 * moving edge leaves a positive band where it arrives and a negative band
 * where it left; averaging the signed values first cancels them to nothing.
 *
 * A mode contributes one function here that fills a magnitude buffer
 * (`diffMagnitude`, `bandMagnitude`, …) and a GLSL mirror in
 * app/renderer.webgl.js. `poolMagnitude` is shared by all of them.
 *
 * Pure functions only — this module imports nothing (core layer rule).
 */

/** Posy "no motion" value. Raw mode's baseline is 0. */
const POSY_BASELINE = 128;
/** Largest deviation Posy space normalizes against (matches core/energy.js). */
const POSY_RANGE = 127;
const RAW_RANGE = 255;

// Rec.709 luma weights — must match core/magnify.js and the shaders.
const LUMA_R = 0.2126;
const LUMA_G = 0.7152;
const LUMA_B = 0.0722;

/**
 * Magnitude of a Posy or Raw diff frame: the mean deviation of the three
 * channels from the mode's baseline, normalized to 0..1. This is the same
 * `mag` posyBlend/rawDiff threshold on, so suppressed pixels come out as 0.
 *
 * @param {Uint8ClampedArray|Uint8Array} data - RGBA diff pixels
 * @param {boolean} isPosy - Posy space (baseline 128) vs Raw space (baseline 0)
 * @param {Float32Array} out - One value per pixel (data.length / 4)
 * @returns {Float32Array} out
 */
export function diffMagnitude(data, isPosy, out) {
  const baseline = isPosy ? POSY_BASELINE : 0;
  const scale = 1 / (3 * (isPosy ? POSY_RANGE : RAW_RANGE));
  const count = Math.min(out.length, data.length >> 2);
  for (let p = 0, i = 0; p < count; p++, i += 4) {
    const m = (
      Math.abs(data[i] - baseline) +
      Math.abs(data[i + 1] - baseline) +
      Math.abs(data[i + 2] - baseline)
    ) * scale;
    out[p] = m > 1 ? 1 : m;
  }
  return out;
}

/**
 * Magnitude of a magnification band: how strongly each pixel's brightness
 * is being pushed, |amp · luma(fast − slow)|, clamped to 0..1.
 *
 * @param {Float32Array} fast - Fast EMA state, RGBA layout, 0..1
 * @param {Float32Array} slow - Slow EMA state, same layout
 * @param {number} amp - Amplification factor
 * @param {Float32Array} out - One value per pixel (fast.length / 4)
 * @returns {Float32Array} out
 */
export function bandMagnitude(fast, slow, amp, out) {
  const count = Math.min(out.length, fast.length >> 2);
  for (let p = 0, i = 0; p < count; p++, i += 4) {
    const luma =
      LUMA_R * (fast[i] - slow[i]) +
      LUMA_G * (fast[i + 1] - slow[i + 1]) +
      LUMA_B * (fast[i + 2] - slow[i + 2]);
    const m = Math.abs(amp * luma);
    out[p] = m > 1 ? 1 : m;
  }
  return out;
}

function gridDim(value) {
  const n = Math.floor(Number(value));
  return Number.isFinite(n) && n > 0 ? n : 1;
}

/**
 * Mean magnitude per grid cell. The grid is row-major, row 0 being the top
 * row of the image.
 *
 * Cells are `floor(width / cols)` by `floor(height / rows)` pixels; the last
 * column and last row absorb any remainder pixels so the whole frame is
 * covered. A grid finer than the frame leaves cells with no pixels at 0.
 *
 * @param {Float32Array} magnitude - width*height values in 0..1, row-major
 * @param {number} width
 * @param {number} height
 * @param {number} cols
 * @param {number} rows
 * @param {Float32Array} [out] - cols*rows, reused when the size matches
 * @returns {Float32Array} cols*rows means in 0..1, row-major
 */
export function poolMagnitude(magnitude, width, height, cols, rows, out) {
  const nCols = gridDim(cols);
  const nRows = gridDim(rows);
  const grid = out && out.length === nCols * nRows ? out : new Float32Array(nCols * nRows);
  grid.fill(0);

  const w = Math.floor(Number(width));
  const h = Math.floor(Number(height));
  if (!magnitude || !Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0) return grid;

  const cellW = Math.floor(w / nCols);
  const cellH = Math.floor(h / nRows);

  for (let r = 0; r < nRows; r++) {
    const y0 = Math.min(r * cellH, h);
    const y1 = r === nRows - 1 ? h : Math.min(y0 + cellH, h);

    for (let c = 0; c < nCols; c++) {
      const x0 = Math.min(c * cellW, w);
      const x1 = c === nCols - 1 ? w : Math.min(x0 + cellW, w);

      let sum = 0;
      for (let y = y0; y < y1; y++) {
        const row = y * w;
        for (let x = x0; x < x1; x++) sum += magnitude[row + x];
      }

      const count = (x1 - x0) * (y1 - y0);
      grid[r * nCols + c] = count <= 0 ? 0 : Math.min(1, sum / count);
    }
  }

  return grid;
}
