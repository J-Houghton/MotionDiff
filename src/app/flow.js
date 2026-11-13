/**
 * Optical flow on the GPU: the shader mirror of core/flow.js, pass for pass.
 * Not a mode: the flow and schlieren modes both call it.
 *
 *   flowLuma()     a frame → luma in levels, reduced by a whole factor
 *   flowBetween()  two luma textures → one flow texture, coarse to fine:
 *                  per size: [warp the older by the guess] → products (the
 *                  tensor and the mismatch, one target each) → window mean
 *                  (rows, then columns) → solve
 *   flowSmooth()   running average of a flow texture over time, weighted by
 *                  confidence
 *   readField()    a flow texture back to JavaScript, for the particles
 *
 * Every target is half float and read with texelFetch. All shaders work in
 * IMAGE coordinates (x right, y down, row 0 at the top), like the core; the
 * prelude below does the flip to and from the bottom-up textures, so block
 * anchoring and the sign of dy match the core on sizes that do not halve
 * evenly.
 *
 * A flow texel is RG = shift in pixels of its own size (older → current),
 * B = confidence (see core/flow.js), A = 1.
 */
import { FLOW_MAX_STEP, FLOW_MISFIT, FLOW_NOISE, FLOW_RADIUS, FLOW_STILL, reducedSize } from '../core/flow.js';

const PRELUDE = `#version 300 es
precision highp float;

uniform ivec2 uSize;   // of the target being drawn
out vec4 fragColor;

// This fragment's pixel, in image coordinates.
ivec2 here() { return ivec2(int(gl_FragCoord.x), uSize.y - 1 - int(gl_FragCoord.y)); }

// A texel by image coordinates; beyond the edge the edge repeats.
vec4 px(sampler2D t, ivec2 q) {
  ivec2 size = textureSize(t, 0);
  q = clamp(q, ivec2(0), size - 1);
  return texelFetch(t, ivec2(q.x, size.y - 1 - q.y), 0);
}

// Between pixels (bilinear); pixel centres sit on whole numbers.
vec4 between(sampler2D t, vec2 q) {
  vec2 base = floor(q);
  vec2 f = q - base;
  ivec2 i = ivec2(base);
  return mix(mix(px(t, i), px(t, i + ivec2(1, 0)), f.x), mix(px(t, i + ivec2(0, 1)), px(t, i + ivec2(1, 1)), f.x), f.y);
}
`;

// Mirrors flowLuma. RING picks a layer of the frame ring instead of the current frame.
const lumaFrag = (ring) => `${PRELUDE}
uniform ${ring ? 'highp sampler2DArray' : 'sampler2D'} uFrame;
uniform int uLayer;
uniform int uFactor;

const vec3 LUMA = vec3(0.2126, 0.7152, 0.0722);

void main() {
  ivec2 size = textureSize(uFrame, 0).xy;
  ivec2 p = here();
  float sum = 0.0;
  for (int dy = 0; dy < uFactor; dy++) {
    for (int dx = 0; dx < uFactor; dx++) {
      ivec2 q = clamp(p * uFactor + ivec2(dx, dy), ivec2(0), size - 1);
      ivec2 texel = ivec2(q.x, size.y - 1 - q.y);
      vec3 rgb = ${ring ? 'texelFetch(uFrame, ivec3(texel, uLayer), 0)' : 'texelFetch(uFrame, texel, 0)'}.rgb;
      sum += dot(rgb * 255.0, LUMA);
    }
  }
  fragColor = vec4(sum / float(uFactor * uFactor), 0.0, 0.0, 1.0);
}`;

// Mirrors halve.
const HALVE_FRAG = `${PRELUDE}
uniform sampler2D uSource;

void main() {
  ivec2 p = here() * 2;
  float sum = px(uSource, p).r + px(uSource, p + ivec2(1, 0)).r + px(uSource, p + ivec2(0, 1)).r + px(uSource, p + ivec2(1, 1)).r;
  fragColor = vec4(sum * 0.25, 0.0, 0.0, 1.0);
}`;

