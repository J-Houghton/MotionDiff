// @ts-check
/**
 * The backend ladder's driver (docs/model-ladder.md), shared by the two
 * model workers. It gives every rung a fresh worker, counts a rung only
 * once it has proved a look, steps down when a look fails later, and tells
 * its owner in words where it landed and why. The decisions themselves
 * are pure functions in core/ladder.js; this file only moves workers.
 *
 * A fresh worker per rung because a crash out of the runtime leaves that
 * worker's wasm instance poisoned: a retry inside it fails at the same
 * spot whatever the backend.
 */
import {
  LAST_RUNG_STRIKES, failureLine, faultFor, gaveUpWords, ladderRungs, landedWords, rungName, startLadder, stepLadder,
} from '../core/ladder.js';

/** How long one rung may spend downloading, compiling and proving before
 * it is written off as hung (a wedged driver throws nothing at all). */
const RUNG_MS = 180000;

/**
 * @typedef {object} LadderOwner
 * @property {() => Worker} spawn - A fresh worker for one rung
 * @property {string} noun - The option, as the status line names it ("Naming")
 * @property {string} model - The model, as the status line names it ("detector")
 * @property {string|null} [pin] - Pins the GPU rung's precision (triage)
 * @property {(message: any) => void} onResult - A look came back
 * @property {() => void} onLookFailed - The look in flight is gone; nothing will answer it
 * @property {(message: string, type: string) => void} [onStatus]
 * @property {(message: string) => void} [onLost] - The ladder ran out after it had been ready: switch the option off
 */

/**
 * Start down the ladder. `ready` resolves once a rung has proved a look
 * and rejects, with every rung's failure in the message, when none can.
 * @param {LadderOwner} owner
 */
export function createModelLadder(owner) {
  /** @type {import('../core/ladder.js').Ladder|null} */
  let ladder = null;
  /** @type {Worker|null} The proved rung's worker; null while stepping down. */
  let worker = null;
  /** @type {Worker|null} The rung being proved, so dispose can stop it. */
  let proving = null;
  let disposed = false;
  let loadMs = 0;
  const fault = new URLSearchParams(location.search).get('modelfault');

  /**
   * One rung: a fresh worker that must load the model and answer a
   * throwaway look. Rejects with the stage it failed at.
   * @param {import('../core/ladder.js').Rung} rung
   * @returns {Promise<Worker>}
   */
  function prove(rung) {
    return new Promise((resolve, reject) => {
      const w = owner.spawn();
      proving = w;
      /** @param {'load'|'prove'} stage @param {string} message */
      const fail = (stage, message) => { clearTimeout(timer); proving = null; w.terminate(); reject({ stage, message }); };
      const timer = setTimeout(() => fail('load', 'took too long (hung?)'), RUNG_MS);
      w.onmessage = (event) => {
        const message = event.data;
        if (message.type === 'ready') { clearTimeout(timer); proving = null; resolve(w); }
        else fail(message.stage === 'prove' ? 'prove' : 'load', message.message || 'failed');
      };
      w.onerror = (event) => fail('load', event.message || 'worker failed');
      w.postMessage({ type: 'load', device: rung.device, dtype: rung.dtype, fault: faultFor(fault, rung) });
    });
  }

  /** Prove rungs from where the ladder stands until one runs. False when none is left. */
  async function climb() {
    const t0 = performance.now();
    for (;;) {
      /** @type {Worker|null} */
      let w = null;
      /** @type {import('../core/ladder.js').LadderEvent} */
      let event = { type: 'proved' };
      try {
        w = await prove(ladder.rungs[ladder.at]);
      } catch (failure) {
        event = { type: 'failed', stage: failure.stage, message: failure.message };
      }
      if (disposed) { w?.terminate(); return false; }
      const out = stepLadder(ladder, event);
      ladder = out.ladder;
      if (out.action === 'stop') return false;
      if (out.action === 'run') {
        worker = w;
        wire(w);
        loadMs = Math.round(performance.now() - t0);
        // The status line says where the ladder landed and why in words;
        // this is each rung's own failure, for whoever is triaging.
        if (ladder.failures.length) {
          console.warn(`${owner.noun.toLowerCase()} model stepped down:`, ladder.failures.map(failureLine).join(' | '));
        }
        return true;
      }
    }
  }

  /** The proved worker's steady state: looks, and what to do when one fails. */
  function wire(w) {
    w.onmessage = (event) => {
      const message = event.data;
      if (message.type === 'result') {
        ladder = stepLadder(ladder, { type: 'looked' }).ladder;
        owner.onResult(message);
      } else if (message.type === 'error') {
        lookFailed(w, message.message);
      }
    };
    // A worker that dies outright has failed its look too.
    w.onerror = (event) => lookFailed(w, event.message || 'worker failed');
  }

  /** @param {Worker} w @param {string} message */
  function lookFailed(w, message) {
    if (w !== worker || disposed) return;
    owner.onLookFailed();
    const from = landedWords(ladder);
    const out = stepLadder(ladder, { type: 'failed', stage: 'look', message });
    ladder = out.ladder;
    if (out.action === 'report') {
      owner.onStatus?.(`The ${owner.model} failed a look: ${message}`, 'error');
    } else if (out.action === 'try') {
      // Step down once: retire this rung, prove the next, say it once.
      retire();
      owner.onStatus?.(`${owner.noun} is stepping down: ${from.rung} failed a look`, 'info');
      void climb().then((landed) => {
        if (disposed) return;
        if (landed) owner.onStatus?.(sentence(), 'success');
        else lose(gaveUpWords(ladder));
      });
    } else if (out.action === 'stop') {
      lose(`the ${owner.model} failed ${LAST_RUNG_STRIKES} looks in a row on ${from.where} (${message})`);
    }
  }

  function retire() {
    worker?.terminate();
    worker = null;
  }

  /** @param {string} why */
  function lose(why) {
    retire();
    owner.onLost?.(`${owner.noun} switched itself off: ${why}`);
  }

  /** Where it landed and why, or null when the first rung proved. */
  function sentence() {
    const words = landedWords(ladder);
    return words.why ? `${owner.noun} is running on ${words.where} (${words.rung}) because ${words.why}` : null;
  }

  const ready = (async () => {
    // WebGPU rungs first where the browser has an adapter; wasm/q8 is the
    // rung that runs anywhere.
    const adapter = navigator.gpu ? await navigator.gpu.requestAdapter().catch(() => null) : null;
    ladder = startLadder(ladderRungs({ gpu: Boolean(adapter), pin: owner.pin }));
    if (!(await climb())) throw new Error(gaveUpWords(ladder));
  })();

  return {
    ready,

    /** Send a look to the proved rung. False (nothing sent) while there is none. */
    post(message, transfer = []) {
      if (!worker) return false;
      worker.postMessage(message, transfer);
      return true;
    },

    /** True while a proved rung is there to look. */
    live() { return Boolean(worker); },

    /** Where the ladder stands, for the status line and the readings. */
    facts() {
      const rung = ladder ? ladder.rungs[ladder.at] : null;
      return {
        backend: rung ? rung.device : '…',
        dtype: rung ? rung.dtype : '',
        loadMs,
        /** The landed sentence, or null when the first rung proved. */
        landed: ladder ? sentence() : null,
        /** Each failure that cost a rung, as a line. */
        steps: ladder ? ladder.failures.map(failureLine) : [],
      };
    },

    dispose() {
      disposed = true;
      proving?.terminate();
      retire();
    },
  };
}
