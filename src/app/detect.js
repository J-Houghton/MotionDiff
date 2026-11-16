// @ts-check
/**
 * Naming by a detector (docs/naming-poc.md): the main-thread side. Owns the
 * worker, throttles to one request in flight, snapshots the tracker's boxes
 * with each frame it sends, and matches the late answer against that
 * snapshot — never against "the current frame". Tracking then carries each
 * label while its id lives.
 *
 * Everything here is an estimate and says so: labels wear ≈, model-only
 * finds carry the age of the look that saw them.
 *
 * Imported dynamically the first time "Name the movers" is switched on;
 * the worker fetches runtime and model from their homes only then.
 */
import { matchBoxes } from '../core/boxmatch.js';

/** Longest frame side sent to the model (the capture is scaled down). */
const SEND_WIDTH = 960;
/** A look starts no more often than this, however fast the model answers. */
const EVERY_MS = 250;
/** Votes kept per id. One look is enough to name a track — on a slow
 * backend a short-lived id may only ever be seen once — and later looks
 * vote the name steady by majority. */
const VOTES = 5;
/** Inference times kept for the readings' median. */
const TIMES = 9;

/**
 * Start the worker and load the model. Resolves when the model is ready;
 * rejects with a plain message when it cannot be fetched (the caller turns
 * the option back off).
 * @param {{onStatus?: (message: string, type: string) => void}} [options]
 */
