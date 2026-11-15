// @ts-check
import { BG_VAR_MIN } from '../../core/background.js';
import { emaAlpha } from '../../core/magnify.js';
import { FLOW_PRELUDE, flowPass, pingPong, readField } from '../flow.js';
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

// ── Motion-guided magnification (docs/motion-magnify.md) ─────────────
// The measured displacement is band-passed and exaggerated: a warp along
// the measured direction, not an amplified brightness.

/** The largest shift the warp will draw, picture pixels. */
export const MOTION_CAP = 32;

// Fast and slow EMAs of the velocity, packed RG|BA. Mirrors velocityBandStep.
const VBAND_FRAG = `${FLOW_PRELUDE}
uniform sampler2D uPrev;     // RG = fast, BA = slow
uniform sampler2D uVelocity; // RG = picture px/s
uniform vec2 uAlpha;
uniform int uEmpty;

void main() {
  ivec2 p = here();
  vec2 v = px(uVelocity, p).rg;
  vec4 prev = uEmpty == 1 ? vec4(v, v) : px(uPrev, p);
  fragColor = vec4(prev.rg + (v - prev.rg) * uAlpha.x, prev.ba + (v - prev.ba) * uAlpha.y);
}`;

// Leak-integrate the banded velocity into a bounded displacement.
// Mirrors displacementStep.
const DISP_FRAG = `${FLOW_PRELUDE}
uniform sampler2D uPrev;  // RG = displacement, picture px
uniform sampler2D uBand;  // the packed EMAs
uniform float uDt;
uniform float uLeak;
uniform int uEmpty;

void main() {
  ivec2 p = here();
  vec4 state = px(uBand, p);
  vec2 band = state.rg - state.ba;
  vec2 prev = uEmpty == 1 ? vec2(0.0) : px(uPrev, p).rg;
  fragColor = vec4(prev * (1.0 - uLeak) + band * uDt, 0.0, 1.0);
}`;

// The picture: the current frame sampled at x − amp·d(x), faded by flow's
// presence and capped. Mirrors warpByField (which samples the nearest
// field cell; a constant field makes the two exactly comparable).
export const MOTION_WARP_FRAG = `${FLOW_PRELUDE}
uniform sampler2D uFrame;  // the current frame, processing size
uniform sampler2D uDisp;   // RG = displacement, picture px, working size
uniform sampler2D uVel;    // the smoothed field: B = presence
uniform vec2 uProc;        // processing size
uniform float uAmp;
uniform float uCap;

void main() {
  vec2 at = (vec2(here()) + 0.5) * uProc / vec2(uSize) - 0.5;
  vec2 cell = (at + 0.5) * vec2(textureSize(uDisp, 0)) / uProc - 0.5;
  float presence = smoothstep(0.0, 0.25, between(uVel, cell).b);
  vec2 d = clamp(between(uDisp, cell).rg * uAmp * presence, vec2(-uCap), vec2(uCap));
  fragColor = vec4(between(uFrame, at - d).rgb, 1.0);
}`;

// The data field: how far the warp moved each place, as a share of the cap.
const MDATA_FRAG = `${FLOW_PRELUDE}
uniform sampler2D uDisp;
uniform float uAmp;
uniform float uCap;

void main() {
  vec2 cell = (vec2(here()) + 0.5) * vec2(textureSize(uDisp, 0)) / vec2(uSize) - 0.5;
  vec2 d = between(uDisp, cell).rg * uAmp;
  fragColor = vec4(min(1.0, length(d) / uCap), d, 1.0);
}`;

/**
 * Advance the motion band one frame: the velocity's fast and slow EMAs and
 * the leaky displacement integral. Exported for the parity probe.
 *
 * @param {*} renderer
 * @param {{tex: *, width: number, height: number}} velocity
 * @param {{alphaFast: number, alphaSlow: number, dt: number, repeat: boolean}} opts
 * @returns {{disp: {tex: *, fb: *}, velocityTex: *}}
 */
export function motionBandStep(renderer, velocity, opts) {
  const { width, height } = velocity;
  const float = { float: true };
  // Targets before binds.
  const bands = [renderer.target('mag:vband0', width, height, float), renderer.target('mag:vband1', width, height, float)];
  const disps = [renderer.target('mag:disp0', width, height, float), renderer.target('mag:disp1', width, height, float)];
  const band = pingPong(renderer, 'mag:vband', bands, opts.repeat);
  flowPass(renderer, 'mag:vband', VBAND_FRAG, { uPrev: 0, uVelocity: 1 }, band.to, [band.from.tex, velocity.tex], (gl, u) => {
    gl.uniform2f(u.uAlpha, opts.alphaFast, opts.alphaSlow);
    gl.uniform1i(u.uEmpty, band.empty ? 1 : 0);
  });
  const disp = pingPong(renderer, 'mag:disp', disps, opts.repeat);
  flowPass(renderer, 'mag:disp', DISP_FRAG, { uPrev: 0, uBand: 1 }, disp.to, [disp.from.tex, band.to.tex], (gl, u) => {
    gl.uniform1f(u.uDt, opts.dt);
    gl.uniform1f(u.uLeak, opts.alphaSlow);
    gl.uniform1i(u.uEmpty, disp.empty ? 1 : 0);
  });
  return { disp: disp.to, velocityTex: velocity.tex };
}