// Mirrors upsampleFlow.
const UPSAMPLE_FRAG = `${PRELUDE}
uniform sampler2D uCoarse;

void main() {
  vec3 flow = between(uCoarse, (vec2(here()) + 0.5) * 0.5 - 0.5).rgb;
  fragColor = vec4(flow.rg * 2.0, flow.b, 1.0);
}`;

// Mirrors warp.
const WARP_FRAG = `${PRELUDE}
uniform sampler2D uOlder;
uniform sampler2D uGuess;

void main() {
  ivec2 p = here();
  fragColor = vec4(between(uOlder, vec2(p) - px(uGuess, p).rg).r, 0.0, 0.0, 1.0);
}`;

// Mirrors flowProducts: uPart 0 writes the tensor terms (and the plain
// difference against the older frame before warping), 1 the mismatch terms.
const PRODUCTS_FRAG = `${PRELUDE}
uniform sampler2D uOlder;
uniform sampler2D uCurrent;
uniform sampler2D uUnwarped;
uniform int uPart;

void main() {
  ivec2 p = here();
  float ix = (px(uOlder, p + ivec2(1, 0)).r - px(uOlder, p - ivec2(1, 0)).r + px(uCurrent, p + ivec2(1, 0)).r - px(uCurrent, p - ivec2(1, 0)).r) * 0.25;
  float iy = (px(uOlder, p + ivec2(0, 1)).r - px(uOlder, p - ivec2(0, 1)).r + px(uCurrent, p + ivec2(0, 1)).r - px(uCurrent, p - ivec2(0, 1)).r) * 0.25;
  float it = px(uCurrent, p).r - px(uOlder, p).r;
  float plain = px(uCurrent, p).r - px(uUnwarped, p).r;
  fragColor = uPart == 0 ? vec4(ix * ix, ix * iy, iy * iy, plain * plain) : vec4(ix * it, iy * it, it * it, 1.0);
}`;

// Mirrors one direction of boxMean.
const BOX_FRAG = `${PRELUDE}
uniform sampler2D uSource;
uniform ivec2 uAxis;
uniform int uRadius;

void main() {
  ivec2 p = here();
  vec4 sum = vec4(0.0);
  for (int d = -uRadius; d <= uRadius; d++) sum += px(uSource, p + uAxis * d);
  fragColor = sum / float(2 * uRadius + 1);
}`;

// Mirrors solvePixel and flowSolve.
const SOLVE_FRAG = `${PRELUDE}
uniform sampler2D uTensor;
uniform sampler2D uMismatch;
uniform sampler2D uGuess;
uniform int uHasGuess;
uniform float uNoise;
uniform float uMaxStep;
uniform float uMisfit;
uniform float uStill;

void main() {
  ivec2 p = here();
  vec4 j = px(uTensor, p);          // Ix², Ix·Iy, Iy², plain difference²
  vec3 b = px(uMismatch, p).rgb;    // Ix·It, Iy·It, It²
  float a = j.r + uNoise;
  float c = j.b + uNoise;
  float det = a * c - j.g * j.g;
  vec2 d = -vec2(c * b.x - j.g * b.y, a * b.y - j.g * b.x) / det;
  float len = length(d);
  if (len > uMaxStep) d *= uMaxStep / len;
  float residual = max(0.0, b.z + 2.0 * dot(d, b.xy) + j.r * d.x * d.x + 2.0 * j.g * d.x * d.y + j.b * d.y * d.y);
  float misfit = residual / ((j.r + j.b) * 0.5 + uNoise);
  float half_ = (j.r - j.b) * 0.5;
  float texture_ = max(0.0, (j.r + j.b) * 0.5 - sqrt(half_ * half_ + j.g * j.g));
  float explained = j.a > 0.0 ? 1.0 - residual / j.a : 0.0;
  float moved = uStill > 0.0 ? clamp((explained - uStill * 0.25) / (uStill * 0.75), 0.0, 1.0) : 1.0;
  if (uHasGuess == 1) d += px(uGuess, p).rg;
  fragColor = vec4(d, texture_ * max(0.0, 1.0 - misfit / uMisfit) * moved, 1.0);
}`;

