/**
 * WebGL2 renderer for MotionDiff.
 *
 * Frames never leave the GPU: the video element is uploaded straight to a
 * texture, scaled to the processing size, and past frames are kept in a
 * TEXTURE_2D_ARRAY ring (one layer per frame). Which layer holds which frame
 * is the caller's business — see core/buffer.js FrameRing.
 *
 * Programs:
 *   - Diff (Posy + Raw in one shader, branched by uniform), sampling the
 *     current frame and three ring layers
 *   - 3x3 box blur
 *   - Trail: one decaying feedback state (peak + age per pixel and channel)
 *   - Composite (diff / overlay / glow modes)
 *   - Magnify (EMA update + add-back)
 */

import {
  addBand,
  boxPool,
  emaStep,
  magnifyFrame,
  pooledSize,
  seedStates,
  seedStatesFloat,
} from '../core/magnify.js';
import { bandMagnitude, poolMagnitude } from '../core/magnitude.js';
import { boxBlurFloat } from '../core/blur.js';

// ── Shader sources ──────────────────────────────────────────────

const VERT_SRC = `#version 300 es
in vec2 aPosition;
out vec2 vUV;
void main() {
  vUV = aPosition * 0.5 + 0.5;
  gl_Position = vec4(aPosition, 0.0, 1.0);
}`;

// Posy / Raw diff. Mirrors core/diff.js exactly: the arithmetic is done on
// whole 0..255 values (floats hold them exactly), so rounding, the Posy
// baseline of 128 and the threshold comparison all match the core functions
// bit for bit instead of approximately.
const DIFF_FRAG = `#version 300 es
precision highp float;

precision highp sampler2DArray;

uniform sampler2D uCurrent;
uniform sampler2DArray uRing;
uniform vec3 uLayers;       // ring layers compared by the R, G and B channels
uniform vec3 uTintR;
uniform vec3 uTintG;
uniform vec3 uTintB;
uniform float uThreshold;   // mean channel difference, 0..255 (both modes)
uniform int uAlgorithm;     // 0 = Posy, 1 = Raw Diff

in vec2 vUV;
out vec4 fragColor;

void main() {
  vec3 cur = floor(texture(uCurrent, vUV).rgb * 255.0 + 0.5);
  vec4 oldR = texture(uRing, vec3(vUV, uLayers.x));
  vec4 oldG = texture(uRing, vec3(vUV, uLayers.y));
  vec4 oldB = texture(uRing, vec3(vUV, uLayers.z));

  float tintSumR = max(dot(uTintR, vec3(1.0)), 0.0001);
  float tintSumG = max(dot(uTintG, vec3(1.0)), 0.0001);
  float tintSumB = max(dot(uTintB, vec3(1.0)), 0.0001);
  // Each output channel compares against a tint-weighted mix of one old
  // frame, rounded to a whole value like the worker's tintChannel.
  vec3 old = floor(vec3(
    dot(oldR.rgb, uTintR / tintSumR),
    dot(oldG.rgb, uTintG / tintSumG),
    dot(oldB.rgb, uTintB / tintSumB)
  ) * 255.0 + 0.5);

  vec3 result;

  if (uAlgorithm == 0) {
    // Posy: (current + invert(old) + 1) >> 1
    result = floor((cur + (255.0 - old) + 1.0) * 0.5);
    vec3 dev = abs(result - 128.0);
    // mean deviation × 2 < threshold → suppress to the 128 baseline
    if ((dev.r + dev.g + dev.b) * 2.0 < uThreshold * 3.0) result = vec3(128.0);
  } else {
    // Raw diff: |current − old|
    result = abs(cur - old);
    if (result.r + result.g + result.b < uThreshold * 3.0) result = vec3(0.0);
  }

  fragColor = vec4(result / 255.0, 1.0);
}`;

// 3x3 box blur. Mirrors core/blur.js: a pixel on the edge averages only the
// neighbours that exist (no clamped duplicates). uQuantize rounds the mean to
// a whole 0..255 value the way boxBlur does for 8-bit diff data; the float
// magnify grid is blurred unrounded, like boxBlurFloat.
const BLUR_FRAG = `#version 300 es
precision highp float;

uniform sampler2D uInput;
uniform int uQuantize;

out vec4 fragColor;

void main() {
  ivec2 size = textureSize(uInput, 0);
  ivec2 p = ivec2(gl_FragCoord.xy);
  vec3 sum = vec3(0.0);
  float count = 0.0;
  for (int dy = -1; dy <= 1; dy++) {
    for (int dx = -1; dx <= 1; dx++) {
      ivec2 q = p + ivec2(dx, dy);
      if (q.x < 0 || q.y < 0 || q.x >= size.x || q.y >= size.y) continue;
      sum += texelFetch(uInput, q, 0).rgb;
      count += 1.0;
    }
  }
  vec3 mean = sum / count;
  if (uQuantize == 1) mean = floor(mean * 255.0 + 0.5) / 255.0;
  fragColor = vec4(mean, 1.0);
}`;

// ── Shared motion magnitude (GLSL mirror of core/magnitude.js) ──
// Every mode reduces its result to one unsigned value per pixel, written to
// the magnitude target by a small program of its own. Whatever needs "how
// much motion, where" reads that target and nothing mode-specific.

// Magnitude of a Posy / Raw diff texture. Mirrors diffMagnitude.
const MAGNITUDE_DIFF_FRAG = `#version 300 es
precision highp float;

uniform sampler2D uDiff;
uniform int uIsPosy;

out vec4 fragColor;

void main() {
  vec3 v = texelFetch(uDiff, ivec2(gl_FragCoord.xy), 0).rgb * 255.0;
  float m = uIsPosy == 1
    ? (abs(v.r - 128.0) + abs(v.g - 128.0) + abs(v.b - 128.0)) / (3.0 * 127.0)
    : (v.r + v.g + v.b) / (3.0 * 255.0);
  fragColor = vec4(min(m, 1.0), 0.0, 0.0, 1.0);
}`;

// Magnitude of the magnify band. Mirrors bandMagnitude.
const MAGNITUDE_BAND_FRAG = `#version 300 es
precision highp float;

uniform sampler2D uFast;
uniform sampler2D uSlow;
uniform float uAmp;

out vec4 fragColor;

const vec3 LUMA = vec3(0.2126, 0.7152, 0.0722);

void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  vec3 band = texelFetch(uFast, p, 0).rgb - texelFetch(uSlow, p, 0).rgb;
  fragColor = vec4(min(abs(uAmp * dot(band, LUMA)), 1.0), 0.0, 0.0, 1.0);
}`;

// Exact box mean along one axis; run horizontally then vertically it gives
// the per-cell mean of poolMagnitude, with the same cell boundaries (the
// last cell absorbs the remainder). A mip chain would be cheaper to write,
// but its cells are only approximately the grid cells.
const POOL_FRAG = `#version 300 es
precision highp float;

uniform sampler2D uInput;
uniform int uVertical;  // 0 = pool along x, 1 = pool along y
uniform int uCells;     // grid cells along the pooled axis

out vec4 fragColor;

void main() {
  ivec2 size = textureSize(uInput, 0);
  ivec2 p = ivec2(gl_FragCoord.xy);
  int n = uVertical == 1 ? size.y : size.x;
  int index = uVertical == 1 ? p.y : p.x;
  int cell = n / uCells;
  int start = min(index * cell, n);
  int end = index == uCells - 1 ? n : min(start + cell, n);

  float sum = 0.0;
  for (int i = start; i < end; i++) {
    // Frames are stored bottom-up, so image row i is texture row n - 1 - i.
    // Flipping here makes output row 0 the top grid row.
    ivec2 q = uVertical == 1 ? ivec2(p.x, n - 1 - i) : ivec2(i, p.y);
    sum += texelFetch(uInput, q, 0).r;
  }
  float mean = end > start ? sum / float(end - start) : 0.0;
  fragColor = vec4(mean, 0.0, 0.0, 1.0);
}`;

