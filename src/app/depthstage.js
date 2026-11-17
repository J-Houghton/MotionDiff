// @ts-check
/**
 * Depth as a stage (records/design/depth-stage.md): the main-thread side. Owns the
 * worker, throttles to one request in flight, stamps each frame it sends
 * with its media time, and keeps the latest answer for the pipeline to
 * serve as `frame.stages.depth()` — always late, and saying by how much.
 *
 * Imported dynamically the first time "Depth the scene" is switched on;
 * the worker fetches runtime and model from their homes only then.
 */
import { createModelLadder } from './modelladder.js';

/** Longest frame side sent to the model (its own working size is 518). */
const SEND_WIDTH = 518;
/** A look starts no more often than this, however fast the model answers. */
const EVERY_MS = 400;
/** Inference times kept for the readings' median. */
const TIMES = 9;

/**
 * Start the worker and load the model. `ready` resolves when a backend
 * has proved a look; it rejects with a plain message when none can (the
 * caller turns the option back off). `onLost` is called when the ladder
 * runs out later, after it had been ready.
 * @param {{onStatus?: (message: string, type: string) => void, onLost?: (message: string) => void}} [options]
 */
export function createDepthStage(options = {}) {
  /** @type {{grid: Float32Array, cols: number, rows: number, min: number, max: number, median: number, time: number}|null} */
  let latest = null;
  let inFlight = false;
  let lastSendMs = 0;
  const status = { lastInferMs: 0, inferTimes: /** @type {number[]} */ ([]), looks: /** @type {number[]} */ ([]) };

  /** A look came back: keep its numbers and its map. */
  function onResult(message) {
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
  }

  // The backend ladder (records/design/model-ladder.md): a rung is ready only once
  // it has proved a look, and a look that fails later steps down once.
  const ladder = createModelLadder({
    spawn: () => new Worker(new URL('./depth.worker.js', import.meta.url), { type: 'module' }),
    noun: 'Depth',
    model: 'depth model',
    onResult,
    onLookFailed: () => { inFlight = false; },
    onStatus: options.onStatus,
    onLost: options.onLost,
  });

  return {
    /** Resolves when a backend has proved a look; rejects when none can. */
    ready: ladder.ready,

    /**
     * Called per processed frame; starts a look at most every EVERY_MS and
     * only while no look is in flight.
     * @param {HTMLVideoElement} video
     * @param {number} time - The frame's media time (the stamp the answer carries)
     */
    tick(video, time) {
      const now = performance.now();
      if (!ladder.live() || inFlight || now - lastSendMs < EVERY_MS) return;
      const vw = video.videoWidth;
      const vh = video.videoHeight;
      if (!vw || !vh) return;
      lastSendMs = now;
      inFlight = true;
      const scale = Math.min(1, SEND_WIDTH / vw);
      createImageBitmap(video, { resizeWidth: Math.round(vw * scale), resizeHeight: Math.round(vh * scale), resizeQuality: 'low' })
        .then((bitmap) => {
          // The rung may have been retired while the picture was scaled.
          if (!ladder.post({ type: 'frame', bitmap, time }, [bitmap])) {
            bitmap.close();
            inFlight = false;
          }
        })
        .catch(() => { inFlight = false; });
    },

    /** The latest map, or null before the first answer. */
    latest() { return latest; },

    /** For the readings margin and its copy button. */
    status() {
      const sorted = [...status.inferTimes].sort((a, b) => a - b);
      return {
        ...ladder.facts(),
        lastInferMs: status.lastInferMs,
        medianInferMs: sorted.length ? sorted[Math.floor(sorted.length / 2)] : 0,
        looksPerSecond: +(status.looks.length / 5).toFixed(1),
      };
    },

    clear() { latest = null; },

    dispose() { ladder.dispose(); },
  };
}
