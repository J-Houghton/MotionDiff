// @ts-check
/**
 * Parameter definitions shared between modes.
 *
 * A param is plain data. The pipeline takes its `key` and `default`; the UI
 * builds one control per param from the rest (see ui/panel.js).
 * `when(params)` hides a control while it has no effect.
 *
 * Gap, spread and trail are in 1/30 s of media time (core/timebase.js) and
 * are shown in milliseconds.
 *
 * @typedef {object} ParamDef
 * @property {string} key - Where the value lives on pipeline.params
 * @property {string} label - Shown beside the control
 * @property {'range'|'toggle'|'select'|'color'} type
 * @property {number|string|boolean} default
 * @property {number} [min] - range only
 * @property {number} [max] - range only
 * @property {number} [step] - range only
 * @property {Record<string, number|string>} [options] - select only: label → value
 * @property {(value: number) => string} [format] - range only: value → shown text
 * @property {(params: import('./index.js').ModeParams) => boolean} [when]
 */

/** Show a value in 1/30 s units as milliseconds. */
export const asMs = (value) => `${Math.round((value * 1000) / 30)} ms`;

export const GAP = {
  key: 'frameOffset', label: 'Gap', type: 'range', min: 1, max: 90, step: 1, default: 5, format: asMs,
};

export const SPREAD = {
  key: 'channelSpread', label: 'RGB spread', type: 'range', min: 0, max: 5, step: 1, default: 0, format: asMs,
};

export const THRESHOLD = {
  key: 'threshold', label: 'Threshold', type: 'range', min: 0, max: 120, step: 1, default: 20,
};

export const TRAIL = {
  key: 'trailLength', label: 'Trail', type: 'range', min: 0, max: 90, step: 1, default: 5, format: asMs,
};

export const BLUR = { key: 'blurEnabled', label: 'Blur', type: 'toggle', default: false };

/**
 * Fill holes in a mask cut-out (morphological close radius; modes built on
 * the mask share it). Lives here, not in mask.js: background.js needs it
 * while its module evaluates, and mask.js and background.js import each
 * other's functions — this file imports nothing, so it breaks that cycle.
 */
export const MASK_FILL = { key: 'maskFill', label: 'Fill holes', type: 'select', default: 0, options: { 'Off': 0, '1 px': 1, '2 px': 2 } };
export const MASK_TRACK = { key: 'maskTrack', label: 'Box the movers', type: 'toggle', default: false };
export const MASK_NAMES = { key: 'maskNames', label: 'Name the movers — experimental (loads a model)', type: 'toggle', default: false, when: (p) => p.maskTrack };
export const MASK_DEPTH = { key: 'maskDepth', label: 'Depth the scene — experimental (loads a model)', type: 'toggle', default: false, when: (p) => p.maskTrack };
export const DEPTH_SHOW = { key: 'depthShow', label: 'Show the depth estimate', type: 'toggle', default: true, when: (p) => p.maskTrack && p.maskDepth };

export const TINTS = [
  { key: 'rgbTintR', label: 'Tint R', type: 'color', default: '#ff0000', when: (p) => p.channelSpread > 0 },
  { key: 'rgbTintG', label: 'Tint G', type: 'color', default: '#00ff00', when: (p) => p.channelSpread > 0 },
  { key: 'rgbTintB', label: 'Tint B', type: 'color', default: '#0000ff', when: (p) => p.channelSpread > 0 },
];

export const AGE_COLORS = [
  { key: 'ageColorNew', label: 'New', type: 'color', default: '#ff4400' },
  { key: 'ageColorOld', label: 'Old', type: 'color', default: '#0044ff' },
];
