// @ts-check
/**
 * The detector's worker (docs/naming-poc.md): loads Transformers.js and
 * RT-DETR v2 from their homes at pinned versions — nothing here is in the
 * repository or the bundle — and answers one frame at a time. The main
 * thread never waits on it; a result carries the stamp of the frame it
 * looked at, because it arrives late by one inference.
 *
 * Messages in:  {type: 'load', dtype?: string}
 *               {type: 'frame', bitmap: ImageBitmap, time: number}
 * Messages out: {type: 'ready', backend: string, dtype: string, loadMs: number}
 *               {type: 'result', time: number, inferMs: number, width: number,
 *                height: number, detections: {label, score, x, y, w, h}[]}
 *               {type: 'error', message: string}
 */

const TRANSFORMERS_URL = 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.8.1';
const MODEL_ID = 'onnx-community/rtdetr_v2_r18vd-ONNX';
/** Detections under this score are not worth a disagreement. */
const SCORE_FLOOR = 0.45;

let detector = null;
let canvas = null;
let busy = false;

async function load(dtypeOverride) {
  const t0 = performance.now();
  const T = await import(/* @vite-ignore */ TRANSFORMERS_URL);
  T.env.allowLocalModels = false;
  // WebGPU where the browser has it; wasm everywhere else (phones, this
  // project's software-GL sandbox). fp16 is the usual WebGPU choice for
  // this model; q8 keeps the wasm download at 21 MB.
  const adapter = navigator.gpu ? await navigator.gpu.requestAdapter().catch(() => null) : null;
  const backend = adapter ? 'webgpu' : 'wasm';
  const dtype = dtypeOverride || (backend === 'webgpu' ? 'fp16' : 'q8');
  detector = await T.pipeline('object-detection', MODEL_ID, { device: backend, dtype });
  postMessage({ type: 'ready', backend, dtype, loadMs: Math.round(performance.now() - t0) });
}

async function look(bitmap, time) {
  const { width, height } = bitmap;
  if (!canvas || canvas.width !== width || canvas.height !== height) {
    canvas = new OffscreenCanvas(width, height);
  }
  const ctx = /** @type {OffscreenCanvasRenderingContext2D} */ (canvas.getContext('2d', { willReadFrequently: true }));
  ctx.drawImage(bitmap, 0, 0);
  bitmap.close();
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
  const work = message.type === 'load' ? load(message.dtype) : look(message.bitmap, message.time);
  work
    .catch((error) => postMessage({ type: 'error', message: String(error?.message || error) }))
    .finally(() => { busy = false; });
};