/**
 * The whole motion-magnified frame: advance the band, write the data
 * field, and warp the current frame onto the canvas.
 *
 * @param {*} renderer
 * @param {import('./index.js').ModeFrame} frame
 * @param {{tex: *, width: number, height: number}} velocity - stages.velocity()
 * @param {{alphaFast: number, alphaSlow: number, amp: number}} opts
 */
export function renderMotionMagnify(renderer, frame, velocity, opts) {
  // Targets before binds (motionBandStep creates its own first).
  const data = renderer.dataFramebuffer(renderer.width, renderer.height);
  const { disp } = motionBandStep(renderer, velocity, {
    alphaFast: opts.alphaFast,
    alphaSlow: opts.alphaSlow,
    dt: frame.stepMs / 1000,
    repeat: frame.step === 'repeat',
  });
  flowPass(renderer, 'mag:data', MDATA_FRAG, { uDisp: 0 }, { fb: data, width: renderer.width, height: renderer.height }, [disp.tex], (gl, u) => {
    gl.uniform1f(u.uAmp, opts.amp);
    gl.uniform1f(u.uCap, MOTION_CAP);
  });
  flowPass(renderer, 'mag:warp', MOTION_WARP_FRAG, { uFrame: 0, uDisp: 1, uVel: 2 },
    { fb: null, width: renderer.canvasWidth || renderer.width, height: renderer.canvasHeight || renderer.height },
    [renderer.currentTexture, disp.tex, velocity.tex], (gl, u) => {
      gl.uniform2f(u.uProc, renderer.width, renderer.height);
      gl.uniform1f(u.uAmp, opts.amp);
      gl.uniform1f(u.uCap, MOTION_CAP);
    });
}

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
    'Measured motion amplifies the movement flow actually measured: the picture is warped along each patch\'s own direction, so a flank that swells half a pixel is drawn swelling further the same way. A brightness rhythm with no movement (a pulse of light) shows little or nothing there — that is the point. Flat interiors carry no measurement and stay put; an occluding edge can smear. WebGL only.',
    'Mute still areas learns each pixel\'s own level of change over a few seconds and fades the amplification where nothing ever happens, which silences amplified sensor noise on walls and bedding. A rhythm fainter than the noise floor (a one-level pulse) is muted with it, and edges that genuinely flicker keep their amplification, standing out harder against the calmed surroundings. Turn the gate off for the faintest signals. Not available on the fallback renderer.',
  ],
  data: { kind: 'scalar', what: 'strength of the amplified band per pixel, 0..1' },
  // Shows the amplified frame directly: no trails, no diff/overlay/glow.
  composite: false,
  worker: true,
  needsFloat: true,
  params: [
    { key: 'magMode', label: 'Amplify', type: 'select', default: 'brightness', options: { 'Brightness changes': 'brightness', 'Measured motion': 'motion' } },
    { key: 'magAmp', label: 'Amplify', type: 'range', min: 1, max: 60, step: 1, default: 15, format: (v) => `${v}x` },
    { key: 'flowGap', label: 'Gap', type: 'range', min: 1, max: 15, step: 1, default: 2, when: (p) => p.magMode === 'motion' },
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
  lookback: (params) => (params.magMode === 'motion' ? [params.flowGap, params.flowGap] : [params.frameOffset, params.frameOffset]),
  // Magnify compares against nothing in the ring (brightness mode), but
  // keeps it warm so switching back to a differencing mode has history.
  render(frame) {
    const { gl, params } = frame;
    if (!gl.magnifySupported) {
      gl.renderBlank('raw', false);
      return false;
    }
    if (params.magMode === 'motion') {
      // The measured displacement, band-passed and exaggerated: a warp
      // along the direction flow measured (docs/motion-magnify.md).
      const velocity = frame.stages.velocity();
      if (!velocity) {
        gl.renderBlank('raw', false);
        return false;
      }
      const low = Math.min(params.magFreqLow, params.magFreqHigh - 0.05);
      renderMotionMagnify(gl, frame, velocity, {
        alphaFast: emaAlpha(params.magFreqHigh, frame.stepMs),
        alphaSlow: emaAlpha(Math.max(0.01, low), frame.stepMs),
        amp: params.magAmp,
      });
      return true;
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
