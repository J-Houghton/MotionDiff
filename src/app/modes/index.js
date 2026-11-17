// @ts-check
/**
 * The mode registry. A mode is one module in this folder plus one entry in
 * MODES; nothing else needs to know it exists. The pipeline calls its
 * `render`, and the panel builds its controls from `params` and lists the
 * modes in the order given here. The keys 1–6 pick the six effects the
 * modes fold into (app/effects.js), not the modes themselves.
 *
 * The typedefs below are the mode contract; `npm run typecheck` holds every
 * mode module to it (each annotates its default export as a Mode).
 *
 * @typedef {'first'|'advance'|'repeat'|'rewind'|'jump'} FrameStep
 *   How this frame's media time relates to the previous one
 *   (core/timebase.js classifyStep).
 *
 * @typedef {Record<string, *>} ModeParams
 *   Every runtime setting, keyed by param key: pipeline.params. Values are
 *   numbers (range), booleans (toggle), strings (select, color); fpsCap may
 *   be null. Values are untyped: the schema, not the type system, says what
 *   each key holds.
 *
 * @typedef {object} ModeFrame
 *   The per-frame context built in Pipeline.process and handed to render().
 * @property {*} gl - WebGLRenderer (app/renderer.webgl.js)
 * @property {*} ring - FrameRing: slots and stamps of the frame history
 * @property {number} time - This frame's media time, seconds
 * @property {FrameStep} step
 * @property {number} dtMs - Media time since the previous frame (0 for a
 *   frame rendered again)
 * @property {number} stepMs - As dtMs, but keeps its value on a repeat, for
 *   feedback state that is recomputed rather than advanced
 * @property {number} trailAgeStep - How far trail ages advance, in trail windows
 * @property {ModeParams} params
 * @property {'diff'|'overlay'|'glow'|'data'} display
 * @property {number[]} layers - Scratch for ring layer indices
 * @property {number} [pausedDt] - Wall-clock seconds since the last redraw
 *   while the video is paused and the mode animates; only the particle step
 *   consumes it, everything else treats the frame as a repeat
 * @property {(message: string, type?: 'info'|'error') => void} note - Puts a
 *   sentence on the status line (a setup problem, a reading); rate-limited
 * @property {import('../stages.js').Stages} stages - The shared measurement
 *   stages for this frame (records/design/pipeline-stages.md): each computed once per
 *   frame on first request, however many views pull it. WebGL path only
 * @property {*} [depth] - The depth model's latest answer, or null
 *   (records/design/depth-stage.md); read it through frame.stages.depth()
 * @property {object|null} [readings] - A mode may set this: a small object of
 *   live measurements for this frame; the pipeline exposes the latest one as
 *   pipeline.readings for the interface and tools
 *
 * @typedef {object} Mode
 * @property {string} id - Stored in presets as params.algorithm
 * @property {string} label - Shown in the UI
 * @property {string} blurb - One sentence: what the picture means
 * @property {string[]} help - Known artifacts, as short sentences (help sheet)
 * @property {import('./params.js').ParamDef[]} params - Control definitions
 * @property {{kind: 'scalar'|'mask'|'vector', what: string}} data - Every mode
 *   also exposes its result as data, not only as display colours: a per-pixel
 *   field in the renderer's data target, R = the magnitude every consumer can
 *   pool (see core/magnitude.js), G/B mode-specific. Read it with
 *   pipeline.readData().
 * @property {boolean} [composite] - True when diff / overlay / glow display applies
 * @property {boolean} [worker] - True when the Canvas2D worker fallback can run it
 * @property {boolean} [needsFloat] - True when it needs float render targets
 * @property {(params: ModeParams) => string} [summary] - One sentence saying
 *   what the current settings amount to, shown where the time ruler would be
 *   for modes that do not look back by a gap
 * @property {(params: ModeParams) => [number, number]} [lookback] - [shortest,
 *   longest] distance it reads back into the frame ring, in 1/30 s. Defaults
 *   to the gap and the gap plus two spreads
 * @property {(params: ModeParams) => boolean} [animates] - True when the
 *   current settings make the picture move on its own (particle traces). The
 *   session then keeps redrawing while the video is paused, passing the wall
 *   clock as frame.pausedDt; everything else in the frame is a repeat
 * @property {(frame: ModeFrame) => boolean|void} render - Draw one frame on
 *   the GPU. Return false when there was nothing to measure this frame
 */
import posy from './posy.js';
import raw from './raw.js';
import magnify from './magnify.js';
import mask from './mask.js';
import history from './history.js';
import background from './background.js';
import flow from './flow.js';
import schlieren from './schlieren.js';

export const MODES = [posy, raw, magnify, mask, history, background, flow, schlieren];

const BY_ID = new Map(MODES.map((mode) => [mode.id, mode]));

/** @returns {object} The mode, or the first mode for an unknown id */
export function getMode(id) {
  return BY_ID.get(id) || MODES[0];
}

/** Defaults for every param of every mode, plus the mode selection itself. */
export function defaultParams() {
  const params = { algorithm: MODES[0].id };
  for (const mode of MODES) {
    for (const param of mode.params) {
      if (!(param.key in params)) params[param.key] = param.default;
    }
  }
  return params;
}