// Trail step. Mirrors core/trails.js trailStep: per pixel and channel, the
// strongest recent diff value ("peak") and its age in trail windows live in
// two feedback textures. One pass advances the ages, lets this frame's diff
// refresh any trail it is at least uRefresh as strong as, and writes the
// image to show — three outputs, so the whole trail costs one draw whatever
// its length.
const TRAIL_FRAG = `#version 300 es
precision highp float;

uniform sampler2D uPeaks;   // previous peaks (8-bit diff values)
uniform sampler2D uAges;    // previous ages, 0..1 of the trail window
uniform sampler2D uDiff;    // this frame's diff
uniform int uIsPosy;        // 1 = Posy space (baseline 128), 0 = Raw (baseline 0)
uniform int uEmpty;         // 1 = no previous state: every peak counts as expired
uniform float uAgeStep;     // media time since the previous frame, in windows
uniform float uHold;        // share of the window held at full strength
uniform float uRefresh;     // a new value this share of the shown one refreshes the trail
uniform int uAgeColor;      // 1 = show Posy motion as a colour by age
uniform int uAgeMixed;      // 1 = "mixed" style: also colour by the burst age
uniform vec3 uAgeColorNew;
uniform vec3 uAgeColorOld;

layout(location = 0) out vec4 outPeaks;
layout(location = 1) out vec4 outAges;
layout(location = 2) out vec4 outShown;

vec3 envelope(vec3 age) {
  vec3 fade = (1.0 - age) / max(1.0 - uHold, 1e-6);
  vec3 env = mix(fade, vec3(1.0), vec3(lessThanEqual(age, vec3(uHold))));
  return mix(env, vec3(0.0), vec3(greaterThanEqual(age, vec3(1.0))));
}

void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  float base = uIsPosy == 1 ? 128.0 : 0.0;

  vec4 prevPeaks = floor(texelFetch(uPeaks, p, 0) * 255.0 + 0.5);
  vec3 peak = prevPeaks.rgb;
  vec4 prevAges = texelFetch(uAges, p, 0);
  vec3 age = uEmpty == 1 ? vec3(1.0) : min(prevAges.rgb + uAgeStep, 1.0);
  // Whether any channel's trail was still showing before this frame.
  float wasLive = min(age.r, min(age.g, age.b)) < 1.0 ? 1.0 : 0.0;
  vec3 env = envelope(age);

  vec3 fresh = floor(texelFetch(uDiff, p, 0).rgb * 255.0 + 0.5);
  vec3 freshDev = abs(fresh - base);
  vec3 held = (peak - base) * env; // what the trail shows now, signed
  vec3 take = vec3(greaterThan(freshDev, vec3(0.0))) * vec3(greaterThanEqual(freshDev, uRefresh * abs(held)));
  // Keep the stronger of the new value and what the old peak had faded to.
  vec3 stronger = mix(floor(base + held + 0.5), fresh, vec3(greaterThanEqual(freshDev, abs(held))));
  peak = mix(peak, stronger, take);
  age = mix(age, vec3(0.0), take);
  env = mix(env, vec3(1.0), take);

  // Burst age (alpha): how long this pixel's current run of motion has been
  // going. Starts when motion arrives with nothing showing; ends when the
  // trail has fully expired.
  float took = max(take.r, max(take.g, take.b));
  float burst = uEmpty == 1 ? 1.0 : min(prevAges.a + uAgeStep, 1.0);
  if (wasLive < 0.5) burst = took > 0.5 ? 0.0 : 1.0;

  // Burst strength (peaks alpha, 0..255): the typical size of the motion
  // during the burst. See trailStep in core/trails.js.
  float freshSum = freshDev.r + freshDev.g + freshDev.b;
  float burstStrength = (uEmpty == 1 || wasLive < 0.5) ? 0.0 : prevPeaks.a;
  if (uIsPosy == 1 && freshSum > 0.0) {
    float now = floor(min(1.0, freshSum / (3.0 * 127.0)) * 255.0 + 0.5);
    if (wasLive < 0.5) {
      burstStrength = now;
    } else {
      float gap = now - burstStrength;
      float move = min(abs(gap), max(1.0, floor(abs(gap) * uAgeStep + 0.5)));
      burstStrength += sign(gap) * move;
    }
  }

  outPeaks = vec4(peak, burstStrength) / 255.0;
  outAges = vec4(age, burst);

  vec3 shown = (peak - base) * env; // signed deviation from the baseline
  if (uAgeColor == 1 && uIsPosy == 1) {
    // Unfaded strength until the peak expires: the colour carries the age.
    vec3 d = abs(peak - base) * vec3(lessThan(age, vec3(1.0)));
    float sum = d.r + d.g + d.b;
    vec3 colour = vec3(0.0);
    if (sum > 0.0) {
      float mag = min(1.0, sum / (3.0 * 127.0));
      float t = dot(d, age) / sum;
      colour = mix(uAgeColorNew, uAgeColorOld, t) * mag;
      // 0.25 is TRAIL_OLD_PEAK_SHARE in core/trails.js.
      if (uAgeMixed == 1) colour = max(colour, mix(uAgeColorNew, uAgeColorOld, burst) * (0.25 * mag + 0.75 * burstStrength / 255.0));
    }
    outShown = vec4(floor(colour * 255.0 + 0.5) / 255.0, 1.0);
  } else {
    outShown = vec4(floor(base + shown + 0.5) / 255.0, 1.0);
  }
}`;

// True box average of the current frame into the magnify working grid.
// Mirrors core/magnify.js boxPool: every texel of each factor x factor block
// is fetched and weighted equally (a single bilinear tap only covers 2x2, so
// at 4x it would skip three quarters of the block), and the result goes to a
// float target so the sub-8-bit precision the averaging buys is kept.
const BOX_POOL_FRAG = `#version 300 es
precision highp float;

uniform sampler2D uInput;
uniform int uFactor;

out vec4 fragColor;

void main() {
  ivec2 size = textureSize(uInput, 0);
  ivec2 p = ivec2(gl_FragCoord.xy);
  int pooledHeight = (size.y + uFactor - 1) / uFactor;
  // Frames are stored bottom-up. Blocks are anchored at the image's top-left
  // like boxPool's, so index image rows from the top.
  int row0 = (pooledHeight - 1 - p.y) * uFactor;
  int col0 = p.x * uFactor;

  vec3 sum = vec3(0.0);
  float count = 0.0;
  for (int dy = 0; dy < uFactor; dy++) {
    int row = row0 + dy;
    if (row >= size.y) break;
    for (int dx = 0; dx < uFactor; dx++) {
      int col = col0 + dx;
      if (col >= size.x) break;
      sum += texelFetch(uInput, ivec2(col, size.y - 1 - row), 0).rgb;
      count += 1.0;
    }
  }
  fragColor = vec4(sum / max(count, 1.0), 1.0);
}`;

// Plain copy — scales the uploaded video frame to the processing size and
// seeds the EMA state textures.
const COPY_FRAG = `#version 300 es
precision highp float;

uniform sampler2D uInput;

in vec2 vUV;
out vec4 fragColor;

void main() {
  fragColor = vec4(texture(uInput, vUV).rgb, 1.0);
}`;

// One EMA step into a float render target. Run twice per frame with
// different alpha uniforms (fast follower from the HIGH cutoff, slow
// follower from the LOW cutoff). Mirrors core/magnify.js emaUpdate.
const EMA_FRAG = `#version 300 es
precision highp float;

uniform sampler2D uState;   // previous EMA state (float texture)
uniform sampler2D uFrame;   // blurred/downsampled current frame
uniform float uAlpha;

in vec2 vUV;
out vec4 fragColor;

void main() {
  vec3 prev = texture(uState, vUV).rgb;
  vec3 frame = texture(uFrame, vUV).rgb;
  fragColor = vec4(prev + uAlpha * (frame - prev), 1.0);
}`;

// Magnify add-back: current full-res frame + amp * band, with the
// Rec.709 luma/chroma split. The float states sit on the pooled grid;
// linear texture sampling performs the upsample. Mirrors core/magnify.js
// addBand, including the block geometry and clamping.
const MAG_COMPOSITE_FRAG = `#version 300 es
precision highp float;

uniform sampler2D uCurrent;
uniform sampler2D uFast;
uniform sampler2D uSlow;
uniform float uAmp;
uniform float uChroma;
uniform vec2 uBandScale;  // frame size / (pooled grid size * factor), <= 1

in vec2 vUV;
out vec4 fragColor;

const vec3 LUMA = vec3(0.2126, 0.7152, 0.0722);

void main() {
  vec3 cur = texture(uCurrent, vUV).rgb;
  // When the frame is not a multiple of the factor the last block overhangs
  // it, so the grid spans slightly more than the frame. Blocks are anchored
  // at the image's top-left: scale in image space (y down), then flip back.
  vec2 uvImage = vec2(vUV.x, 1.0 - vUV.y) * uBandScale;
  vec2 uvBand = vec2(uvImage.x, 1.0 - uvImage.y);
  vec3 band = texture(uFast, uvBand).rgb - texture(uSlow, uvBand).rgb;
  float bandLuma = dot(band, LUMA);
  vec3 result = cur + uAmp * bandLuma + uAmp * uChroma * (band - vec3(bandLuma));
  fragColor = vec4(clamp(result, 0.0, 1.0), 1.0);
}`;

