// @ts-check
/**
 * Depth as a stage (docs/depth-stage.md): the main-thread side. Owns the
 * worker, throttles to one request in flight, stamps each frame it sends
 * with its media time, and keeps the latest answer for the pipeline to
 * serve as `frame.stages.depth()` — always late, and saying by how much.
 *
 * Imported dynamically the first time "Depth the scene" is switched on;
 * the worker fetches runtime and model from their homes only then.
 */

/** Longest frame side sent to the model (its own working size is 518). */
const SEND_WIDTH = 518;
/** A look starts no more often than this, however fast the model answers. */
const EVERY_MS = 400;
/** Inference times kept for the readings' median. */
const TIMES = 9;

/**
 * Start the worker and load the model. `ready` resolves when the model
 * answered; it rejects with a plain message when it cannot be fetched
 * (the caller turns the option back off).
 * @param {{onStatus?: (message: string, type: string) => void}} [options]
 */
export function createDepthStage(options = {}) {
  /** @type {Worker|null} Set once a ladder rung loads the model. */
  let worker = null;

  /** @type {{grid: Float32Array, cols: number, rows: number, min: number, max: number, median: number, time: number}|null} */
  let latest = null;
  let inFlight = false;
  let lastSendMs = 0;
  const status = { backend: '…', dtype: '', loadMs: 0, lastInferMs: 0, inferTimes: /** @type {number[]} */ ([]), looks: /** @type {number[]} */ ([]) };

  /** How long one rung may spend downloading and compiling before it is
   * written off as hung (a wedged driver throws nothing at all). */
  const RUNG_MS = 180000;

  /** One rung: a fresh worker, so a crashed runtime cannot poison the next
   * try — a wasm abort leaves its instance failing everywhere after. */
  function attempt(device, dtype) {
    return new Promise((resolve, reject) => {
      const w = new Worker(new URL('./depth.worker.js', import.meta.url), { type: 'module' });
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
      if (message.type === 'result') {
        inFlight = false;
        status.lastInferMs = message.inferMs;
        status.inferTimes.push(message.inferMs);
        if (status.inferTimes.length > TIMES) status.inferTimes.shift();
        const now = performance.now();
        status.looks.push(now);
        while (status.looks.length && now - status.looks[0] > 5000) status.looks.shift();
        latest = {
          grid: message.grid, cols: message.cols, rows: message.rows,
          min: message.min, max: message.max, median: message.median,
          time: message.time,
        };
      } else if (message.type === 'error' && inFlight) {
        inFlight = false;
        options.onStatus?.(`The depth model failed a look: ${message.message}`, 'error');
      }
    };
  }

  const ready = (async () => {
    const t0 = performance.now();
    const adapter = navigator.gpu ? await navigator.gpu.requestAdapter().catch(() => null) : null;
    const ladder = adapter
      ? [['webgpu', 'fp16'], ['webgpu', 'fp32'], ['wasm', 'q8']]
      : [['wasm', 'q8']];
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
        if (failures.length) console.warn('depth model stepped down:', failures.join(' | '));
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
     * only while no look is in flight.
     * @param {HTMLVideoElement} video
     * @param {number} time - The frame's media time (the stamp the answer carries)
     */
    tick(video, time) {
      const now = performance.now();
      if (!worker || inFlight || now - lastSendMs < EVERY_MS) return;
      const vw = video.videoWidth;
      const vh = video.videoHeight;
      if (!vw || !vh) return;
      lastSendMs = now;
      inFlight = true;
      const scale = Math.min(1, SEND_WIDTH / vw);
      createImageBitmap(video, { resizeWidth: Math.round(vw * scale), resizeHeight: Math.round(vh * scale), resizeQuality: 'low' })
        .then((bitmap) => worker.postMessage({ type: 'frame', bitmap, time }, [bitmap]))
        .catch(() => { inFlight = false; });
    },

    /** The latest map, or null before the first answer. */
    latest() { return latest; },

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

    clear() { latest = null; },

    dispose() { worker?.terminate(); },
  };
}
