import { emaAlpha } from '../../core/magnify.js';
import { BLUR } from './params.js';

export default {
  id: 'magnify',
  label: 'Magnify',
  blurb: 'A band of slow change, amplified and added back onto the picture: pulse, breathing, sway.',
  help: [
    'Needs a still camera: any shake is amplified with everything else.',
    'Noise is amplified in proportion to the amount; pool more (2x, 4x) to tame it.',
    'Takes about a second to settle after a seek or a cut.',
    'Turn off auto-exposure if you can: exposure changes read as a pulse.',
  ],
  data: { kind: 'scalar', what: 'strength of the amplified band per pixel, 0..1' },
  // Shows the amplified frame directly: no trails, no diff/overlay/glow.
  composite: false,
  worker: true,
  needsFloat: true,
  params: [
    { key: 'magAmp', label: 'Amplify', type: 'range', min: 1, max: 60, step: 1, default: 15, format: (v) => `${v}x` },
    { key: 'magFreqLow', label: 'Band low', type: 'range', min: 0.05, max: 5, step: 0.05, default: 0.7, format: (v) => `${v.toFixed(2)} Hz` },
    { key: 'magFreqHigh', label: 'Band high', type: 'range', min: 0.1, max: 10, step: 0.1, default: 2.0, format: (v) => `${v.toFixed(1)} Hz` },
    { key: 'magChroma', label: 'Chroma', type: 'range', min: 0, max: 1, step: 0.05, default: 1.0 },
    { key: 'magDownsample', label: 'Pool', type: 'select', default: 2, options: { '1x (full)': 1, '2x': 2, '4x': 4 } },
    BLUR,
  ],
  // Magnify compares against nothing in the ring, but keeps it warm so
  // switching back to a differencing mode has history.
  render(frame) {
    const { gl, params } = frame;
    if (!gl.magnifySupported) {
      gl.renderBlank('raw', false);
      return false;
    }
    // The band must lie above the low cutoff whatever order the sliders are in.
    const low = Math.min(params.magFreqLow, params.magFreqHigh - 0.05);
    // frame.dtMs is media time, so the pass band is in Hz of the scene at
    // any playback rate; a repeated frame advances the filters by nothing.
    const ok = gl.renderMagnify({
      alphaFast: emaAlpha(params.magFreqHigh, frame.dtMs),
      alphaSlow: emaAlpha(Math.max(0.01, low), frame.dtMs),
      amp: params.magAmp,
      chroma: params.magChroma,
      downsample: params.magDownsample,
      blurEnabled: params.blurEnabled,
    });
    if (!ok) gl.renderBlank('raw', false);
    return ok;
  },
};