// Shows a mode's data output instead of its picture: the magnitude in R as
// grey, or for a vector field the direction in G/B as hue with the magnitude
// as brightness.
const DATA_VIEW_FRAG = `#version 300 es
precision highp float;

uniform sampler2D uData;
uniform int uVector;

in vec2 vUV;
out vec4 fragColor;

vec3 hue(float h) {
  return clamp(abs(fract(h + vec3(0.0, 2.0 / 3.0, 1.0 / 3.0)) * 6.0 - 3.0) - 1.0, 0.0, 1.0);
}

void main() {
  vec4 d = texture(uData, vUV);
  vec3 colour = vec3(d.r);
  if (uVector == 1 && dot(d.gb, d.gb) > 1e-6) {
    colour = hue(atan(d.b, d.g) / 6.2831853) * max(d.r, 0.15);
  }
  fragColor = vec4(colour, 1.0);
}`;

const COMPOSITE_FRAG = `#version 300 es
precision highp float;

uniform sampler2D uDiff;
uniform sampler2D uOriginal;
uniform int uMode;       // 0=diff, 1=overlay, 2=glow
uniform int uAlgorithm;  // 0=posy, 1=raw
uniform int uAgeColorEnabled;

in vec2 vUV;
out vec4 fragColor;

const float POSY_BASE = 128.0 / 255.0;

void main() {
  vec3 diff = texture(uDiff, vUV).rgb;
  vec3 orig = texture(uOriginal, vUV).rgb;

  vec3 result;

  if (uMode == 0) {
    // Diff only
    result = diff;
  } else if (uMode == 1) {
    // Overlay: screen blend of motion magnitude onto original
    vec3 mot;
    if (uAlgorithm == 0 && uAgeColorEnabled == 0) {
      mot = min(vec3(1.0), abs(diff - POSY_BASE) * 4.0);
    } else {
      mot = min(vec3(1.0), diff * 2.0);
    }
    // screen(a, b) = 1 - (1-a)*(1-b)
    result = 1.0 - (1.0 - orig) * (1.0 - mot);
  } else {
    // Glow: additive blend
    vec3 mot;
    if (uAlgorithm == 0 && uAgeColorEnabled == 0) {
      mot = min(vec3(1.0), abs(diff - POSY_BASE) * 6.0);
    } else {
      mot = min(vec3(1.0), diff * 3.0);
    }
    result = min(vec3(1.0), orig + mot);
  }

  fragColor = vec4(result, 1.0);
}`;

// ── Helpers ─────────────────────────────────────────────────────

function compileShader(gl, type, src) {
  const sh = gl.createShader(type);
  gl.shaderSource(sh, src);
  gl.compileShader(sh);
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(sh);
    gl.deleteShader(sh);
    throw new Error(`Shader compile error: ${log}`);
  }
  return sh;
}

/**
 * Compile and link a fragment program against the shared vertex shader.
 * Uniform locations are looked up once here and cached on `u`; sampler
 * uniforms are bound to their texture units once and never touched again.
 *
 * @param {WebGL2RenderingContext} gl
 * @param {WebGLShader} vs
 * @param {string} fragSrc
 * @param {Record<string, number>} [samplers] - sampler uniform name → texture unit
 * @returns {{prog: WebGLProgram, u: Record<string, WebGLUniformLocation>}}
 */
function createProgram(gl, vs, fragSrc, samplers = {}) {
  const fs = compileShader(gl, gl.FRAGMENT_SHADER, fragSrc);
  const prog = gl.createProgram();
  gl.attachShader(prog, vs);
  gl.attachShader(prog, fs);
  // Every program shares one quad VAO, so aPosition must sit at location 0.
  gl.bindAttribLocation(prog, 0, 'aPosition');
  gl.linkProgram(prog);
  gl.deleteShader(fs);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
    const log = gl.getProgramInfoLog(prog);
    gl.deleteProgram(prog);
    throw new Error(`Program link error: ${log}`);
  }

  const u = {};
  const count = gl.getProgramParameter(prog, gl.ACTIVE_UNIFORMS);
  for (let i = 0; i < count; i++) {
    const info = gl.getActiveUniform(prog, i);
    if (!info) continue;
    u[info.name.replace(/\[0\]$/, '')] = gl.getUniformLocation(prog, info.name);
  }

  gl.useProgram(prog);
  for (const [name, unit] of Object.entries(samplers)) {
    if (u[name]) gl.uniform1i(u[name], unit);
  }
  return { prog, u };
}

function createTexture(gl) {
  const tex = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  return tex;
}

function createFramebuffer(gl, tex) {
  const fb = gl.createFramebuffer();
  gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
  return fb;
}

function hexToVec3(hex, fallback) {
  const value = typeof hex === 'string' && /^#[0-9a-f]{6}$/i.test(hex) ? hex : fallback;
  return [
    parseInt(value.slice(1, 3), 16) / 255,
    parseInt(value.slice(3, 5), 16) / 255,
    parseInt(value.slice(5, 7), 16) / 255,
  ];
}

// ── WebGLRenderer class ─────────────────────────────────────────

/**
 * Above this source/processing width ratio a single bilinear tap skips
 * source texels, so the capture pass switches to a mipmapped source.
 */
const MIP_DOWNSCALE_RATIO = 1.5;

export class WebGLRenderer {
  /**
   * @param {HTMLCanvasElement} canvas - The output canvas element
   * @throws {Error} If WebGL2 is not available
   */
  /**
   * @param {HTMLCanvasElement} canvas - The output canvas element
   * @param {{noFloat?: boolean}} [options] - noFloat behaves as a GPU without
   *   float render targets would (for exercising that fallback)
   */
  constructor(canvas, options = {}) {
    this._noFloat = Boolean(options.noFloat);
    // Programs and render targets created on demand by mode modules
    this._modePrograms = new Map();
    this._modeTargets = new Map();
    const gl = canvas.getContext('webgl2', {
      alpha: false,
      antialias: false,
      premultipliedAlpha: false,
      preserveDrawingBuffer: false,
    });
    if (!gl) throw new Error('WebGL2 not available');

    this.gl = gl;
    this.canvas = canvas;
    this.width = 0;
    this.height = 0;

    // Programs
    this._diffProg = null;
    this._blurProg = null;
    this._trailProg = null;
    this._compositeProg = null;
    this._magnitudeDiffProg = null;
    this._magnitudeBandProg = null;
    this._poolProg = null;

    // Geometry
    this._quadVAO = null;

    // Video frame at its native size, straight from texImage2D
    this._srcTex = null;
    this._srcMipped = false;
    // Current frame at the processing size
    this._curTex = null;
    this._curFB = null;
    // Past frames at the processing size: one TEXTURE_2D_ARRAY layer each
    this._ringTex = null;
    this._ringFrames = 0;

    // Trail feedback state, ping-ponged: peaks (RGBA8) + ages (float where
    // renderable). Each framebuffer also carries the shown image (_accumTex)
    // as a third colour attachment.
    this._trailPeaks = [null, null];
    this._trailAgeTex = [null, null];
    this._trailFB = [null, null];
    this._trailAgesFloat = false;
    this._trailCur = 0;        // state after the last rendered frame
    this._trailPrev = 0;       // state that frame was computed from
    this._trailEmpty = true;   // _trailCur holds nothing yet
    this._trailPrevEmpty = true;
    this._trailHasFrame = false;

    // Intermediate framebuffers
    this._diffTex = null;
    this._diffFB = null;
    this._blurTex = null;
    this._blurFB = null;
    // Trail image the composite reads
    this._accumTex = null;
    this._accumFB = null;

    // ── Magnify resources (allocated lazily at the downsampled size) ──
    this._copyProg = null;
    this._boxPoolProg = null;
    this._emaProg = null;
    this._magCompositeProg = null;
    this._magW = 0;
    this._magH = 0;
    this._magFrameTex = null;
    this._magFrameFB = null;
    this._magBlurTex = null;
    this._magBlurFB = null;
    // Two ping-pong float texture pairs: fast and slow EMA states
    this._magFastTex = [null, null];
    this._magFastFB = [null, null];
    this._magSlowTex = [null, null];
    this._magSlowFB = [null, null];
    this._magStateRead = 0;
    this._magNeedsSeed = true;

    /** @type {boolean} Whether magnify mode can run on this context */
    this.magnifySupported = false;
    this._magUseFullFloat = false;
    // ── Shared motion magnitude ──
    // Which program fills the magnitude target for the frame just rendered
    // ('posy' | 'raw' | 'band'), or null when that frame carries no motion
    // measurement. Set by each mode's render path, consumed lazily.
    this._magnitudeSource = null;
    this._magnitudeAmp = 0;
    this._magnitudeTex = null;
    this._magnitudeFB = null;
    this._magnitudeW = 0;
    this._magnitudeH = 0;
    // Pooling targets: (cols x height) after the horizontal pass, then
    // (cols x rows); float when the context can render to float
    this._dataFloat = false;
    this._poolHTex = null;
    this._poolHFB = null;
    this._poolTex = null;
    this._poolFB = null;
    this._poolCols = 0;
    this._poolRows = 0;
    this._poolH = 0;
    this._energyPixels = null;
    this._energyGrid = null;

    this._init();
  }

