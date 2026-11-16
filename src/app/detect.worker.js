// @ts-check
/**
 * The detector's worker (docs/naming-poc.md): loads Transformers.js and
 * RT-DETR v2 from their homes at pinned versions — nothing here is in the
 * repository or the bundle — and answers one frame at a time. The main
 * thread never waits on it; a result carries the stamp of the frame it
 * looked at, because it arrives late by one inference.
 *
 * Messages in:  {type: 'load', device: string, dtype: string, fault?: 'load'|'prove'|'look'|null}
 *               {type: 'frame', bitmap: ImageBitmap, time: number}
 * Messages out: {type: 'ready', loadMs: number}
 *               {type: 'result', time: number, inferMs: number, width: number,
 *                height: number, detections: {label, score, x, y, w, h}[]}
 *               {type: 'error', stage: 'load'|'prove'|'look', message: string}
 */

// 4.x, where the depth worker stays on 3.8.1: the 3.x WebGPU backend cannot
// run this model's ceil-mode AveragePool, the 4.x one can (verdicts L-1,
// M-1 again). 4.x fetches its onnxruntime-web build from jsDelivr itself.
const TRANSFORMERS_URL = 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@4.3.2';
const MODEL_ID = 'onnx-community/rtdetr_v2_r18vd-ONNX';
/** Detections under this score are not worth a disagreement. */
const SCORE_FLOOR = 0.45;
/** The throwaway picture a rung proves itself on: small, 16:9 like most
 * footage; the model's own preprocessing resizes it like any frame. */
const PROOF_WIDTH = 64;
const PROOF_HEIGHT = 36;

let detector = null;
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
 * The ladder lives on the main thread (app/modelladder.js) and gives EVERY
 * rung a fresh worker: a crash out of the runtime leaves this wasm
 * instance poisoned, so retrying in the same worker fails at the same
 * spot whatever the backend — seen in the wild as three rungs dying with
 * one identical number.
 */
async function load(device, dtype, fault) {
  const t0 = performance.now();
  if (fault === 'load') throw new Error('injected fault (?modelfault): load');
  const T = await import(/* @vite-ignore */ TRANSFORMERS_URL);
  T.env.allowLocalModels = false;
  detector = await T.pipeline('object-detection', MODEL_ID, { device, dtype });
  // Prove a look before saying ready (docs/model-ladder.md): a backend can
  // build its session and still be unable to run the model, and only a
  // run finds that out. One throwaway inference on a small grey picture.
  try {
    if (fault === 'prove') throw new Error('injected fault (?modelfault): first look');
    const grey = new Uint8ClampedArray(PROOF_WIDTH * PROOF_HEIGHT * 4).fill(128);
    await detector(new T.RawImage(grey, PROOF_WIDTH, PROOF_HEIGHT, 4), { threshold: SCORE_FLOOR });
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
  const found = await detector(image, { threshold: SCORE_FLOOR });
  const inferMs = Math.round(performance.now() - t0);
  const detections = found.map((d) => ({
    label: d.label,
    score: +d.score.toFixed(3),
    x: d.box.xmin,
    y: d.box.ymin,
    w: d.box.xmax - d.box.xmin,
    h: d.box.ymax - d.box.ymin,
  }));
  postMessage({ type: 'result', time, inferMs, width, height, detections });
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