// Mirrors smoothFlow.
const SMOOTH_FRAG = `${PRELUDE}
uniform sampler2D uPrevious;
uniform sampler2D uMeasured;
uniform float uAlpha;
uniform float uTrusted;
uniform int uEmpty;     // 1 = no previous state: start from the measurement

void main() {
  ivec2 p = here();
  vec3 measured = px(uMeasured, p).rgb;
  float weight = min(1.0, measured.b / uTrusted);
  vec3 previous = uEmpty == 1 ? vec3(0.0) : px(uPrevious, p).rgb;
  float alpha = uEmpty == 1 ? 1.0 : uAlpha;
  fragColor = vec4(previous + (vec3(measured.rg * weight, weight) - previous) * alpha, 1.0);
}`;

// Mirrors smoothedVector.
const RESOLVE_FRAG = `${PRELUDE}
uniform sampler2D uState;
uniform float uFloor;

void main() {
  vec3 state = px(uState, here()).rgb;
  float known = step(uFloor, state.b) * step(1e-6, state.b);
  fragColor = vec4(known * state.rg / max(state.b, 1e-6), state.b, 1.0);
}`;

/** One fullscreen pass: program, inputs on units 0.., uniforms, into a target. */
export function flowPass(renderer, name, frag, samplers, target, textures, set) {
  const gl = renderer.gl;
  const program = renderer.program(name, frag, samplers);
  gl.useProgram(program.prog);
  textures.forEach((texture, unit) => renderer.bind(unit, texture, texture === renderer.ringTexture));
  gl.uniform2i(program.u.uSize, target.width, target.height);
  if (set) set(gl, program.u);
  renderer.draw(target.fb, target.width, target.height);
  return target;
}

/** The shared prelude, for modes that write their own passes on flow textures. */
export const FLOW_PRELUDE = PRELUDE;

/**
 * Luma of the current frame, or of a ring layer, reduced by a whole factor.
 *
 * @param {object} renderer - WebGLRenderer
 * @param {string} key - Names the target
 * @param {number} factor - 1, 2, 3…
 * @param {number} [layer] - Ring layer; omit for the current frame
 * @returns {{tex, fb, width, height}} R = luma in levels
 */
export function flowLuma(renderer, key, factor, layer) {
  const target = renderer.target(key, reducedSize(renderer.width, factor), reducedSize(renderer.height, factor), { float: true });
  const ring = layer !== undefined;
  return flowPass(renderer, ring ? 'flow:luma-ring' : 'flow:luma', lumaFrag(ring), { uFrame: 0 }, target,
    [ring ? renderer.ringTexture : renderer.currentTexture], (gl, u) => {
      gl.uniform1i(u.uFactor, factor);
      if (ring) gl.uniform1i(u.uLayer, layer);
    });
}

/**
 * Flow between two luma textures of the same size, coarse to fine.
 *
 * @param {object} renderer
 * @param {string} key - Prefix for this caller's targets
 * @param {{tex, width, height}} older
 * @param {{tex, width, height}} current
 * @param {{levels?: number, radius?: number, noise?: number, maxStep?: number, still?: number}} [options]
 * @returns {{tex, fb, width, height}} The flow at the inputs' size
 */
