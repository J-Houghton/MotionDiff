/**
 * Background model: marks whatever is not part of the usual scene, whole,
 * whether or not it is moving right now.
 *
 * core/background.js is the source of truth; the three shaders here mirror
 * backgroundStep:
 *
 *   decide    current frame against the model      → foreground + strength
 *   model     running mean, and time since motion  → float RGBA (mean, since)
 *   variance  running variance of the background   → float R
 *
 * The model and the variance each live in two targets that are ping-ponged,
 * so a frame rendered again while paused is recomputed from the state before
 * it. Learning is gated by plain two-frame motion (the mask passes of
 * app/modes/mask.js with both old frames the same): for gating, the place an
 * object just left should count as moving too, and only for one gap. The
 * picture and the data output are drawn by the mask's own output pass.
 *
 * Needs float render targets: an 8-bit mean cannot take steps as small as a
 * slow learning rate asks for.
 */
import {
  BG_HOLD_SECONDS, BG_K, BG_MIN_STEP, BG_VAR_INIT, BG_VAR_MAX, BG_VAR_MIN, backgroundAlpha,
} from '../../core/background.js';
import { TRAIL_HOLD, TRAIL_REFRESH } from '../../core/trails.js';
import { GAP, THRESHOLD, TRAIL } from './params.js';
import { maskDifference, maskDraw } from './mask.js';
import { lookbackTime } from '../../core/timebase.js';

const DECIDE_FRAG = `#version 300 es
precision highp float;

uniform sampler2D uCurrent;
uniform sampler2D uModel;     // RGB = mean
uniform sampler2D uVariance;  // R = variance
uniform float uThreshold;     // mean channel difference, 0..1
uniform float uK;
uniform int uEmpty;           // 1 = nothing learnt yet

out vec4 fragColor;

void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  if (uEmpty == 1) { fragColor = vec4(0.0, 0.0, 0.0, 1.0); return; }
  vec3 e = abs(texelFetch(uCurrent, p, 0).rgb - texelFetch(uModel, p, 0).rgb);
  float d = (e.r + e.g + e.b) / 3.0;
  float foreground = (d > uThreshold && d > uK * sqrt(texelFetch(uVariance, p, 0).r)) ? 1.0 : 0.0;
  fragColor = vec4(foreground, d, 0.0, 1.0);
}`;

const MODEL_FRAG = `#version 300 es
precision highp float;

uniform sampler2D uCurrent;
uniform sampler2D uModel;     // RGB = mean, A = time since motion, in holds
uniform sampler2D uMask;      // R > 0.5 where the pixel is moving now
uniform float uAlpha;
uniform float uHoldStep;      // media time since the previous frame, in holds
uniform float uMinStep;
uniform int uEmpty;

out vec4 fragColor;

void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  vec3 cur = texelFetch(uCurrent, p, 0).rgb;
  bool moving = texelFetch(uMask, p, 0).r > 0.5;
  if (uEmpty == 1) { fragColor = vec4(cur, moving ? 0.0 : 1.0); return; }

  vec4 prev = texelFetch(uModel, p, 0);
  float since = moving ? 0.0 : min(prev.a + uHoldStep, 1.0);
  vec3 mean = prev.rgb;
  if (since >= 1.0) {
    // A step of uAlpha of the way, but never less than uMinStep (or all of it).
    vec3 e = cur - prev.rgb;
    vec3 size = abs(e);
    mean += sign(e) * max(size * uAlpha, min(size, vec3(uMinStep)));
  }
  fragColor = vec4(mean, since);
}`;

