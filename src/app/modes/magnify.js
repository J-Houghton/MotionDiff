// @ts-check
import { BG_VAR_MIN } from '../../core/background.js';
import { emaAlpha } from '../../core/magnify.js';
import { readField } from '../flow.js';
import { reduceField } from '../particles.js';
import { BLUR } from './params.js';

/** The gate opens between these multiples of the frame's quiet σ (25th percentile). */
export const MAG_QUIET_LOW = 1.3;
export const MAG_QUIET_HIGH = 2.2;

// keep = smoothstep(low, high, σ): nothing at the quiet level, everything
// where the pixel's own history keeps raising its variance.
const QUIET_FRAG = `#version 300 es
precision highp float;

uniform sampler2D uVariance; // R = variance of the mean channel difference, 0..1²
uniform float uLow;          // σ, 0..1 units
uniform float uHigh;

out vec4 fragColor;

void main() {
  float sigma = sqrt(texelFetch(uVariance, ivec2(gl_FragCoord.xy), 0).r);
  fragColor = vec4(smoothstep(uLow, uHigh, sigma), 0.0, 0.0, 1.0);
}`;

/** Reused readback buffers and scratch, per renderer. */
const QUIET_BUFFERS = new WeakMap();

/**
 * The mute-still-areas gate for this frame: from the background model's
 * variance (advanced by the stage layer), estimate the frame's quiet σ from
 * a small readback and write keep = smoothstep over σ.
 *
 * @param {import('./index.js').ModeFrame} frame
 * @param {{variance: *}} model - stages.background()
 * @returns {{tex: *, fb: *, width: number, height: number}|null}
 */
export function quietGate(frame, model) {
  const { gl: renderer } = frame;
  const { width, height } = renderer;
  // Targets before binds.
  const gate = renderer.target('magnify:gate', width, height);

  // The frame's quiet level: the 25th-percentile σ of a reduced copy.
  const reduced = reduceField(renderer, 'magnify:noise', { tex: model.variance, width, height }, 64);
  const state = QUIET_BUFFERS.get(renderer) || {};
  state.buffers = readField(renderer, reduced, state.buffers);
  QUIET_BUFFERS.set(renderer, state);
  const cells = reduced.width * reduced.height;
  const variances = state.sorted?.length === cells ? state.sorted : (state.sorted = new Float64Array(cells));
  for (let i = 0; i < cells; i++) variances[i] = state.buffers.values[i * 4];
  variances.sort();
  const quiet = Math.sqrt(Math.max(variances[cells >> 2], BG_VAR_MIN));

  const gl = renderer.gl;
  const program = renderer.program('magnify:quiet', QUIET_FRAG, { uVariance: 0 });
  gl.useProgram(program.prog);
  renderer.bind(0, model.variance);
  gl.uniform1f(program.u.uLow, MAG_QUIET_LOW * quiet);
  gl.uniform1f(program.u.uHigh, MAG_QUIET_HIGH * quiet);
  renderer.draw(gate.fb, width, height);
  return gate;
}

export default /** @type {import('./index.js').Mode} */ ({
  id: 'magnify',
  label: 'Magnify',
  blurb: 'A band of slow change, amplified and added back onto the picture: pulse, breathing, sway.',
  help: [
    'Needs a still camera: any shake is amplified with everything else.',
    'Noise is amplified in proportion to the amount; pool more (2x, 4x) to tame it.',
    'Takes about a second to settle after a seek or a cut.',
    'Turn off auto-exposure if you can: exposure changes read as a pulse.',
    'Mute still areas learns each pixel\'s own level of change over a few seconds and fades the amplification where nothing ever happens, which silences amplified sensor noise on walls and bedding. A rhythm fainter than the noise floor (a one-level pulse) is muted with it, and edges that genuinely flicker keep their amplification, standing out harder against the calmed surroundings. Turn the gate off for the faintest signals. Not available on the fallback renderer.',
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
    { key: 'magQuiet', label: 'Mute still areas', type: 'toggle', default: false },
    BLUR,
  ],
  summary(params) {
    const low = Math.min(params.magFreqLow, params.magFreqHigh - 0.05);
    const perMinute = (hz) => Math.round(hz * 60);
    return `Amplifies what repeats ${perMinute(low)} to ${perMinute(params.magFreqHigh)} times a minute, ${params.magAmp} times over. A resting pulse is 50 to 90, breathing 12 to 20.`;
  },
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
    const gate = params.magQuiet ? frame.stages.quietGate() : null;
    // frame.dtMs is media time, so the pass band is in Hz of the scene at
    // any playback rate; a repeated frame advances the filters by nothing.
    const ok = gl.renderMagnify({
      alphaFast: emaAlpha(params.magFreqHigh, frame.dtMs),
      alphaSlow: emaAlpha(Math.max(0.01, low), frame.dtMs),
      amp: params.magAmp,
      chroma: params.magChroma,
      downsample: params.magDownsample,
      blurEnabled: params.blurEnabled,
      gate: gate ? gate.tex : null,
    });
    if (!ok) gl.renderBlank('raw', false);
    return ok;
  },
});