  _init() {
    const gl = this.gl;

    // ── Compile shader programs ──
    const vs = compileShader(gl, gl.VERTEX_SHADER, VERT_SRC);

    this._diffProg = createProgram(gl, vs, DIFF_FRAG, { uCurrent: 0, uRing: 1 });
    this._blurProg = createProgram(gl, vs, BLUR_FRAG, { uInput: 0 });
    this._trailProg = createProgram(gl, vs, TRAIL_FRAG, { uPeaks: 0, uAges: 1, uDiff: 2 });
    this._compositeProg = createProgram(gl, vs, COMPOSITE_FRAG, { uDiff: 0, uOriginal: 1 });
    this._dataViewProg = createProgram(gl, vs, DATA_VIEW_FRAG, { uData: 0 });
    this._copyProg = createProgram(gl, vs, COPY_FRAG, { uInput: 0 });
    this._boxPoolProg = createProgram(gl, vs, BOX_POOL_FRAG, { uInput: 0 });
    this._emaProg = createProgram(gl, vs, EMA_FRAG, { uState: 0, uFrame: 1 });
    this._magCompositeProg = createProgram(gl, vs, MAG_COMPOSITE_FRAG, { uCurrent: 0, uFast: 1, uSlow: 2 });
    this._magnitudeDiffProg = createProgram(gl, vs, MAGNITUDE_DIFF_FRAG, { uDiff: 0 });
    this._magnitudeBandProg = createProgram(gl, vs, MAGNITUDE_BAND_FRAG, { uFast: 0, uSlow: 1 });
    this._poolProg = createProgram(gl, vs, POOL_FRAG, { uInput: 0 });

    // Kept: mode modules compile their own programs against it later.
    this._vertexShader = vs;

    // ── Magnify float-texture support ──
    // EMA states need render-to-float. Prefer RGBA32F (only when its
    // linear filtering extension is present — the upsample relies on it);
    // otherwise RGBA16F, which WebGL2 filters natively and which either
    // color-buffer extension makes renderable. With neither extension,
    // magnify mode is unavailable on the WebGL path.
    const extFloat = this._noFloat ? null : gl.getExtension('EXT_color_buffer_float');
    const extHalf = extFloat || this._noFloat ? null : gl.getExtension('EXT_color_buffer_half_float');
    const extFloatLinear = gl.getExtension('OES_texture_float_linear');
    this.magnifySupported = Boolean(extFloat || extHalf);
    this._magUseFullFloat = Boolean(extFloat && extFloatLinear);
    // Magnitude and pooling targets hold means far finer than 1/255; keep
    // them in half floats wherever those can be rendered to.
    this._dataFloat = this.magnifySupported;

    // ── Fullscreen quad geometry ──
    this._quadVAO = gl.createVertexArray();
    gl.bindVertexArray(this._quadVAO);

    const quadBuf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, quadBuf);
    // Two triangles covering clip space [-1, 1]
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([
      -1, -1, 1, -1, -1, 1,
      -1,  1, 1, -1,  1,  1,
    ]), gl.STATIC_DRAW);

    // aPosition is bound to location 0 in every program (see createProgram)
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);

    gl.bindVertexArray(null);

    // Video frames and pixel buffers are stored bottom-up so that vUV (0,0)
    // is the bottom-left of the image and the canvas shows it upright.
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);

    this._srcTex = createTexture(gl);
  }

  /**
   * Set up framebuffers and textures for the processing resolution.
   * Must be called whenever video dimensions change.
   *
   * @param {number} width
   * @param {number} height
   * @param {number} [ringFrames] - Layers to allocate in the frame ring
   * @returns {number} Ring layers actually allocated (may be fewer than asked
   *   for when the GPU runs out of memory)
   */
  setSize(width, height, ringFrames = this._ringFrames || 2) {
    if (this.width === width && this.height === height && this._ringFrames === ringFrames) {
      return this._ringFrames;
    }
    this.width = width;
    this.height = height;

    const gl = this.gl;

    // Canvas must match processing resolution
    this.canvas.width = width;
    this.canvas.height = height;
    gl.viewport(0, 0, width, height);

    // ── Current frame + frame ring ──
    this._cleanupTexFB(this._curTex, this._curFB);
    this._curTex = this._createSizedTexture(width, height);
    this._curFB = createFramebuffer(gl, this._curTex);
    this._allocateRing(width, height, ringFrames);

    // ── Intermediate framebuffers ──
    // Diff output
    this._cleanupTexFB(this._diffTex, this._diffFB);
    this._diffTex = this._createSizedTexture(width, height);
    this._diffFB = createFramebuffer(gl, this._diffTex);

    // Blur (ping-pong with diff)
    this._cleanupTexFB(this._blurTex, this._blurFB);
    this._blurTex = this._createSizedTexture(width, height);
    this._blurFB = createFramebuffer(gl, this._blurTex);

    // Trail image
    this._cleanupTexFB(this._accumTex, this._accumFB);
    this._accumTex = this._createSizedTexture(width, height);
    this._accumFB = createFramebuffer(gl, this._accumTex);

    // ── Trail feedback state ──
    this._allocateTrailState(width, height);
    this._magNeedsSeed = true;

    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    return this._ringFrames;
  }

  /**
   * Allocate the frame ring as immutable TEXTURE_2D_ARRAY storage. If the
   * driver refuses the allocation, retry with half the layers.
   */
  _allocateRing(width, height, ringFrames) {
    const gl = this.gl;
    if (this._ringTex) gl.deleteTexture(this._ringTex);
    this._ringTex = null;
    this._ringFrames = 0;

    const maxLayers = gl.getParameter(gl.MAX_ARRAY_TEXTURE_LAYERS) || 256;
    let frames = Math.max(1, Math.min(Math.floor(ringFrames) || 1, maxLayers));

    while (gl.getError() !== gl.NO_ERROR) { /* drain stale errors */ }
    for (;;) {
      const tex = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D_ARRAY, tex);
      gl.texStorage3D(gl.TEXTURE_2D_ARRAY, 1, gl.RGBA8, width, height, frames);
      if (gl.getError() === gl.NO_ERROR) {
        gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        this._ringTex = tex;
        this._ringFrames = frames;
        return;
      }
      gl.deleteTexture(tex);
      if (frames <= 1) throw new Error('Frame ring allocation failed');
      console.warn(`Frame ring: ${frames} layers refused, retrying with ${frames >> 1}`);
      frames >>= 1;
    }
  }

  /**
   * Allocate the two trail states. Ages want float precision (a step can be
   * a small fraction of the window); where the float attachment will not
   * complete the framebuffer they fall back to 8 bits.
   */
  _allocateTrailState(width, height) {
    const gl = this.gl;
    const build = (floatAges) => {
      for (let i = 0; i < 2; i++) {
        if (this._trailPeaks[i]) gl.deleteTexture(this._trailPeaks[i]);
        if (this._trailAgeTex[i]) gl.deleteTexture(this._trailAgeTex[i]);
        if (this._trailFB[i]) gl.deleteFramebuffer(this._trailFB[i]);

        this._trailPeaks[i] = this._createSizedTexture(width, height);
        this._trailAgeTex[i] = this._createDataTexture(width, height, floatAges);

        const fb = gl.createFramebuffer();
        gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
        gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this._trailPeaks[i], 0);
        gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT1, gl.TEXTURE_2D, this._trailAgeTex[i], 0);
        gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT2, gl.TEXTURE_2D, this._accumTex, 0);
        gl.drawBuffers([gl.COLOR_ATTACHMENT0, gl.COLOR_ATTACHMENT1, gl.COLOR_ATTACHMENT2]);
        this._trailFB[i] = fb;
      }
      return gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE;
    };

    this._trailAgesFloat = this._dataFloat;
    if (!build(this._trailAgesFloat) && this._trailAgesFloat) {
      this._trailAgesFloat = false;
      build(false);
    }
    this._trailCur = 0;
    this._trailPrev = 0;
    this._trailEmpty = true;
    this._trailPrevEmpty = true;
    this._trailHasFrame = false;
  }

  /** Layers in the frame ring. */
  get ringFrames() {
    return this._ringFrames;
  }

  _createSizedTexture(w, h) {
    const gl = this.gl;
    const tex = createTexture(gl);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    return tex;
  }

  _cleanupTexFB(tex, fb) {
    const gl = this.gl;
    if (tex) gl.deleteTexture(tex);
    if (fb) gl.deleteFramebuffer(fb);
  }

  _createFloatTexture(w, h) {
    const gl = this.gl;
    const tex = createTexture(gl);
    const internal = this._magUseFullFloat ? gl.RGBA32F : gl.RGBA16F;
    const type = this._magUseFullFloat ? gl.FLOAT : gl.HALF_FLOAT;
    gl.texImage2D(gl.TEXTURE_2D, 0, internal, w, h, 0, gl.RGBA, type, null);
    return tex;
  }

  /**
   * (Re)create the magnify working textures at the downsampled size.
   * Returns false (and marks magnify unsupported) if the float
   * framebuffer turns out to be incomplete on this driver.
   */
  _ensureMagResources(w, h) {
    if (this._magW === w && this._magH === h && this._magFrameTex) return true;
    const gl = this.gl;
    this._magW = w;
    this._magH = h;

    // The pooled frame and its blurred copy are float like the states:
    // an 8-bit target here would round the pooled means back to 1/255.
    this._cleanupTexFB(this._magFrameTex, this._magFrameFB);
    this._magFrameTex = this._createFloatTexture(w, h);
    this._magFrameFB = createFramebuffer(gl, this._magFrameTex);

    this._cleanupTexFB(this._magBlurTex, this._magBlurFB);
    this._magBlurTex = this._createFloatTexture(w, h);
    this._magBlurFB = createFramebuffer(gl, this._magBlurTex);

    for (let i = 0; i < 2; i++) {
      this._cleanupTexFB(this._magFastTex[i], this._magFastFB[i]);
      this._magFastTex[i] = this._createFloatTexture(w, h);
      this._magFastFB[i] = createFramebuffer(gl, this._magFastTex[i]);

      this._cleanupTexFB(this._magSlowTex[i], this._magSlowFB[i]);
      this._magSlowTex[i] = this._createFloatTexture(w, h);
      this._magSlowFB[i] = createFramebuffer(gl, this._magSlowTex[i]);
    }

    gl.bindFramebuffer(gl.FRAMEBUFFER, this._magFastFB[0]);
    const complete = gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE;
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    if (!complete) {
      console.warn('Magnify: float framebuffer incomplete, disabling magnify on WebGL');
      this.magnifySupported = false;
      return false;
    }

    this._magStateRead = 0;
    this._magNeedsSeed = true;
    return true;
  }

  _drawQuadTo(fb, w, h) {
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
    gl.viewport(0, 0, w, h);
    gl.bindVertexArray(this._quadVAO);
    gl.drawArrays(gl.TRIANGLES, 0, 6);
  }

  /**
   * Upload the frame a video element is currently presenting and scale it
   * to the processing size. The pixels go GPU to GPU; nothing is read back.
   *
   * @param {HTMLVideoElement} video
   * @returns {boolean} false when the frame could not be uploaded (no frame
   *   decoded yet, or a cross-origin source without CORS)
   */
  captureVideo(video) {
    const gl = this.gl;
    const sourceWidth = video.videoWidth;
    if (!this.width || !this.height || !sourceWidth || !video.videoHeight) return false;

    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this._srcTex);
    try {
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, video);
    } catch {
      return false;
    }

    // A strong downscale needs a prefiltered source or thin detail aliases
    // into frame-to-frame flicker, which a motion tool would show as motion.
    const mipped = sourceWidth > this.width * MIP_DOWNSCALE_RATIO;
    if (mipped) gl.generateMipmap(gl.TEXTURE_2D);
    if (mipped !== this._srcMipped) {
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, mipped ? gl.LINEAR_MIPMAP_LINEAR : gl.LINEAR);
      this._srcMipped = mipped;
    }

    gl.useProgram(this._copyProg.prog);
    this._drawQuadTo(this._curFB, this.width, this.height);
    return true;
  }

  /**
   * Replace the current frame with raw pixels at the processing size.
   * Used by the dev parity probes; playback goes through captureVideo.
   *
   * @param {ImageData} imageData - Must be width x height
   */
  uploadPixels(imageData) {
    const gl = this.gl;
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this._curTex);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, imageData.width, imageData.height, gl.RGBA, gl.UNSIGNED_BYTE, imageData.data);
  }

  /**
   * Copy the current frame into a ring layer.
   * @param {number} layer - Slot handed out by FrameRing.push
   */
  storeCurrent(layer) {
    const gl = this.gl;
    if (!this._ringTex || layer < 0 || layer >= this._ringFrames) return;
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, this._curFB);
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, this._ringTex);
    gl.copyTexSubImage3D(gl.TEXTURE_2D_ARRAY, 0, 0, 0, layer, 0, 0, this.width, this.height);
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, null);
  }

  /**
   * Run the diff shader. Output goes to the diff framebuffer.
   * @param {object} params - { threshold, algorithm, rgbTintR, rgbTintG,
   *   rgbTintB, layers } where layers are the three ring layers the R, G and
   *   B channels compare the current frame against
   */
  renderDiff(params) {
    const gl = this.gl;
    const { prog, u } = this._diffProg;
    gl.useProgram(prog);

    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this._curTex);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, this._ringTex);

    gl.uniform3f(u.uLayers, params.layers[0], params.layers[1], params.layers[2]);
    // Mean channel difference in 0..255, the same unit in Posy and Raw
    gl.uniform1f(u.uThreshold, params.threshold);
    gl.uniform1i(u.uAlgorithm, params.algorithm === 'posy' ? 0 : 1);
    // This frame's motion magnitude comes from the diff texture (read
    // lazily, so a blur pass that follows is included).
    this._magnitudeSource = params.algorithm === 'posy' ? 'posy' : 'raw';
    gl.uniform3fv(u.uTintR, hexToVec3(params.rgbTintR, '#ff0000'));
    gl.uniform3fv(u.uTintG, hexToVec3(params.rgbTintG, '#00ff00'));
    gl.uniform3fv(u.uTintB, hexToVec3(params.rgbTintB, '#0000ff'));

    this._drawQuadTo(this._diffFB, this.width, this.height);
  }

  /**
   * Read the diff target back as top-down RGBA rows. Dev parity probes only.
   * @returns {Uint8Array} width*height*4 bytes, row 0 at the top
   */
  readDiffPixels() {
    const gl = this.gl;
    const w = this.width;
    const h = this.height;
    const raw = new Uint8Array(w * h * 4);
    gl.bindFramebuffer(gl.FRAMEBUFFER, this._diffFB);
    gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, raw);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);

    const out = new Uint8Array(raw.length);
    for (let y = 0; y < h; y++) {
      out.set(raw.subarray((h - 1 - y) * w * 4, (h - y) * w * 4), y * w * 4);
    }
    return out;
  }

  /**
   * Run the box blur shader on the diff output.
   * Reads from _diffTex, writes to _blurTex, then copies back.
   */
  renderBlur() {
    const gl = this.gl;
    const { prog, u } = this._blurProg;
    gl.useProgram(prog);

    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this._diffTex);
    gl.uniform1i(u.uQuantize, 1);

    this._drawQuadTo(this._blurFB, this.width, this.height);

    // Copy blur result back to diff texture (blit)
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, this._blurFB);
    gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, this._diffFB);
    gl.blitFramebuffer(0, 0, this.width, this.height, 0, 0, this.width, this.height, gl.COLOR_BUFFER_BIT, gl.NEAREST);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }

  /**
   * Advance the trail by the current diff result and write the trail image
   * the composite reads. One draw, whatever the trail length.
   *
   * @param {object} opts
   * @param {boolean} opts.isPosy
   * @param {number} opts.ageStep - Media time since the previous frame, in
   *   trail windows
   * @param {number} opts.hold - Share of the window held at full strength
   * @param {number} opts.refresh - See core/trails.js TRAIL_REFRESH
   * @param {boolean} [opts.repeat] - The same frame rendered again (a
   *   parameter change while paused): recompute from the state the first
   *   attempt started from instead of stacking onto its result
   * @param {boolean} [opts.ageColorEnabled]
   * @param {string} [opts.ageColorStyle] - 'mixed' (default) or 'latest'
   * @param {string} [opts.ageColorNew] - Hex colour
   * @param {string} [opts.ageColorOld] - Hex colour
   */
  renderTrail(opts) {
    const gl = this.gl;

    let read;
    let empty;
    if (opts.repeat && this._trailHasFrame) {
      read = this._trailPrev;
      empty = this._trailPrevEmpty;
    } else {
      read = this._trailCur;
      empty = this._trailEmpty;
      this._trailPrev = read;
      this._trailPrevEmpty = empty;
      this._trailCur = 1 - read;
    }
    const write = this._trailCur;

    // 8-bit ages cannot represent a step below one level; never let them stall.
    let ageStep = opts.ageStep;
    if (!this._trailAgesFloat && ageStep > 0) ageStep = Math.max(ageStep, 1 / 255);

    const { prog, u } = this._trailProg;
    gl.useProgram(prog);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this._trailPeaks[read]);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this._trailAgeTex[read]);
    gl.activeTexture(gl.TEXTURE2);
    gl.bindTexture(gl.TEXTURE_2D, this._diffTex);

    gl.uniform1i(u.uIsPosy, opts.isPosy ? 1 : 0);
    gl.uniform1i(u.uEmpty, empty ? 1 : 0);
    gl.uniform1f(u.uAgeStep, ageStep);
    gl.uniform1f(u.uHold, opts.hold);
    gl.uniform1f(u.uRefresh, opts.refresh);
    gl.uniform1i(u.uAgeColor, opts.ageColorEnabled ? 1 : 0);
    gl.uniform1i(u.uAgeMixed, opts.ageColorStyle === 'latest' ? 0 : 1);
    gl.uniform3fv(u.uAgeColorNew, hexToVec3(opts.ageColorNew, '#ff4400'));
    gl.uniform3fv(u.uAgeColorOld, hexToVec3(opts.ageColorOld, '#0044ff'));

    this._drawQuadTo(this._trailFB[write], this.width, this.height);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);

    this._trailEmpty = false;
    this._trailHasFrame = true;
  }

  /**
   * Read the trail image back as top-down RGBA rows. Dev parity probes only.
   * @returns {Uint8Array} width*height*4 bytes, row 0 at the top
   */
  readTrailPixels() {
    const gl = this.gl;
    const w = this.width;
    const h = this.height;
    const raw = new Uint8Array(w * h * 4);
    gl.bindFramebuffer(gl.FRAMEBUFFER, this._accumFB);
    gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, raw);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);

    const out = new Uint8Array(raw.length);
    for (let y = 0; y < h; y++) {
      out.set(raw.subarray((h - 1 - y) * w * 4, (h - y) * w * 4), y * w * 4);
    }
    return out;
  }

  /**
   * Run the composite shader. Output goes directly to canvas.
   * @param {string} mode - 'diff' | 'overlay' | 'glow'
   * @param {string} algorithm - 'posy' | 'raw'
   */
  renderComposite(mode, algorithm, ageColorEnabled) {
    const gl = this.gl;
    const { prog, u } = this._compositeProg;
    gl.useProgram(prog);

    // Bind accumulated diff
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this._accumTex);

    // Bind original frame
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this._curTex);

    let modeInt = 0;
    if (mode === 'overlay') modeInt = 1;
    else if (mode === 'glow') modeInt = 2;
    gl.uniform1i(u.uMode, modeInt);
    gl.uniform1i(u.uAlgorithm, algorithm === 'posy' ? 0 : 1);
    gl.uniform1i(u.uAgeColorEnabled, ageColorEnabled ? 1 : 0);

    // Draw to canvas (null framebuffer)
    this._drawQuadTo(null, this.width, this.height);
  }

  /**
   * Run the full magnify pass for the current frame: box-pool into float
   * (+ optional blur), update both EMA state textures, then composite
   * current + amp·band to the canvas.
   *
   * Magnify deliberately bypasses the diff/trail/composite programs —
   * their uAlgorithm uniform only distinguishes Posy from Raw, so a third
   * mode routed through them would silently render as Raw.
   *
   * @param {object} opts - { alphaFast, alphaSlow, amp, chroma, downsample, blurEnabled }
   * @returns {boolean} false when magnify is unavailable on this context
   */
  renderMagnify(opts) {
    const gl = this.gl;
    if (!this.magnifySupported) return false;

    const ds = Math.max(1, Math.floor(opts.downsample) || 1);
    const { width: w, height: h } = pooledSize(this.width, this.height, ds);
    if (!this._ensureMagResources(w, h)) return false;

    // 1. Pool the current frame: true ds x ds box mean into a float target
    gl.useProgram(this._boxPoolProg.prog);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this._curTex);
    gl.uniform1i(this._boxPoolProg.u.uFactor, ds);
    this._drawQuadTo(this._magFrameFB, w, h);
    let frameTex = this._magFrameTex;

    // 2. Optional pre-EMA box blur at the downsampled size
    if (opts.blurEnabled) {
      gl.useProgram(this._blurProg.prog);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, this._magFrameTex);
      gl.uniform1i(this._blurProg.u.uQuantize, 0);
      this._drawQuadTo(this._magBlurFB, w, h);
      frameTex = this._magBlurTex;
    }

    // 3. Seed both states with the current frame (never zero — that
    //    would flash bright and decay over seconds)
    if (this._magNeedsSeed) {
      gl.useProgram(this._copyProg.prog);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, frameTex);
      this._drawQuadTo(this._magFastFB[this._magStateRead], w, h);
      this._drawQuadTo(this._magSlowFB[this._magStateRead], w, h);
      this._magNeedsSeed = false;
    }

    // 4. EMA updates — one program, run twice with different alpha
    gl.useProgram(this._emaProg.prog);
    const uAlpha = this._emaProg.u.uAlpha;
    const read = this._magStateRead;
    const write = 1 - read;

    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, frameTex);
    gl.activeTexture(gl.TEXTURE0);

    gl.bindTexture(gl.TEXTURE_2D, this._magFastTex[read]);
    gl.uniform1f(uAlpha, opts.alphaFast);
    this._drawQuadTo(this._magFastFB[write], w, h);

    gl.bindTexture(gl.TEXTURE_2D, this._magSlowTex[read]);
    gl.uniform1f(uAlpha, opts.alphaSlow);
    this._drawQuadTo(this._magSlowFB[write], w, h);

    this._magStateRead = write;

    // 5. Composite to canvas: full-res current + upsampled amp·band
    const { prog, u } = this._magCompositeProg;
    gl.useProgram(prog);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this._curTex);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this._magFastTex[write]);
    gl.activeTexture(gl.TEXTURE2);
    gl.bindTexture(gl.TEXTURE_2D, this._magSlowTex[write]);
    gl.uniform1f(u.uAmp, opts.amp);
    gl.uniform1f(u.uChroma, opts.chroma);
    gl.uniform2f(u.uBandScale, this.width / (w * ds), this.height / (h * ds));

    this._drawQuadTo(null, this.width, this.height);

    // This frame's motion magnitude comes from the amplified band.
    this._magnitudeSource = 'band';
    this._magnitudeAmp = opts.amp;
    return true;
  }

  /**
   * Re-seed the EMA states from the next frame (source change, seek,
   * resize, or switching into magnify mode).
   */
  resetMagnifyState() {
    this._magNeedsSeed = true;
  }

  /**
   * A single-channel data texture: half float where renderable, RGBA8
   * otherwise. Only ever read with texelFetch, so no filtering is needed.
   */
  _createDataTexture(w, h, float = this._dataFloat) {
    const gl = this.gl;
    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    if (float) {
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA16F, w, h, 0, gl.RGBA, gl.HALF_FLOAT, null);
    } else {
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    }
    return tex;
  }

  /**
   * Fill the magnitude target for the frame just rendered, using the
   * program its mode registered through `_magnitudeSource`.
   * @returns {boolean} false when the frame has no motion measurement
   */
  /** (Re)allocate the data target, falling back to 8 bits if float will not complete. */
  _ensureMagnitudeTarget(w, h) {
    const gl = this.gl;
    if (w === this._magnitudeW && h === this._magnitudeH && this._magnitudeTex) return;
    this._cleanupTexFB(this._magnitudeTex, this._magnitudeFB);
    this._magnitudeTex = this._createDataTexture(w, h);
    this._magnitudeFB = createFramebuffer(gl, this._magnitudeTex);
    if (this._dataFloat && gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) {
      // Driver advertises float rendering but will not complete this
      // target: fall back to 8-bit for all data textures.
      this._dataFloat = false;
      this._cleanupTexFB(this._magnitudeTex, this._magnitudeFB);
      this._magnitudeTex = this._createDataTexture(w, h);
      this._magnitudeFB = createFramebuffer(gl, this._magnitudeTex);
      this._poolCols = 0;
    }
    this._magnitudeW = w;
    this._magnitudeH = h;
  }

  _renderMagnitude() {
    const gl = this.gl;
    const source = this._magnitudeSource;
    if (!source) return false;
    // A mode that draws its own data has already filled the target.
    if (source === 'filled') return true;

    const isBand = source === 'band';
    const w = isBand ? this._magW : this.width;
    const h = isBand ? this._magH : this.height;
    if (w <= 0 || h <= 0) return false;

    this._ensureMagnitudeTarget(w, h);

    if (isBand) {
      const { prog, u } = this._magnitudeBandProg;
      gl.useProgram(prog);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, this._magFastTex[this._magStateRead]);
      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D, this._magSlowTex[this._magStateRead]);
      gl.uniform1f(u.uAmp, this._magnitudeAmp);
    } else {
      const { prog, u } = this._magnitudeDiffProg;
      gl.useProgram(prog);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, this._diffTex);
      gl.uniform1i(u.uIsPosy, source === 'posy' ? 1 : 0);
    }
    this._drawQuadTo(this._magnitudeFB, w, h);
    return true;
  }

  /**
   * Pool the last frame's motion magnitude into a cols x rows grid — the
   * GPU-side counterpart of core/magnitude.js `poolMagnitude`, whatever mode
   * produced the frame.
   *
   * Nothing here runs unless a grid is asked for. The readback is tiny (8x4
   * is 32 texels) and every buffer is allocated once per grid size, so the
   * audio update path allocates nothing per frame.
   *
   * @param {number} cols
   * @param {number} rows
   * @returns {Float32Array|null} cols*rows magnitudes in 0..1, row-major, row
   *   0 at the top; null when the last frame has no motion measurement
   */
  readEnergyGrid(cols, rows) {
    const gl = this.gl;
    const nCols = Math.floor(cols);
    const nRows = Math.floor(rows);
    if (!gl || nCols < 1 || nRows < 1) return null;
    if (!this._renderMagnitude()) return null;

    const srcH = this._magnitudeH;
    if (nCols !== this._poolCols || nRows !== this._poolRows || srcH !== this._poolH) {
      this._cleanupTexFB(this._poolHTex, this._poolHFB);
      this._poolHTex = this._createDataTexture(nCols, srcH);
      this._poolHFB = createFramebuffer(gl, this._poolHTex);
      this._cleanupTexFB(this._poolTex, this._poolFB);
      this._poolTex = this._createDataTexture(nCols, nRows);
      this._poolFB = createFramebuffer(gl, this._poolTex);
      this._poolCols = nCols;
      this._poolRows = nRows;
      this._poolH = srcH;
      this._energyPixels = this._dataFloat
        ? new Float32Array(nCols * nRows * 4)
        : new Uint8Array(nCols * nRows * 4);
      this._energyGrid = new Float32Array(nCols * nRows);
    }

    const { prog, u } = this._poolProg;
    gl.useProgram(prog);
    gl.activeTexture(gl.TEXTURE0);

    // Columns first: (width x height) → (cols x height)
    gl.bindTexture(gl.TEXTURE_2D, this._magnitudeTex);
    gl.uniform1i(u.uVertical, 0);
    gl.uniform1i(u.uCells, nCols);
    this._drawQuadTo(this._poolHFB, nCols, srcH);

    // Then rows: (cols x height) → (cols x rows), top row first
    gl.bindTexture(gl.TEXTURE_2D, this._poolHTex);
    gl.uniform1i(u.uVertical, 1);
    gl.uniform1i(u.uCells, nRows);
    this._drawQuadTo(this._poolFB, nCols, nRows);

    const pixels = this._energyPixels;
    gl.readPixels(0, 0, nCols, nRows, gl.RGBA, this._dataFloat ? gl.FLOAT : gl.UNSIGNED_BYTE, pixels);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);

    const grid = this._energyGrid;
    const scale = this._dataFloat ? 1 : 1 / 255;
    for (let i = 0; i < grid.length; i++) {
      const value = pixels[i * 4] * scale;
      grid[i] = value > 1 ? 1 : value;
    }
    return grid;
  }

  // ── For mode modules (app/modes/) ───────────────────────────────

  /** Whether half-float render targets work here (feature-detected). */
  get floatTargets() {
    return this._dataFloat;
  }

  /** The current frame at the processing size (sampler2D). */
  get currentTexture() { return this._curTex; }

  /** Past frames (sampler2DArray); layers come from the pipeline's FrameRing. */
  get ringTexture() { return this._ringTex; }

  /**
   * Where a mode draws its picture when it wants the shared trail and
   * diff/overlay/glow compositing to follow: an RGBA8 image in Raw space
   * (0 = no motion) or Posy space (128 = no motion).
   */
  get diffFramebuffer() { return this._diffFB; }

  /**
   * A program compiled once per renderer and cached under `key`.
   * @param {string} key
   * @param {string} fragSrc - GLSL ES 3.00 fragment shader; gets `in vec2 vUV`
   * @param {Record<string, number>} [samplers] - sampler uniform → texture unit
   * @returns {{prog: WebGLProgram, u: Record<string, WebGLUniformLocation>}}
   */
  program(key, fragSrc, samplers) {
    let program = this._modePrograms.get(key);
    if (!program) {
      program = createProgram(this.gl, this._vertexShader, fragSrc, samplers);
      this._modePrograms.set(key, program);
    }
    return program;
  }

  /**
   * A render target owned by a mode, kept under `key` and rebuilt when the
   * size changes. `fresh` is true until the caller clears it (new or
   * rebuilt: its contents are undefined).
   *
   * @param {string} key
   * @param {number} width
   * @param {number} height
   * @param {{float?: boolean}} [options] - half float instead of RGBA8
   * @returns {{tex: WebGLTexture, fb: WebGLFramebuffer, width: number, height: number, fresh: boolean}}
   */
  target(key, width, height, options = {}) {
    let target = this._modeTargets.get(key);
    if (!target || target.width !== width || target.height !== height) {
      if (target) this._cleanupTexFB(target.tex, target.fb);
      const tex = options.float ? this._createDataTexture(width, height, true) : this._createSizedTexture(width, height);
      if (!options.float) {
        // Mode targets are read with texelFetch; keep them unfiltered.
        this.gl.texParameteri(this.gl.TEXTURE_2D, this.gl.TEXTURE_MIN_FILTER, this.gl.NEAREST);
        this.gl.texParameteri(this.gl.TEXTURE_2D, this.gl.TEXTURE_MAG_FILTER, this.gl.NEAREST);
      }
      target = { tex, fb: createFramebuffer(this.gl, tex), width, height, fresh: true };
      this._modeTargets.set(key, target);
    }
    return target;
  }

  /** Bind a texture to a unit: `array` for the frame ring. */
  bind(unit, texture, array = false) {
    const gl = this.gl;
    gl.activeTexture(gl.TEXTURE0 + unit);
    gl.bindTexture(array ? gl.TEXTURE_2D_ARRAY : gl.TEXTURE_2D, texture);
  }

  /** Draw the fullscreen quad with the program in use into a framebuffer (null = canvas). */
  draw(framebuffer, width = this.width, height = this.height) {
    this._drawQuadTo(framebuffer, width, height);
  }

  /**
   * The data target for a mode that fills it itself: draw one RGBA value per
   * pixel into the returned framebuffer (R = magnitude 0..1, G/B mode-specific)
   * before the frame ends. Built-in modes instead register a source that is
   * rendered lazily (see _renderMagnitude).
   *
   * @returns {WebGLFramebuffer}
   */
  dataFramebuffer(width = this.width, height = this.height) {
    this._ensureMagnitudeTarget(width, height);
    this._magnitudeSource = 'filled';
    return this._magnitudeFB;
  }

  /** Show the data target on the canvas (display mode 'data'). */
  renderDataView(kind) {
    if (!this._renderMagnitude()) return;
    const gl = this.gl;
    const { prog, u } = this._dataViewProg;
    gl.useProgram(prog);
    this.bind(0, this._magnitudeTex);
    gl.uniform1i(u.uVector, kind === 'vector' ? 1 : 0);
    this._drawQuadTo(null, this.width, this.height);
  }

  /**
   * Read the data target back: RGBA floats, row 0 at the top.
   * @returns {{width: number, height: number, values: Float32Array}|null}
   */
  readDataField() {
    if (!this._renderMagnitude()) return null;
    const gl = this.gl;
    const w = this._magnitudeW;
    const h = this._magnitudeH;
    const raw = this._dataFloat ? new Float32Array(w * h * 4) : new Uint8Array(w * h * 4);
    gl.bindFramebuffer(gl.FRAMEBUFFER, this._magnitudeFB);
    gl.readPixels(0, 0, w, h, gl.RGBA, this._dataFloat ? gl.FLOAT : gl.UNSIGNED_BYTE, raw);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);

    const values = new Float32Array(w * h * 4);
    const scale = this._dataFloat ? 1 : 1 / 255;
    for (let y = 0; y < h; y++) {
      const from = (h - 1 - y) * w * 4;
      const to = y * w * 4;
      for (let i = 0; i < w * 4; i++) values[to + i] = raw[from + i] * scale;
    }
    return { width: w, height: h, values };
  }

  /**
   * Render a fallback solid color when no diff data is available.
   * @param {string} algorithm - 'posy' | 'raw'
   */
  renderBlank(algorithm, ageColorEnabled) {
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, this.width, this.height);
    if (algorithm === 'posy' && !ageColorEnabled) {
      gl.clearColor(128 / 255, 128 / 255, 128 / 255, 1.0);
    } else {
      gl.clearColor(0.0, 0.0, 0.0, 1.0);
    }
    gl.clear(gl.COLOR_BUFFER_BIT);
    this._magnitudeSource = null;
  }

  /**
   * Clear the trail buffer (e.g. on video change). The magnify EMA
   * states re-seed on the same occasions.
   */
  clearTrails() {
    this._trailEmpty = true;
    this._trailHasFrame = false;
    this._magNeedsSeed = true;
    this._magnitudeSource = null;
  }

  /**
   * Clean up all GPU resources.
   */
  dispose() {
    const gl = this.gl;
    if (!gl) return;

    // Delete programs
    [this._diffProg, this._blurProg, this._trailProg, this._compositeProg,
     this._copyProg, this._boxPoolProg, this._emaProg, this._magCompositeProg, this._magnitudeDiffProg, this._magnitudeBandProg,
     this._poolProg].forEach(p => {
      if (p) gl.deleteProgram(p.prog);
    });

    // Delete textures
    [this._srcTex, this._curTex, this._ringTex,
     this._diffTex, this._blurTex, this._accumTex,
     ...this._trailPeaks, ...this._trailAgeTex,
     this._magFrameTex, this._magBlurTex,
     ...this._magFastTex, ...this._magSlowTex,
     this._magnitudeTex, this._poolHTex, this._poolTex].forEach(t => {
      if (t) gl.deleteTexture(t);
    });

    // Delete framebuffers
    [this._curFB, this._diffFB, this._blurFB, this._accumFB, ...this._trailFB,
     this._magFrameFB, this._magBlurFB,
     ...this._magFastFB, ...this._magSlowFB,
     this._magnitudeFB, this._poolHFB, this._poolFB].forEach(fb => {
      if (fb) gl.deleteFramebuffer(fb);
    });

    for (const program of this._modePrograms.values()) gl.deleteProgram(program.prog);
    for (const target of this._modeTargets.values()) this._cleanupTexFB(target.tex, target.fb);
    if (this._dataViewProg) gl.deleteProgram(this._dataViewProg.prog);
    if (this._vertexShader) gl.deleteShader(this._vertexShader);

    // VAO
    if (this._quadVAO) gl.deleteVertexArray(this._quadVAO);
  }
}