const VARIANCE_FRAG = `#version 300 es
precision highp float;

uniform sampler2D uCurrent;
uniform sampler2D uModel;     // state BEFORE this frame
uniform sampler2D uVariance;
uniform sampler2D uMask;
uniform sampler2D uDecision;  // this frame's raw decision, R = foreground
uniform float uAlpha;
uniform float uHoldStep;
uniform vec3 uLimits;         // min, max, initial
uniform int uEmpty;

out vec4 fragColor;

void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  if (uEmpty == 1) { fragColor = vec4(uLimits.z, 0.0, 0.0, 1.0); return; }
  vec4 model = texelFetch(uModel, p, 0);
  float variance = texelFetch(uVariance, p, 0).r;
  float since = texelFetch(uMask, p, 0).r > 0.5 ? 0.0 : min(model.a + uHoldStep, 1.0);
  bool foreground = texelFetch(uDecision, p, 0).r > 0.5;
  // The variance describes the background: only still, matching pixels teach it.
  if (since >= 1.0 && !foreground) {
    vec3 e = abs(texelFetch(uCurrent, p, 0).rgb - model.rgb);
    float d = (e.r + e.g + e.b) / 3.0;
    variance = clamp(variance + uAlpha * (d * d - variance), uLimits.x, uLimits.y);
  }
  fragColor = vec4(variance, 0.0, 0.0, 1.0);
}`;

/** Which of each pair of state targets holds what, per renderer. */
const STATES = new WeakMap();

/**
 * Classify the current frame against the model, let the model learn, and
 * draw: the picture into the diff target, the foreground mask into the data
 * target.
 *
 * @param {object} renderer - WebGLRenderer
 * @param {object} opts
 * @param {WebGLTexture} opts.mask - Motion mask, R > 0.5 where moving
 * @param {number} opts.alpha - core backgroundAlpha
 * @param {number} opts.holdStep - Media time since the previous frame, in holds
 * @param {number} opts.threshold - Mean channel difference, 0..255
 * @param {boolean} [opts.repeat] - The same frame again: recompute, do not advance
 * @param {boolean} opts.clean - 3x3 majority vote on the foreground
 * @param {'cutout'|'solid'} opts.show
 */
export function renderBackground(renderer, opts) {
  const gl = renderer.gl;
  const { width, height } = renderer;

  // Targets before binds (creating one binds its texture).
  const models = [renderer.target('background:model0', width, height, { float: true }), renderer.target('background:model1', width, height, { float: true })];
  const variances = [renderer.target('background:variance0', width, height, { float: true }), renderer.target('background:variance1', width, height, { float: true })];
  const decision = renderer.target('background:decision', width, height);
  const data = renderer.dataFramebuffer(width, height);

  let state = STATES.get(renderer);
  if (!state || state.epoch !== renderer.epoch || models[0].fresh || models[1].fresh) {
    state = { epoch: renderer.epoch, current: 0, previous: 0, empty: true, previousEmpty: true, drawn: false };
    STATES.set(renderer, state);
    models[0].fresh = models[1].fresh = false;
  }
  let read;
  let empty;
  if (opts.repeat && state.drawn) {
    read = state.previous;
    empty = state.previousEmpty;
  } else {
    read = state.current;
    empty = state.empty;
    state.previous = read;
    state.previousEmpty = empty;
    state.current = 1 - read;
  }
  const write = state.current;

  const decide = renderer.program('background:decide', DECIDE_FRAG, { uCurrent: 0, uModel: 1, uVariance: 2 });
  gl.useProgram(decide.prog);
  renderer.bind(0, renderer.currentTexture);
  renderer.bind(1, models[read].tex);
  renderer.bind(2, variances[read].tex);
  gl.uniform1f(decide.u.uThreshold, opts.threshold / 255);
  gl.uniform1f(decide.u.uK, BG_K);
  gl.uniform1i(decide.u.uEmpty, empty ? 1 : 0);
  renderer.draw(decision.fb, width, height);

  const model = renderer.program('background:model', MODEL_FRAG, { uCurrent: 0, uModel: 1, uMask: 2 });
  gl.useProgram(model.prog);
  renderer.bind(2, opts.mask);
  gl.uniform1f(model.u.uAlpha, opts.alpha);
  gl.uniform1f(model.u.uHoldStep, opts.holdStep);
  gl.uniform1f(model.u.uMinStep, BG_MIN_STEP);
  gl.uniform1i(model.u.uEmpty, empty ? 1 : 0);
  renderer.draw(models[write].fb, width, height);

  const variance = renderer.program('background:variance', VARIANCE_FRAG, { uCurrent: 0, uModel: 1, uMask: 2, uVariance: 3, uDecision: 4 });
  gl.useProgram(variance.prog);
  renderer.bind(3, variances[read].tex);
  renderer.bind(4, decision.tex);
  gl.uniform1f(variance.u.uAlpha, opts.alpha);
  gl.uniform1f(variance.u.uHoldStep, opts.holdStep);
  gl.uniform3f(variance.u.uLimits, BG_VAR_MIN, BG_VAR_MAX, BG_VAR_INIT);
  gl.uniform1i(variance.u.uEmpty, empty ? 1 : 0);
  renderer.draw(variances[write].fb, width, height);

  state.empty = false;
  state.drawn = true;

  maskDraw(renderer, decision.tex, renderer.diffFramebuffer, { clean: opts.clean, output: opts.show });
  maskDraw(renderer, decision.tex, data, { clean: opts.clean, output: 'data' });
}

