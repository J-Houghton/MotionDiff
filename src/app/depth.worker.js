// @ts-check
/**
 * The depth stage's worker (docs/depth-stage.md): loads Transformers.js
 * and Depth Anything V2 Small from their homes at pinned versions —
 * nothing here is in the repository or the bundle — and answers one frame
 * at a time with a coarse inverse-depth grid. The main thread never waits
 * on it; a result carries the stamp of the frame it looked at.
 *
 * Messages in:  {type: 'load', device: string, dtype: string, fault?: 'load'|'prove'|'look'|null}
 *               {type: 'frame', bitmap: ImageBitmap, time: number}
 * Messages out: {type: 'ready', loadMs: number}
 *               {type: 'result', time: number, inferMs: number, cols, rows,
 *                grid: Float32Array (transferred), min, max, median}
 *               {type: 'error', stage: 'load'|'prove'|'look', message: string}
 */

const TRANSFORMERS_URL = 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.8.1';
// Only the Small checkpoint is Apache-2.0; Base and Large are CC-BY-NC
// and must never be fetched (docs/depth-stage.md).
const MODEL_ID = 'onnx-community/depth-anything-v2-small';
/** The published grid's width in cells. */
const GRID_COLS = 80;
/** The throwaway picture a rung proves itself on: small, 16:9 like most
 * footage; the model's own preprocessing resizes it like any frame. */
const PROOF_WIDTH = 64;
const PROOF_HEIGHT = 36;

let depth = null;
let canvas = null;
let busy = false;
/** `?modelfault=…:look` (docs/model-ladder.md): every real look fails. */
let failLooks = false;

/** A failure out of the runtime can be a bare number (a wasm pointer),
 * not an Error; turn whatever was thrown into words. */
function describe(error) {
  return String(error?.message || error);
}

/**
 * One attempt on one backend: load, then prove one look, then say ready.
 * The ladder lives on the main thread (app/modelladder.js) and gives every
 * rung a fresh worker: a crash out of the runtime leaves this wasm
 * instance poisoned (see detect.worker.js).
 */
async function load(device, dtype, fault) {
  const t0 = performance.now();
  if (fault === 'load') throw new Error('injected fault (?modelfault): load');
  const T = await import(/* @vite-ignore */ TRANSFORMERS_URL);
  T.env.allowLocalModels = false;
  depth = await T.pipeline('depth-estimation', MODEL_ID, { device, dtype });
  // Prove a look before saying ready (docs/model-ladder.md): a backend can
  // build its session and still be unable to run the model, and only a
  // run finds that out. One throwaway inference on a small grey picture.
  try {
    if (fault === 'prove') throw new Error('injected fault (?modelfault): first look');
    const grey = new Uint8ClampedArray(PROOF_WIDTH * PROOF_HEIGHT * 4).fill(128);
    await depth(new T.RawImage(grey, PROOF_WIDTH, PROOF_HEIGHT, 4));
  } catch (error) {
    throw Object.assign(new Error(describe(error)), { stage: 'prove' });
  }
  failLooks = fault === 'look';
  postMessage({ type: 'ready', loadMs: Math.round(performance.now() - t0) });
}

async function look(bitmap, time) {
  const { width, height } = bitmap;
  if (!canvas || canvas.width !== width || canvas.height !== height) {
    canvas = new OffscreenCanvas(width, height);
  }
  const ctx = /** @type {OffscreenCanvasRenderingContext2D} */ (canvas.getContext('2d', { willReadFrequently: true }));
  ctx.drawImage(bitmap, 0, 0);
  bitmap.close();
  if (failLooks) throw new Error('injected fault (?modelfault): look');
  const pixels = ctx.getImageData(0, 0, width, height);
  const T = await import(/* @vite-ignore */ TRANSFORMERS_URL);
  const image = new T.RawImage(pixels.data, width, height, 4);
  const t0 = performance.now();
  const out = await depth(image);
  const inferMs = Math.round(performance.now() - t0);

  // Pool the model's map (input-sized) to the coarse grid by box mean.
  const tensor = out.predicted_depth;
  const [h, w] = tensor.dims.slice(-2);
  const data = tensor.data;
  const cols = GRID_COLS;
  const rows = Math.max(1, Math.round((cols * h) / w));
  const grid = new Float32Array(cols * rows);
  let min = Infinity;
  let max = -Infinity;
  for (let gy = 0; gy < rows; gy++) {
    const y0 = Math.floor((gy * h) / rows);
    const y1 = Math.max(y0 + 1, Math.floor(((gy + 1) * h) / rows));
    for (let gx = 0; gx < cols; gx++) {
      const x0 = Math.floor((gx * w) / cols);
      const x1 = Math.max(x0 + 1, Math.floor(((gx + 1) * w) / cols));
      let sum = 0;
      for (let y = y0; y < y1; y++) {
        for (let x = x0; x < x1; x++) sum += data[y * w + x];
      }
      const value = sum / ((y1 - y0) * (x1 - x0));
      grid[gy * cols + gx] = value;
      if (value < min) min = value;
      if (value > max) max = value;
    }
  }
  const sorted = Float32Array.from(grid).sort();
  const median = sorted[Math.floor(sorted.length / 2)];
  // The checker only knows the window's postMessage; this is the worker's,
  // and the second argument is its transfer list.
  postMessage({ type: 'result', time, inferMs, cols, rows, grid, min, max, median }, /** @type {*} */ ([grid.buffer]));
}

onmessage = (event) => {
  const message = event.data;
  if (busy) return; // One request at a time is enforced by the sender; this is the backstop.
  busy = true;
  const loading = message.type === 'load';
  const work = loading ? load(message.device, message.dtype, message.fault) : look(message.bitmap, message.time);
  work
    .catch((error) => postMessage({ type: 'error', stage: error?.stage || (loading ? 'load' : 'look'), message: describe(error) }))
    .finally(() => { busy = false; });
};

// Only dynamic imports above, so this marks the worker a module for the
// checker: without it, the two worker files share one global scope there.
export {};