// ── Dev-only shader/core parity harness ─────────────────────────
// core/magnify.js is the source of truth; the magnify shaders must match
// it. Each case feeds the same synthetic sequence through the core pooled
// pipeline (boxPool → emaStep → addBand) and through the WebGL magnify path
// (readPixels) and reports the max per-channel difference (acceptance:
// < 3/255). The 1x case is also checked against magnifyFrame, the original
// single-resolution loop.

function parityFrames(W, H) {
  // Spatial ramps with a temporal wobble, plus a fine checker so pooling
  // has something to average.
  const frames = [];
  for (let k = 0; k < 3; k++) {
    const data = new Uint8ClampedArray(W * H * 4);
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const i = (y * W + x) * 4;
        const wobble = Math.round(6 * Math.sin((k / 3) * 2 * Math.PI + x * 0.5));
        const checker = ((x + y + k) & 1) * 9;
        data[i]     = Math.min(255, Math.max(0, 40 + x * 10 + wobble + checker));
        data[i + 1] = Math.min(255, Math.max(0, 60 + y * 14 - wobble));
        data[i + 2] = Math.min(255, Math.max(0, 128 + wobble * 2 - checker));
        data[i + 3] = 255;
      }
    }
    frames.push(new ImageData(data, W, H));
  }
  return frames;
}