export default {
  id: 'background',
  label: 'Background model',
  blurb: 'Whatever is not part of the usual scene, whole, moving or not. It learns what is usually there and shows the rest until that too becomes usual.',
  help: [
    'Whatever is in the picture when it starts is taken for background, and leaves a ghost for one absorb time when it moves away.',
    'A stopped object fades into the background after about the absorb time; so does the hole left by one that had been absorbed.',
    'A slow, flat-coloured object is partly absorbed while it passes and leaves a fading trail.',
    'A change of lighting or exposure marks everything until it has been absorbed. A moving camera marks everything, all the time.',
    'Things that never stop moving (foliage, water) stay marked: the model does not learn where there is motion.',
  ],
  data: { kind: 'mask', what: '1 where the pixel is foreground, 0 where it matches the background; G holds how far it is from the model' },
  composite: true,
  worker: false,
  needsFloat: true,
  params: [
    { key: 'absorbSeconds', label: 'Absorb after', type: 'range', min: 0.5, max: 20, step: 0.5, default: 4, format: (v) => `${v} s` },
    THRESHOLD,
    { key: 'maskShow', label: 'Show', type: 'select', default: 'cutout', options: { 'Cut-out': 'cutout', 'Solid mask': 'solid' } },
    GAP,
    TRAIL,
  ],
  render(frame) {
    const { gl: renderer, params } = frame;
    const { width, height } = renderer;
    const mask = renderer.target('background:mask', width, height);
    // What changed since one gap ago, anywhere: that is where not to learn.
    const near = frame.ring.nearest(lookbackTime(frame.time, params.frameOffset, 0, 0), frame.time);
    if (near >= 0) {
      const layer = frame.ring.slotAt(near);
      const raw = maskDifference(renderer, { layers: [layer, layer], threshold: params.threshold, blur: true });
      maskDraw(renderer, raw.tex, mask.fb, { clean: true, output: 'data' });
    } else {
      // No history yet (the very first frame): nothing is known to be moving.
      const gl = renderer.gl;
      gl.bindFramebuffer(gl.FRAMEBUFFER, mask.fb);
      gl.clearColor(0, 0, 0, 1);
      gl.clear(gl.COLOR_BUFFER_BIT);
    }

    renderBackground(renderer, {
      mask: mask.tex,
      alpha: backgroundAlpha(frame.stepMs, params.absorbSeconds),
      holdStep: frame.stepMs / 1000 / BG_HOLD_SECONDS,
      threshold: params.threshold,
      repeat: frame.step === 'repeat',
      clean: true,
      show: params.maskShow,
    });

    renderer.renderTrail({
      isPosy: false,
      ageStep: frame.trailAgeStep,
      hold: TRAIL_HOLD,
      refresh: TRAIL_REFRESH,
      repeat: frame.step === 'repeat',
    });
    renderer.renderComposite(frame.display, 'raw', false);
    return true;
  },
};