export function flowBetween(renderer, key, older, current, options = {}) {
  const levels = Math.max(1, options.levels ?? 3);
  const radius = options.radius ?? FLOW_RADIUS;
  const noise = options.noise ?? FLOW_NOISE;
  const maxStep = options.maxStep ?? FLOW_MAX_STEP;
  const still = options.still ?? FLOW_STILL;
  const float = { float: true };

  // Every target first: creating a texture binds it.
  const sizes = [{ width: older.width, height: older.height }];
  for (let l = 1; l < levels; l++) sizes.push({ width: reducedSize(sizes[l - 1].width, 2), height: reducedSize(sizes[l - 1].height, 2) });
  const at = sizes.map(({ width, height }, l) => {
    const make = (name) => renderer.target(`${key}:${l}:${name}`, width, height, float);
    return {
      width, height,
      older: l === 0 ? older : make('older'),
      current: l === 0 ? current : make('current'),
      guess: l < levels - 1 ? make('guess') : null,
      warped: l < levels - 1 ? make('warped') : null,
      tensor: make('tensor'), mismatch: make('mismatch'), rows: make('rows'),
      tensorMean: make('tensor-mean'), mismatchMean: make('mismatch-mean'),
      flow: make('flow'),
    };
  });

  for (let l = 1; l < levels; l++) {
    flowPass(renderer, 'flow:halve', HALVE_FRAG, { uSource: 0 }, at[l].older, [at[l - 1].older.tex]);
    flowPass(renderer, 'flow:halve', HALVE_FRAG, { uSource: 0 }, at[l].current, [at[l - 1].current.tex]);
  }

  for (let l = levels - 1; l >= 0; l--) {
    const s = at[l];
    let from = s.older;
    if (s.guess) {
      flowPass(renderer, 'flow:upsample', UPSAMPLE_FRAG, { uCoarse: 0 }, s.guess, [at[l + 1].flow.tex]);
      from = flowPass(renderer, 'flow:warp', WARP_FRAG, { uOlder: 0, uGuess: 1 }, s.warped, [s.older.tex, s.guess.tex]);
    }
    const products = { uOlder: 0, uCurrent: 1, uUnwarped: 2 };
    const frames = [from.tex, s.current.tex, s.older.tex];
    const box = (source, target, axis) => flowPass(renderer, 'flow:box', BOX_FRAG, { uSource: 0 }, target, [source.tex], (gl, u) => {
      gl.uniform2i(u.uAxis, axis[0], axis[1]);
      gl.uniform1i(u.uRadius, radius);
    });
    flowPass(renderer, 'flow:products', PRODUCTS_FRAG, products, s.tensor, frames, (gl, u) => gl.uniform1i(u.uPart, 0));
    box(s.tensor, s.rows, [1, 0]);
    box(s.rows, s.tensorMean, [0, 1]);
    flowPass(renderer, 'flow:products', PRODUCTS_FRAG, products, s.mismatch, frames, (gl, u) => gl.uniform1i(u.uPart, 1));
    box(s.mismatch, s.rows, [1, 0]);
    box(s.rows, s.mismatchMean, [0, 1]);
    flowPass(renderer, 'flow:solve', SOLVE_FRAG, { uTensor: 0, uMismatch: 1, uGuess: 2 }, s.flow,
      // Unit 2 needs some texture even when there is no guess to read.
      [s.tensorMean.tex, s.mismatchMean.tex, (s.guess || s.tensorMean).tex], (gl, u) => {
        gl.uniform1i(u.uHasGuess, s.guess ? 1 : 0);
        gl.uniform1f(u.uNoise, noise);
        gl.uniform1f(u.uMaxStep, maxStep);
        gl.uniform1f(u.uMisfit, FLOW_MISFIT);
        gl.uniform1f(u.uStill, still);
      });
  }
  return at[0].flow;
}

/** Which of two feedback targets is current, per renderer and key. */
const PING_STATES = new WeakMap();

/**
 * Bookkeeping for feedback state kept in two targets (the trail's rules):
 * each frame reads one and writes the other; a frame rendered again while
 * paused reads what it read the first time, so the state is recomputed, not
 * advanced twice; everything starts over when the renderer's epoch changes
 * or a target was rebuilt.
 *
 * @param {object} renderer
 * @param {string} key
 * @param {{tex, fb, fresh}[]} targets - Two targets
 * @param {boolean} repeat - The same frame again
 * @param {boolean} [hold] - Leave the state as it is (once it has content):
 *   `to` is then the current target and must not be drawn to
 * @returns {{from: object, to: object, empty: boolean, seen: number, held: boolean}}
 *   empty: `from` has no content yet; seen: frames written before this one
 */
