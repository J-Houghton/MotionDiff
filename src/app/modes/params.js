/**
 * Parameter definitions shared between modes.
 *
 * A param is plain data. The pipeline takes its `key` and `default`; the UI
 * builds one control per param from the rest (see ui/panel.js):
 *
 *   { key, label, type: 'range' | 'toggle' | 'select' | 'color',
 *     default, min, max, step, options, format, when }
 *
 * `when(params)` hides a control while it has no effect.
 *
 * Gap, spread and trail are in 1/30 s of media time (core/timebase.js) and
 * are shown in milliseconds.
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

export const TINTS = [
  { key: 'rgbTintR', label: 'Tint R', type: 'color', default: '#ff0000', when: (p) => p.channelSpread > 0 },
  { key: 'rgbTintG', label: 'Tint G', type: 'color', default: '#00ff00', when: (p) => p.channelSpread > 0 },
  { key: 'rgbTintB', label: 'Tint B', type: 'color', default: '#0000ff', when: (p) => p.channelSpread > 0 },
];

export const AGE_COLORS = [
  { key: 'ageColorNew', label: 'New', type: 'color', default: '#ff4400' },
  { key: 'ageColorOld', label: 'Old', type: 'color', default: '#0044ff' },
];