export function createDetector(options = {}) {
  /** @type {Worker|null} Set once a ladder rung loads the model. */
  let worker = null;

  /** @type {Map<number, {votes: string[], label: string|null, share: number, outcome: 'both'|'motion'}>} */
  const names = new Map();
  /** @type {{x: number, y: number, w: number, h: number, label: string, score: number, atMs: number}[]} */
  let modelOnly = [];
  /** @type {{tracks: {id: number, x: number, y: number, w: number, h: number}[], toPicture: number, sentMs: number}|null} */
  let pending = null;
  let lastSendMs = 0;
  const status = { backend: '…', dtype: '', loadMs: 0, lastInferMs: 0, inferTimes: /** @type {number[]} */ ([]), looks: /** @type {number[]} */ ([]) };

  /** @param {number} id @param {string} label */
  function vote(id, label) {
    let entry = names.get(id);
    if (!entry) names.set(id, (entry = { votes: [], label: null, share: 0, outcome: 'both' }));
    entry.votes.push(label);
    if (entry.votes.length > VOTES) entry.votes.shift();
    /** @type {Record<string, number>} */
    const tally = {};
    for (const v of entry.votes) tally[v] = (tally[v] || 0) + 1;
    const [best, count] = Object.entries(tally).sort((a, b) => b[1] - a[1])[0];
    entry.label = best;
    entry.share = count / entry.votes.length;
    return entry;
  }

  /**
   * @param {{inferMs: number, width: number, height: number,
   *   detections: {label: string, score: number, x: number, y: number, w: number, h: number}[]}} message
   */
  function onResult(message) {
    const snapshot = pending;
    pending = null;
    if (!snapshot) return;
    status.lastInferMs = message.inferMs;
    status.inferTimes.push(message.inferMs);
    if (status.inferTimes.length > TIMES) status.inferTimes.shift();
    const now = performance.now();
    status.looks.push(now);
    while (status.looks.length && now - status.looks[0] > 5000) status.looks.shift();

    const { pairs, trackOnly, detectionOnly } = matchBoxes(snapshot.tracks, message.detections);
    for (const { track, detection } of pairs) vote(track.id, detection.label).outcome = 'both';
    for (const track of trackOnly) {
      const entry = names.get(track.id);
      if (entry) entry.outcome = 'motion';
      else names.set(track.id, { votes: [], label: null, share: 0, outcome: 'motion' });
    }
    // The model's own finds, back in picture pixels, stamped with the look.
    const k = snapshot.toPicture;
    modelOnly = detectionOnly.map((d) => ({
      x: d.x * k, y: d.y * k, w: d.w * k, h: d.h * k,
      label: d.label, score: d.score, atMs: snapshot.sentMs,
    }));
  }

  /** How long one rung may spend downloading and compiling before it is
   * written off as hung (a wedged driver throws nothing at all). */
  const RUNG_MS = 180000;

  /** One rung: a fresh worker, so a crashed runtime cannot poison the next
   * try — a wasm abort leaves its instance failing everywhere after. */
  function attempt(device, dtype) {
    return new Promise((resolve, reject) => {
      const w = new Worker(new URL('./detect.worker.js', import.meta.url), { type: 'module' });
      const timer = setTimeout(() => { w.terminate(); reject(new Error('took too long (hung?)')); }, RUNG_MS);
      w.onmessage = (event) => {
        const message = event.data;
        clearTimeout(timer);
        if (message.type === 'ready') resolve(w);
        else { w.terminate(); reject(new Error(message.message || 'failed')); }
      };
      w.onerror = (event) => { clearTimeout(timer); w.terminate(); reject(new Error(event.message || 'worker failed')); };
      w.postMessage({ type: 'load', device, dtype });
    });
  }

  /** The loaded worker's steady-state messages: looks and their failures. */
  function wire(w) {
    w.onmessage = (event) => {
      const message = event.data;
      if (message.type === 'result') onResult(message);
      else if (message.type === 'error' && pending) {
        pending = null;
        options.onStatus?.(`The detector failed a look: ${message.message}`, 'error');
      }
    };
  }

  const override = new URLSearchParams(location.search).get('detdtype') || undefined;
  const ready = (async () => {
    const t0 = performance.now();
    // WebGPU rungs first where the browser has an adapter; wasm/q8 (21 MB)
    // is the rung that runs anywhere. `?detdtype=` pins the WebGPU rung.
    const adapter = navigator.gpu ? await navigator.gpu.requestAdapter().catch(() => null) : null;
    const ladder = adapter
      ? [...(override ? [['webgpu', override]] : [['webgpu', 'fp16'], ['webgpu', 'fp32']]), ['wasm', 'q8']]
      : [['wasm', override || 'q8']];
    const failures = [];
    for (const [device, dtype] of ladder) {
      try {
        worker = await attempt(device, dtype);
        wire(worker);
        status.backend = device;
        status.dtype = dtype;
        status.loadMs = Math.round(performance.now() - t0);
        // The status line shows where the ladder landed; this says why it
        // stepped down, for whoever is triaging.
        if (failures.length) console.warn('naming model stepped down:', failures.join(' | '));
        return;
      } catch (error) {
        failures.push(`${device}/${dtype}: ${String(error?.message || error)}`);
      }
    }
    throw new Error(`no backend would load the model — ${failures.join('; ')}`);
  })();

  return {
    /** Resolves when the model answered ready; rejects when it cannot load. */
    ready,

    /**
     * Called per processed frame; starts a look at most every EVERY_MS and
     * only while no look is in flight. Boxes are picture coordinates.
     * @param {HTMLVideoElement} video
     * @param {{id: number, x: number, y: number, w: number, h: number}[]} objects
     * @param {number} pictureWidth @param {number} pictureHeight
     */
    tick(video, objects, pictureWidth, pictureHeight) {
      // A label lives as long as its id: forget what the tracker dropped.
      const alive = new Set(objects.map((o) => o.id));
      for (const id of names.keys()) if (!alive.has(id)) names.delete(id);
      const now = performance.now();
      if (!worker || pending || now - lastSendMs < EVERY_MS) return;
      const vw = video.videoWidth;
      const vh = video.videoHeight;
      if (!vw || !vh || !pictureWidth || !pictureHeight) return;
      lastSendMs = now;
      const scale = Math.min(1, SEND_WIDTH / vw);
      const sendW = Math.round(vw * scale);
      const sendH = Math.round(vh * scale);
      // The snapshot: the tracker's boxes as they stand NOW, in sent pixels,
      // so the late answer is matched against what the model actually saw.
      const toSent = sendW / pictureWidth;
      pending = {
        tracks: objects.map((o) => ({ id: o.id, x: o.x * toSent, y: o.y * toSent, w: o.w * toSent, h: o.h * toSent })),
        toPicture: pictureWidth / sendW,
        sentMs: now,
      };
      createImageBitmap(video, { resizeWidth: sendW, resizeHeight: sendH, resizeQuality: 'low' })
        .then((bitmap) => worker.postMessage({ type: 'frame', bitmap, time: video.currentTime }, [bitmap]))
        .catch(() => { pending = null; });
    },

    /** The settled name for a track id, or null. */
    labelFor(id) {
      const entry = names.get(id);
      return entry && entry.label ? { label: entry.label, share: entry.share } : null;
    },

    /** 'both' | 'motion' from the last look that saw this id, or null before one. */
    agreeFor(id) {
      return names.get(id)?.outcome ?? null;
    },

    /** The model-only finds of the last look, picture px, with their age. */
    finds() {
      const now = performance.now();
      return modelOnly.map((f) => ({ ...f, ageMs: now - f.atMs }));
    },

    /** For the readings margin and its copy button. */
    status() {
      const sorted = [...status.inferTimes].sort((a, b) => a - b);
      return {
        backend: status.backend,
        dtype: status.dtype,
        loadMs: status.loadMs,
        lastInferMs: status.lastInferMs,
        medianInferMs: sorted.length ? sorted[Math.floor(sorted.length / 2)] : 0,
        looksPerSecond: +(status.looks.length / 5).toFixed(1),
      };
    },

    clear() {
      names.clear();
      modelOnly = [];
      pending = null;
    },

    dispose() {
      worker?.terminate();
    },
  };
}
