/**
 * The mode registry. A mode is one module in this folder plus one entry in
 * MODES; nothing else needs to know it exists. The pipeline calls its
 * `render`, the panel builds its controls from `params`, and the keys 1–9
 * select modes in the order listed here.
 *
 * A mode module's default export:
 *
 *   id        string stored in presets as params.algorithm
 *   label     shown in the UI
 *   blurb     one sentence: what the picture means
 *   help      known artifacts, as short sentences (shown in the help sheet)
 *   params    control definitions, see params.js
 *   data      { kind: 'scalar' | 'mask' | 'vector', what } — every mode also
 *             exposes its result as data, not only as display colours: a
 *             per-pixel field in the renderer's data target, R = the
 *             magnitude every consumer can pool (see core/magnitude.js),
 *             G/B mode-specific. Read it with pipeline.readData().
 *   composite true when diff / overlay / glow display applies
 *   worker    true when the Canvas2D worker fallback can run it too
 *   needsFloat true when it needs float render targets
 *   lookback(params)  optional: [shortest, longest] distance it reads back
 *             into the frame ring, in 1/30 s. Defaults to the gap and the
 *             gap plus two spreads.
 *   render(frame)  draw one frame on the GPU. `frame` is the context built
 *             in Pipeline.process: { gl, ring, time, step, dtMs,
 *             trailAgeStep, params, display, layers }. Return false when
 *             there was nothing to measure this frame.
 */
import posy from './posy.js';
import raw from './raw.js';
import magnify from './magnify.js';

export const MODES = [posy, raw, magnify];

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