export function runMagnifyParityHarness() {
  const AMP = 15;
  const CHROMA = 1.0;
  const ALPHA_FAST = 0.342; // ≈ emaAlpha(2.0 Hz, 1000/30 ms)
  const ALPHA_SLOW = 0.136; // ≈ emaAlpha(0.7 Hz, 1000/30 ms)
  const CASES = [
    { name: '1x 16x12', W: 16, H: 12, factor: 1 },
    { name: '2x 16x12', W: 16, H: 12, factor: 2 },
    { name: '4x 16x12', W: 16, H: 12, factor: 4 },
    { name: '4x 18x10 (partial blocks)', W: 18, H: 10, factor: 4 },
    { name: '2x 16x12 pre-EMA blur', W: 16, H: 12, factor: 2, blur: true },
  ];

  // GPU path on an isolated renderer instance.
  const canvas = document.createElement('canvas');
  const renderer = new WebGLRenderer(canvas);
  if (!renderer.magnifySupported) {
    renderer.dispose();
    return { supported: false, maxDiff: null, pass: false };
  }
  const useFullFloat = renderer._magUseFullFloat;
  const gl = renderer.gl;

  const cases = [];
  let magnitudeMaxDiff = 0;
  for (const { name, W, H, factor, blur = false } of CASES) {
    const frames = parityFrames(W, H);
    const grid = pooledSize(W, H, factor);

    // CPU reference — the exact steps the worker fallback runs.
    const pooled = new Float32Array(grid.width * grid.height * 4);
    const fast = new Float32Array(pooled.length);
    const slow = new Float32Array(pooled.length);
    const pool = (frame) => {
      boxPool(frame.data, W, H, factor, pooled);
      if (blur) boxBlurFloat(pooled, grid.width, grid.height);
      return pooled;
    };
    seedStatesFloat(pool(frames[0]), fast, slow);
    const cpuOut = frames.map((frame) => {
      const out = new Uint8ClampedArray(W * H * 4);
      emaStep(pool(frame), fast, slow, ALPHA_FAST, ALPHA_SLOW);
      addBand(frame.data, W, H, fast, slow, factor, AMP, CHROMA, out);
      return out;
    });

    // At 1x the pooled pipeline must also agree with magnifyFrame.
    let legacyDiff = 0;
    if (factor === 1) {
      const legacyFast = new Float32Array(W * H * 4);
      const legacySlow = new Float32Array(W * H * 4);
      seedStates(frames[0].data, legacyFast, legacySlow);
      frames.forEach((frame, k) => {
        const out = new Uint8ClampedArray(W * H * 4);
        magnifyFrame(frame.data, legacyFast, legacySlow, out, ALPHA_FAST, ALPHA_SLOW, AMP, CHROMA);
        for (let i = 0; i < out.length; i++) legacyDiff = Math.max(legacyDiff, Math.abs(out[i] - cpuOut[k][i]));
      });
    }

    renderer.setSize(W, H, 2);
    renderer.resetMagnifyState();
    const px = new Uint8Array(W * H * 4);
    let maxDiff = legacyDiff;
    for (let k = 0; k < frames.length; k++) {
      renderer.uploadPixels(frames[k]);
      renderer.renderMagnify({
        alphaFast: ALPHA_FAST,
        alphaSlow: ALPHA_SLOW,
        amp: AMP,
        chroma: CHROMA,
        downsample: factor,
        blurEnabled: blur,
      });
      gl.readPixels(0, 0, W, H, gl.RGBA, gl.UNSIGNED_BYTE, px);

      // readPixels rows come back bottom-up relative to the image.
      for (let y = 0; y < H; y++) {
        const gpuRow = (H - 1 - y) * W * 4;
        const cpuRow = y * W * 4;
        for (let b = 0; b < W * 4; b++) {
          if ((b & 3) === 3) continue; // alpha
          const d = Math.abs(px[gpuRow + b] - cpuOut[k][cpuRow + b]);
          if (d > maxDiff) maxDiff = d;
        }
      }
    }
    cases.push({ name, maxDiff });

    // The magnify mode's contribution to the shared motion magnitude: the
    // GPU grid for the last frame against core bandMagnitude + poolMagnitude.
    const coreGrid = poolMagnitude(
      bandMagnitude(fast, slow, AMP, new Float32Array(grid.width * grid.height)),
      grid.width, grid.height, 2, 2,
    );
    const gpuGrid = renderer.readEnergyGrid(2, 2);
    if (!gpuGrid) magnitudeMaxDiff = Infinity;
    for (let i = 0; gpuGrid && i < coreGrid.length; i++) {
      magnitudeMaxDiff = Math.max(magnitudeMaxDiff, Math.abs(coreGrid[i] - gpuGrid[i]));
    }
  }

  renderer.dispose();
  const maxDiff = Math.max(...cases.map((c) => c.maxDiff));
  return {
    supported: true,
    useFullFloat,
    maxDiff,
    cases,
    magnitudeMaxDiff,
    pass: maxDiff < 3 && magnitudeMaxDiff < 0.05,
  };
}

if (import.meta.env.DEV && typeof window !== 'undefined') {
  window.__magnifyParityHarness = runMagnifyParityHarness;
}
