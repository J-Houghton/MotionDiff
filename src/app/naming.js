// @ts-check
/**
 * Naming what is tracked (docs/naming-poc.md): a small classifier looks at
 * crops of the ORIGINAL frame under each tracked box, a few times a second,
 * beside the pipeline — nothing in the measurement or render path waits on
 * it. Tracking carries the label: each box id votes over its last few
 * classifications and keeps the winner while it lives.
 *
 * This module is imported dynamically the first time "Name the movers" is
 * switched on. The runtime (ONNX Runtime Web, MIT) and the model
 * (MobileNetV2 int8, Apache-2.0) load from their homes at pinned versions
 * only then; neither is in the repository or the bundle.
 */
import { IMAGENET_LABELS } from './imagenet-labels.js';

const ORT_VERSION = '1.22.0';
const ORT_BASE = `https://cdn.jsdelivr.net/npm/onnxruntime-web@${ORT_VERSION}/dist/`;
const MODEL_URL = 'https://huggingface.co/onnxmodelzoo/mobilenetv2-12-int8/resolve/main/mobilenetv2-12-int8.onnx';

/** Classifier input side. */
const SIDE = 224;
/** How often a round of crops is classified, ms. */
const EVERY_MS = 400;
/** Largest boxes classified per round. */
const PER_ROUND = 4;
/** Votes kept per id, and how many a label needs to settle. */
const VOTES = 5;
const SETTLE = 2;
/** Top-1 softmax score below which a classification casts no vote. */
const SCORE_FLOOR = 0.12;
/** ImageNet normalisation. */
const MEAN = [0.485, 0.456, 0.406];
const STD = [0.229, 0.224, 0.225];

/**
 * Load the runtime and the model. Throws with a plain message when either
 * cannot be fetched; the caller turns the option back off.
 */
export async function createNamer() {
  const ort = await import(/* @vite-ignore */ `${ORT_BASE}ort.min.mjs`);
  ort.env.wasm.wasmPaths = ORT_BASE;
  const model = await fetch(MODEL_URL);
  if (!model.ok) throw new Error(`model fetch failed (${model.status})`);
  const session = await ort.InferenceSession.create(await model.arrayBuffer(), {
    executionProviders: ['wasm'],
  });

  const canvas = document.createElement('canvas');
  canvas.width = SIDE;
  canvas.height = SIDE;
  const ctx = /** @type {CanvasRenderingContext2D} */ (canvas.getContext('2d', { willReadFrequently: true }));
  const input = new Float32Array(3 * SIDE * SIDE);

  /** @type {Map<number, {votes: string[], scores: number[], label: string|null, share: number}>} */
  const names = new Map();
  let lastRound = 0;
  let busy = false;

  /** @param {number} id */
  function record(id, label, score) {
    let entry = names.get(id);
    if (!entry) names.set(id, (entry = { votes: [], scores: [], label: null, share: 0 }));
    entry.votes.push(label);
    entry.scores.push(score);
    if (entry.votes.length > VOTES) { entry.votes.shift(); entry.scores.shift(); }
    /** @type {Record<string, number>} */
    const tally = {};
    for (const vote of entry.votes) tally[vote] = (tally[vote] || 0) + 1;
    const [best, count] = Object.entries(tally).sort((a, b) => b[1] - a[1])[0];
    if (count >= SETTLE) {
      entry.label = best;
      entry.share = count / entry.votes.length;
    }
  }

  /** One crop → top-1 label and score. */
  async function classify(video, sx, sy, sw, sh) {
    // A square of REAL frame context around the box, no artificial borders:
    // grey letterboxing read as the bezel of a television or microwave in
    // the first blind run — the classifier names what it sees.
    const vw = video.videoWidth;
    const vh = video.videoHeight;
    let side = Math.min(Math.max(sw, sh) * 1.2, vw, vh);
    let left = Math.min(Math.max(sx + sw / 2 - side / 2, 0), vw - side);
    let top = Math.min(Math.max(sy + sh / 2 - side / 2, 0), vh - side);
    ctx.drawImage(video, left, top, side, side, 0, 0, SIDE, SIDE);
    const pixels = ctx.getImageData(0, 0, SIDE, SIDE).data;
    const plane = SIDE * SIDE;
    for (let p = 0; p < plane; p++) {
      input[p] = (pixels[p * 4] / 255 - MEAN[0]) / STD[0];
      input[plane + p] = (pixels[p * 4 + 1] / 255 - MEAN[1]) / STD[1];
      input[2 * plane + p] = (pixels[p * 4 + 2] / 255 - MEAN[2]) / STD[2];
    }
    const ortModule = ort;
    const feeds = { [session.inputNames[0]]: new ortModule.Tensor('float32', input, [1, 3, SIDE, SIDE]) };
    const results = await session.run(feeds);
    const logits = /** @type {Float32Array} */ (results[session.outputNames[0]].data);
    let bestIndex = 0;
    for (let i = 1; i < logits.length; i++) if (logits[i] > logits[bestIndex]) bestIndex = i;
    // Softmax of the winner only: exp-normalised against the whole row.
    let sum = 0;
    const max = logits[bestIndex];
    for (let i = 0; i < logits.length; i++) sum += Math.exp(logits[i] - max);
    return { label: IMAGENET_LABELS[bestIndex] ?? String(bestIndex), score: 1 / sum };
  }

  return {
    /**
     * Called per processed frame; classifies a round of crops at most every
     * EVERY_MS, fire-and-forget. Boxes are picture coordinates.
     * @param {HTMLVideoElement} video
     * @param {{id: number, x: number, y: number, w: number, h: number}[]} objects
     * @param {number} pictureWidth @param {number} pictureHeight
     */
    tick(video, objects, pictureWidth, pictureHeight) {
      const now = performance.now();
      if (busy || now - lastRound < EVERY_MS) return;
      const vw = video.videoWidth;
      const vh = video.videoHeight;
      if (!vw || !vh || !pictureWidth || !pictureHeight) return;
      lastRound = now;
      busy = true;
      const round = [...objects]
        .sort((a, b) => b.w * b.h - a.w * a.h)
        .slice(0, PER_ROUND);
      (async () => {
        for (const o of round) {
          const sx = (o.x / pictureWidth) * vw;
          const sy = (o.y / pictureHeight) * vh;
          const sw = (o.w / pictureWidth) * vw;
          const sh = (o.h / pictureHeight) * vh;
          if (sw < 8 || sh < 8) continue;
          const top = await classify(video, sx, sy, sw, sh);
          if (top.score >= SCORE_FLOOR) record(o.id, top.label, top.score);
        }
        // Forget ids the tracker no longer publishes.
        const alive = new Set(objects.map((o) => o.id));
        for (const id of names.keys()) if (!alive.has(id)) names.delete(id);
      })().catch(() => {}).finally(() => { busy = false; });
    },

    /** The settled name for a track id, or null. */
    labelFor(id) {
      const entry = names.get(id);
      return entry && entry.label ? { label: entry.label, share: entry.share } : null;
    },

    clear() { names.clear(); },
  };
}
