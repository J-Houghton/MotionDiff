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
  const worker = new Worker(new URL('./depth.worker.js', import.meta.url), { type: 'module' });

  /** @type {{grid: Float32Array, cols: number, rows: number, min: number, max: number, median: number, time: number}|null} */
  let latest = null;
  let inFlight = false;
  let lastSendMs = 0;
  const status = { backend: '…', dtype: '', loadMs: 0, lastInferMs: 0, inferTimes: /** @type {number[]} */ ([]), looks: /** @type {number[]} */ ([]) };

  const ready = new Promise((resolve, reject) => {
    worker.onmessage = (event) => {
      const message = event.data;
      if (message.type === 'ready') {
        status.backend = message.backend;
        status.dtype = message.dtype;
        status.loadMs = message.loadMs;
        // The worker stepped down a backend or two; the status line shows
        // where it landed, this says why for whoever is triaging.
        if (message.failures?.length) console.warn('depth model stepped down:', message.failures.join(' | '));
        resolve(undefined);
      } else if (message.type === 'result') {
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
      } else if (message.type === 'error') {
        if (inFlight) { inFlight = false; options.onStatus?.(`The depth model failed a look: ${message.message}`, 'error'); }
        else reject(new Error(message.message));
      }
    };
    worker.onerror = (event) => reject(new Error(event.message || 'worker failed'));
  });
  worker.postMessage({ type: 'load' });

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
      if (inFlight || now - lastSendMs < EVERY_MS) return;
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

    dispose() { worker.terminate(); },
  };
}