export function pingPong(renderer, key, targets, repeat, hold = false) {
  let states = PING_STATES.get(renderer);
  if (!states) PING_STATES.set(renderer, (states = new Map()));
  let state = states.get(key);
  if (!state || state.epoch !== renderer.epoch || targets[0].fresh || targets[1].fresh) {
    state = { epoch: renderer.epoch, current: 0, previous: 0, seen: 0, previousSeen: 0, drawn: false };
    states.set(key, state);
    targets[0].fresh = targets[1].fresh = false;
  }
  if (hold && state.seen > 0) return { from: targets[state.current], to: targets[state.current], empty: false, seen: state.seen, held: true };
  let read;
  let seen;
  if (repeat && state.drawn) {
    read = state.previous;
    seen = state.previousSeen;
  } else {
    read = state.current;
    seen = state.seen;
    state.previous = read;
    state.previousSeen = seen;
    state.current = 1 - read;
  }
  state.seen = seen + 1;
  state.drawn = true;
  return { from: targets[read], to: targets[state.current], empty: seen === 0, seen, held: false };
}

/**
 * Running average of a flow texture, weighted by confidence (mirrors
 * smoothFlow and smoothedVector). Feedback state, so it follows the trail's
 * rules: two targets, recompute on a repeat, start over when the renderer's
 * epoch changes.
 *
 * @param {object} renderer
 * @param {string} key
 * @param {{tex, width, height}} measured - RG = vector, B = confidence
 * @param {{alpha: number, trusted: number, floor: number, repeat?: boolean}} options
 *   floor: presence below which a place counts as not measured
 * @returns {{tex, fb, width, height}} RG = the averaged vector (zero where
 *   not measured), B = presence 0..1
 */
export function flowSmooth(renderer, key, measured, options) {
  const { width, height } = measured;
  const targets = [renderer.target(`${key}:smooth0`, width, height, { float: true }), renderer.target(`${key}:smooth1`, width, height, { float: true })];
  const resolved = renderer.target(`${key}:smoothed`, width, height, { float: true });
  const { from, to: out, empty } = pingPong(renderer, `${key}:smooth`, targets, options.repeat);
  flowPass(renderer, 'flow:smooth', SMOOTH_FRAG, { uPrevious: 0, uMeasured: 1 }, out, [from.tex, measured.tex], (gl, u) => {
    gl.uniform1f(u.uAlpha, options.alpha);
    gl.uniform1f(u.uTrusted, options.trusted);
    gl.uniform1i(u.uEmpty, empty ? 1 : 0);
  });
  return flowPass(renderer, 'flow:resolve', RESOLVE_FRAG, { uState: 0 }, resolved, [out.tex], (gl, u) => gl.uniform1f(u.uFloor, options.floor));
}

/**
 * Read a float target back: RGBA floats, row 0 at the TOP (the flip is done
 * here). A synchronous readback: keep the target small.
 *
 * @param {object} renderer
 * @param {{fb, width, height}} target
 * @param {{raw: Float32Array, values: Float32Array}} [buffers] - Reused when the size matches
 * @returns {{width: number, height: number, values: Float32Array, raw: Float32Array}}
 */
export function readField(renderer, target, buffers) {
  const gl = renderer.gl;
  const { width, height } = target;
  const length = width * height * 4;
  const raw = buffers?.raw?.length === length ? buffers.raw : new Float32Array(length);
  const values = buffers?.values?.length === length ? buffers.values : new Float32Array(length);
  gl.bindFramebuffer(gl.FRAMEBUFFER, target.fb);
  gl.readPixels(0, 0, width, height, gl.RGBA, gl.FLOAT, raw);
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  const row = width * 4;
  for (let y = 0; y < height; y++) values.set(raw.subarray((height - 1 - y) * row, (height - y) * row), y * row);
  return { width, height, values, raw };
}
