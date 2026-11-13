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
 *   - Trail accumulation (max-deviation merge across trail frames)
 *   - Composite (diff / overlay / glow modes)
 *   - Magnify (EMA update + add-back)
 */

import { magnifyFrame, seedStates } from '../core/magnify.js';

// ── Shader sources ──────────────────────────────────────────────

const VERT_SRC = `#version 300 es
in vec2 aPosition;
out vec2 vUV;
void main() {
  vUV = aPosition * 0.5 + 0.5;
  gl_Position = vec4(aPosition, 0.0, 1.0);
}`;

const DIFF_FRAG = `#version 300 es
precision highp float;

precision highp sampler2DArray;

uniform sampler2D uCurrent;
uniform sampler2DArray uRing;
uniform vec3 uLayers;       // ring layers compared by the R, G and B channels
uniform vec3 uTintR;
uniform vec3 uTintG;
uniform vec3 uTintB;
uniform float uThreshold;   // 0-60 mapped to 0.0-0.235
uniform int uAlgorithm;     // 0 = Posy, 1 = Raw Diff

in vec2 vUV;
out vec4 fragColor;

void main() {
  vec4 cur = texture(uCurrent, vUV);
  vec4 oldR = texture(uRing, vec3(vUV, uLayers.x));
  vec4 oldG = texture(uRing, vec3(vUV, uLayers.y));
  vec4 oldB = texture(uRing, vec3(vUV, uLayers.z));

  float tintSumR = max(dot(uTintR, vec3(1.0)), 0.0001);
  float tintSumG = max(dot(uTintG, vec3(1.0)), 0.0001);
  float tintSumB = max(dot(uTintB, vec3(1.0)), 0.0001);
  vec3 old = vec3(
    dot(oldR.rgb, uTintR / tintSumR),
    dot(oldG.rgb, uTintG / tintSumG),
    dot(oldB.rgb, uTintB / tintSumB)
  );

  vec3 result;
  float mag;

  if (uAlgorithm == 0) {
    // Posy: (current + invert(old) + 1/255) / 2
    // The +1/255 matches the CPU +1 before >>1 for rounding
    result = (cur.rgb + (1.0 - old) + (1.0 / 255.0)) * 0.5;
    mag = (abs(result.r - 0.5) + abs(result.g - 0.5) +
           abs(result.b - 0.5)) / 3.0;
    if (mag < uThreshold) result = vec3(0.5);
  } else {
    // Raw diff
    result = abs(cur.rgb - old);
    mag = (result.r + result.g + result.b) / 3.0;
    if (mag < uThreshold) result = vec3(0.0);
  }

  fragColor = vec4(result, 1.0);
}`;

const BLUR_FRAG = `#version 300 es
precision highp float;

uniform sampler2D uInput;
uniform vec2 uTexelSize;  // 1.0/width, 1.0/height

in vec2 vUV;
out vec4 fragColor;

void main() {
  vec3 sum = vec3(0.0);
  for (int dy = -1; dy <= 1; dy++) {
    for (int dx = -1; dx <= 1; dx++) {
      vec2 offset = vec2(float(dx), float(dy)) * uTexelSize;
      sum += texture(uInput, vUV + offset).rgb;
    }
  }
  fragColor = vec4(sum / 9.0, 1.0);
}`;

// Mean-downsample for the sonification energy readback. Rendering the diff
// texture into a cols x rows target is a huge minification, so the sampler's
// own LOD selection lands deep in the mip chain — each output texel ends up a
// box average of roughly its cell, which is what cellEnergies computes on the
// CPU. Exact equality is not required (see SPEC-sonification A6).
const DOWNSAMPLE_FRAG = `#version 300 es
precision highp float;

uniform sampler2D uInput;

in vec2 vUV;
out vec4 fragColor;

void main() {
  fragColor = vec4(texture(uInput, vUV).rgb, 1.0);
}`;

// Two-input accumulation: merges "current best" with "next trail frame".
// Called iteratively from JS — one draw call per trail frame.
const ACCUM_FRAG = `#version 300 es
precision highp float;

uniform sampler2D uAccum;   // current accumulated result (or base fill)
uniform sampler2D uTrail;   // next trail frame to merge
uniform int uIsPosy;        // 1 = posy, 0 = raw
uniform int uIsFirst;       // 1 = first pass (use base fill), 0 = read uAccum
uniform int uAgeColorEnabled;
uniform int uTrailIndex;
uniform float uTrailAge[20];
uniform float uThreshold;
uniform vec3 uAgeColorNew;
uniform vec3 uAgeColorOld;

in vec2 vUV;
out vec4 fragColor;

void main() {
  float baseVal = (uIsPosy == 1 && uAgeColorEnabled == 0) ? 0.5 : 0.0;
  vec3 best;
  if (uIsFirst == 1) {
    best = vec3(baseVal);
  } else {
    best = texture(uAccum, vUV).rgb;
  }

  vec3 s = texture(uTrail, vUV).rgb;

  if (uIsPosy == 1 && uAgeColorEnabled == 1) {
    float age = uTrailAge[uTrailIndex];
    float motionMagnitude = (
      abs(s.r - 0.5) +
      abs(s.g - 0.5) +
      abs(s.b - 0.5)
    ) / 1.5;
    vec3 ageColor = mix(uAgeColorNew, uAgeColorOld, age);
    vec3 tinted = motionMagnitude > uThreshold ? ageColor * motionMagnitude : vec3(0.0);
    best = max(best, tinted);
  } else if (uIsPosy == 1) {
    // Max deviation from 0.5 per channel
    vec3 bestDev = abs(best - 0.5);
    vec3 srcDev = abs(s - 0.5);
    if (srcDev.r > bestDev.r) best.r = s.r;
    if (srcDev.g > bestDev.g) best.g = s.g;
    if (srcDev.b > bestDev.b) best.b = s.b;
  } else {
    // Max raw value per channel
    best = max(best, s);
  }

  fragColor = vec4(best, 1.0);
}`;

// Plain copy — scales the uploaded video frame to the processing size,
// downsamples the current frame into the magnify working size and seeds
// the EMA state textures.
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
// Rec.709 luma/chroma split. The float states sit at the downsampled
// size; linear texture sampling performs the upsample for free.
// Mirrors core/magnify.js magnifyPixel exactly, including clamping.
const MAG_COMPOSITE_FRAG = `#version 300 es
precision highp float;

uniform sampler2D uCurrent;
uniform sampler2D uFast;
uniform sampler2D uSlow;
uniform float uAmp;
uniform float uChroma;

in vec2 vUV;
out vec4 fragColor;

const vec3 LUMA = vec3(0.2126, 0.7152, 0.0722);

void main() {
  vec3 cur = texture(uCurrent, vUV).rgb;
  vec3 band = texture(uFast, vUV).rgb - texture(uSlow, vUV).rgb;
  float bandLuma = dot(band, LUMA);
  vec3 result = cur + uAmp * bandLuma + uAmp * uChroma * (band - vec3(bandLuma));
  fragColor = vec4(clamp(result, 0.0, 1.0), 1.0);
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
      mot = min(vec3(1.0), abs(diff - 0.5) * 4.0);
    } else {
      mot = min(vec3(1.0), diff * 2.0);
    }
    // screen(a, b) = 1 - (1-a)*(1-b)
    result = 1.0 - (1.0 - orig) * (1.0 - mot);
  } else {
    // Glow: additive blend
    vec3 mot;
    if (uAlgorithm == 0 && uAgeColorEnabled == 0) {
      mot = min(vec3(1.0), abs(diff - 0.5) * 6.0);
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

const MAX_TRAILS = 20;

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
  constructor(canvas) {
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
    this._accumProg = null;
    this._compositeProg = null;
    this._downsampleProg = null;

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

    // Trail textures (ring of framebuffers)
    this._trailAges = new Float32Array(MAX_TRAILS);
    this._trailTextures = [];
    this._trailFBs = [];
    this._trailHead = -1;
    this._trailSize = 0;

    // Intermediate framebuffers
    this._diffTex = null;
    this._diffFB = null;
    this._blurTex = null;
    this._blurFB = null;
    this._accumTex = null;
    this._accumFB = null;
    // Ping-pong buffer for iterative accumulation
    this._accumTex2 = null;
    this._accumFB2 = null;

    // ── Magnify resources (allocated lazily at the downsampled size) ──
    this._copyProg = null;
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
    // Energy readback target (cols x rows) + preallocated scratch
    this._energyTex = null;
    this._energyFB = null;
    this._energyCols = 0;
    this._energyRows = 0;
    this._energyBytes = null;
    this._energyGrid = null;
    this._energyIsPosy = true;

    this._init();
  }

  _init() {
    const gl = this.gl;

    // ── Compile shader programs ──
    const vs = compileShader(gl, gl.VERTEX_SHADER, VERT_SRC);

    this._diffProg = createProgram(gl, vs, DIFF_FRAG, { uCurrent: 0, uRing: 1 });
    this._blurProg = createProgram(gl, vs, BLUR_FRAG, { uInput: 0 });
    this._accumProg = createProgram(gl, vs, ACCUM_FRAG, { uAccum: 0, uTrail: 1 });
    this._compositeProg = createProgram(gl, vs, COMPOSITE_FRAG, { uDiff: 0, uOriginal: 1 });
    this._copyProg = createProgram(gl, vs, COPY_FRAG, { uInput: 0 });
    this._emaProg = createProgram(gl, vs, EMA_FRAG, { uState: 0, uFrame: 1 });
    this._magCompositeProg = createProgram(gl, vs, MAG_COMPOSITE_FRAG, { uCurrent: 0, uFast: 1, uSlow: 2 });
    this._downsampleProg = createProgram(gl, vs, DOWNSAMPLE_FRAG, { uInput: 0 });

    // The programs keep their own reference to the linked vertex shader.
    gl.deleteShader(vs);

    // ── Magnify float-texture support ──
    // EMA states need render-to-float. Prefer RGBA32F (only when its
    // linear filtering extension is present — the upsample relies on it);
    // otherwise RGBA16F, which WebGL2 filters natively and which either
    // color-buffer extension makes renderable. With neither extension,
    // magnify mode is unavailable on the WebGL path.
    const extFloat = gl.getExtension('EXT_color_buffer_float');
    const extHalf = extFloat ? null : gl.getExtension('EXT_color_buffer_half_float');
    const extFloatLinear = gl.getExtension('OES_texture_float_linear');
    this.magnifySupported = Boolean(extFloat || extHalf);
    this._magUseFullFloat = Boolean(extFloat && extFloatLinear);

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

    // Accumulation output (ping-pong pair)
    this._cleanupTexFB(this._accumTex, this._accumFB);
    this._accumTex = this._createSizedTexture(width, height);
    this._accumFB = createFramebuffer(gl, this._accumTex);

    this._cleanupTexFB(this._accumTex2, this._accumFB2);
    this._accumTex2 = this._createSizedTexture(width, height);
    this._accumFB2 = createFramebuffer(gl, this._accumTex2);

    // ── Trail ring buffer (re-create all) ──
    for (let i = 0; i < this._trailTextures.length; i++) {
      this._cleanupTexFB(this._trailTextures[i], this._trailFBs[i]);
    }
    this._trailTextures = [];
    this._trailFBs = [];
    for (let i = 0; i < MAX_TRAILS; i++) {
      const tex = this._createSizedTexture(width, height);
      const fb = createFramebuffer(gl, tex);
      this._trailTextures.push(tex);
      this._trailFBs.push(fb);
    }
    this._trailHead = -1;
    this._trailSize = 0;
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

    this._cleanupTexFB(this._magFrameTex, this._magFrameFB);
    this._magFrameTex = this._createSizedTexture(w, h);
    this._magFrameFB = createFramebuffer(gl, this._magFrameTex);

    this._cleanupTexFB(this._magBlurTex, this._magBlurFB);
    this._magBlurTex = this._createSizedTexture(w, h);
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
    // threshold: 0-60 in UI → normalize to 0.0-0.235 range (60/255 ≈ 0.235)
    gl.uniform1f(u.uThreshold, params.threshold / 255.0);
    gl.uniform1i(u.uAlgorithm, params.algorithm === 'posy' ? 0 : 1);
    // Remembered so readEnergyGrid knows which baseline the diff texture uses.
    this._energyIsPosy = params.algorithm === 'posy';
    gl.uniform3fv(u.uTintR, hexToVec3(params.rgbTintR, '#ff0000'));
    gl.uniform3fv(u.uTintG, hexToVec3(params.rgbTintG, '#00ff00'));
    gl.uniform3fv(u.uTintB, hexToVec3(params.rgbTintB, '#0000ff'));

    this._drawQuadTo(this._diffFB, this.width, this.height);
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
    gl.uniform2f(u.uTexelSize, 1.0 / this.width, 1.0 / this.height);

    this._drawQuadTo(this._blurFB, this.width, this.height);

    // Copy blur result back to diff texture (blit)
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, this._blurFB);
    gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, this._diffFB);
    gl.blitFramebuffer(0, 0, this.width, this.height, 0, 0, this.width, this.height, gl.COLOR_BUFFER_BIT, gl.NEAREST);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }

  /**
   * Push the current diff result into the trail ring buffer.
   * Copies from _diffTex to the next trail slot.
   */
  pushTrail() {
    this._trailHead = (this._trailHead + 1) % MAX_TRAILS;
    if (this._trailSize < MAX_TRAILS) this._trailSize++;
    this._writeTrailHead();
  }

  /**
   * Overwrite the newest trail entry with the current diff result — for
   * re-rendering the same frame (a parameter change while paused), which
   * must not add a duplicate to the trail.
   */
  replaceTrail() {
    if (this._trailSize === 0) {
      this.pushTrail();
      return;
    }
    this._writeTrailHead();
  }

  _writeTrailHead() {
    const gl = this.gl;

    // Blit diff → trail slot
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, this._diffFB);
    gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, this._trailFBs[this._trailHead]);
    gl.blitFramebuffer(0, 0, this.width, this.height, 0, 0, this.width, this.height, gl.COLOR_BUFFER_BIT, gl.NEAREST);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }

  /**
   * Run the trail accumulation via iterative ping-pong.
   * For each trail frame, merge it with the running accumulated result.
   * The final result ends up in _accumTex/_accumFB.
   * @param {number} trailLength - How many trail frames to merge
   * @param {boolean} isPosy
   */
  renderAccumulate(trailLength, isPosy, threshold, ageColorEnabled, ageColorNew, ageColorOld) {
    const gl = this.gl;
    const { prog, u } = this._accumProg;
    gl.useProgram(prog);

    const T = Math.min(trailLength, this._trailSize);
    if (T === 0) return;

    const {
      uIsPosy, uIsFirst, uAgeColorEnabled, uTrailIndex, uTrailAge,
      uThreshold, uAgeColorNew, uAgeColorOld,
    } = u;

    gl.uniform1i(uIsPosy, isPosy ? 1 : 0);
    gl.uniform1i(uAgeColorEnabled, ageColorEnabled ? 1 : 0);
    gl.uniform1f(uThreshold, threshold / 255.0);
    gl.uniform3fv(uAgeColorNew, hexToVec3(ageColorNew, '#ff4400'));
    gl.uniform3fv(uAgeColorOld, hexToVec3(ageColorOld, '#0044ff'));
    gl.bindVertexArray(this._quadVAO);

    const ages = this._trailAges;
    ages.fill(0);
    for (let i = 0; i < T; i++) {
      ages[i] = T <= 1 ? 0 : i / (T - 1);
    }
    gl.uniform1fv(uTrailAge, ages);

    // Ping-pong between _accumFB and _accumFB2
    // Read from A, write to B, then swap
    let readTex = this._accumTex;   // "current best" texture
    let readFB = this._accumFB;
    let writeTex = this._accumTex2;
    let writeFB = this._accumFB2;

    for (let i = 0; i < T; i++) {
      const trailIdx = (this._trailHead - i + MAX_TRAILS) % MAX_TRAILS;

      // Bind accumulated-so-far on unit 0
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, readTex);

      // Bind this trail frame on unit 1
      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D, this._trailTextures[trailIdx]);

      // On first pass, tell shader to use base fill instead of reading uAccum
      gl.uniform1i(uIsFirst, i === 0 ? 1 : 0);
      gl.uniform1i(uTrailIndex, i);

      // Render to the write FB
      gl.bindFramebuffer(gl.FRAMEBUFFER, writeFB);
      gl.viewport(0, 0, this.width, this.height);
      gl.drawArrays(gl.TRIANGLES, 0, 6);

      // Swap ping-pong
      const tmpTex = readTex;
      const tmpFB = readFB;
      readTex = writeTex;
      readFB = writeFB;
      writeTex = tmpTex;
      writeFB = tmpFB;
    }

    // After the loop, the final result is in readTex/readFB.
    // We need it in _accumTex/_accumFB for the composite step.
    // If it's already there, great. If not, blit.
    if (readTex !== this._accumTex) {
      // The result ended up in _accumTex2 — blit to _accumTex
      gl.bindFramebuffer(gl.READ_FRAMEBUFFER, readFB);
      gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, this._accumFB);
      gl.blitFramebuffer(0, 0, this.width, this.height, 0, 0, this.width, this.height, gl.COLOR_BUFFER_BIT, gl.NEAREST);
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
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
   * Run the full magnify pass for the frame already uploaded to the
   * 'current' slot: downsample (+ optional blur), update both EMA state
   * textures, then composite current + amp·band to the canvas.
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

    const ds = opts.downsample || 1;
    const w = Math.max(1, Math.round(this.width / ds));
    const h = Math.max(1, Math.round(this.height / ds));
    if (!this._ensureMagResources(w, h)) return false;

    // 1. Downsample the current frame (linear sampling = spatial pooling)
    gl.useProgram(this._copyProg.prog);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this._curTex);
    this._drawQuadTo(this._magFrameFB, w, h);
    let frameTex = this._magFrameTex;

    // 2. Optional pre-EMA box blur at the downsampled size
    if (opts.blurEnabled) {
      gl.useProgram(this._blurProg.prog);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, this._magFrameTex);
      gl.uniform2f(this._blurProg.u.uTexelSize, 1.0 / w, 1.0 / h);
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

    this._drawQuadTo(null, this.width, this.height);
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
   * Downsample the current diff texture (post threshold and blur, pre
   * composite) into a cols x rows grid of normalized motion energies — the
   * GPU-side counterpart of core/energy.js `cellEnergies`.
   *
   * The readback is tiny (8x4 is 128 bytes) and every buffer is allocated once
   * per grid size, so the audio update path allocates nothing per frame.
   *
   * @param {number} cols
   * @param {number} rows
   * @returns {Float32Array|null} cols*rows energies in 0..1, row-major
   */
  readEnergyGrid(cols, rows) {
    const gl = this.gl;
    const nCols = Math.floor(cols);
    const nRows = Math.floor(rows);
    if (!gl || !this._diffTex || nCols < 1 || nRows < 1) return null;
    if (this.width <= 0 || this.height <= 0) return null;

    if (nCols !== this._energyCols || nRows !== this._energyRows) {
      this._cleanupTexFB(this._energyTex, this._energyFB);
      this._energyTex = this._createSizedTexture(nCols, nRows);
      this._energyFB = createFramebuffer(gl, this._energyTex);
      this._energyCols = nCols;
      this._energyRows = nRows;
      this._energyBytes = new Uint8Array(nCols * nRows * 4);
      this._energyGrid = new Float32Array(nCols * nRows);
    }

    // A mip chain is what turns this extreme minification into a box mean
    // instead of a point sample of one texel per cell.
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this._diffTex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
    gl.generateMipmap(gl.TEXTURE_2D);

    gl.useProgram(this._downsampleProg.prog);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this._diffTex);

    gl.bindFramebuffer(gl.FRAMEBUFFER, this._energyFB);
    gl.viewport(0, 0, nCols, nRows);
    gl.bindVertexArray(this._quadVAO);
    gl.drawArrays(gl.TRIANGLES, 0, 6);

    gl.readPixels(0, 0, nCols, nRows, gl.RGBA, gl.UNSIGNED_BYTE, this._energyBytes);

    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, this.width, this.height);
    // Every other pass samples the diff texture at LOD 0 — put the filter back.
    gl.bindTexture(gl.TEXTURE_2D, this._diffTex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);

    const baseline = this._energyIsPosy ? 128 : 0;
    const range = this._energyIsPosy ? 127 : 255;
    const bytes = this._energyBytes;
    const grid = this._energyGrid;

    for (let i = 0; i < grid.length; i++) {
      // Frames are uploaded flipped, so readPixels row 0 is the bottom of the
      // frame. Re-flip to match cellEnergies, whose row 0 is the top.
      const srcRow = nRows - 1 - ((i / nCols) | 0);
      const src = (srcRow * nCols + (i % nCols)) * 4;
      const mag = (
        Math.abs(bytes[src] - baseline) +
        Math.abs(bytes[src + 1] - baseline) +
        Math.abs(bytes[src + 2] - baseline)
      ) / 3;
      grid[i] = Math.min(1, mag / range);
    }

    return grid;
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
      gl.clearColor(0.5, 0.5, 0.5, 1.0);
    } else {
      gl.clearColor(0.0, 0.0, 0.0, 1.0);
    }
    gl.clear(gl.COLOR_BUFFER_BIT);
  }

  /**
   * Clear the trail buffer (e.g. on video change). The magnify EMA
   * states re-seed on the same occasions.
   */
  clearTrails() {
    this._trailHead = -1;
    this._trailSize = 0;
    this._magNeedsSeed = true;
  }

  /**
   * Clean up all GPU resources.
   */
  dispose() {
    const gl = this.gl;
    if (!gl) return;

    // Delete programs
    [this._diffProg, this._blurProg, this._accumProg, this._compositeProg,
     this._copyProg, this._emaProg, this._magCompositeProg, this._downsampleProg].forEach(p => {
      if (p) gl.deleteProgram(p.prog);
    });

    // Delete textures
    [this._srcTex, this._curTex, this._ringTex,
     this._diffTex, this._blurTex, this._accumTex, this._accumTex2,
     this._magFrameTex, this._magBlurTex,
     ...this._magFastTex, ...this._magSlowTex, this._energyTex].forEach(t => {
      if (t) gl.deleteTexture(t);
    });

    // Delete framebuffers
    [this._curFB, this._diffFB, this._blurFB, this._accumFB, this._accumFB2,
     this._magFrameFB, this._magBlurFB,
     ...this._magFastFB, ...this._magSlowFB, this._energyFB].forEach(fb => {
      if (fb) gl.deleteFramebuffer(fb);
    });

    // Delete trail resources
    for (let i = 0; i < this._trailTextures.length; i++) {
      if (this._trailTextures[i]) gl.deleteTexture(this._trailTextures[i]);
      if (this._trailFBs[i]) gl.deleteFramebuffer(this._trailFBs[i]);
    }

    // VAO
    if (this._quadVAO) gl.deleteVertexArray(this._quadVAO);
  }
}

// ── Dev-only shader/core parity harness ─────────────────────────
// core/magnify.js is the source of truth; the magnify shaders must match
// it. Feeds the same 3-frame synthetic sequence through magnifyFrame and
// through the WebGL magnify path (readPixels) and reports the max
// per-channel difference (acceptance: < 3/255).

export function runMagnifyParityHarness() {
  const W = 16;
  const H = 12;
  const AMP = 15;
  const CHROMA = 1.0;
  const ALPHA_FAST = 0.342; // ≈ emaAlpha(2.0 Hz, 1000/30 ms)
  const ALPHA_SLOW = 0.136; // ≈ emaAlpha(0.7 Hz, 1000/30 ms)

  // Synthetic sequence: spatial ramps with a temporal wobble.
  const frames = [];
  for (let k = 0; k < 3; k++) {
    const data = new Uint8ClampedArray(W * H * 4);
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const i = (y * W + x) * 4;
        const wobble = Math.round(6 * Math.sin((k / 3) * 2 * Math.PI + x * 0.5));
        data[i]     = Math.min(255, Math.max(0, 40 + x * 12 + wobble));
        data[i + 1] = Math.min(255, Math.max(0, 60 + y * 14 - wobble));
        data[i + 2] = Math.min(255, Math.max(0, 128 + wobble * 2));
        data[i + 3] = 255;
      }
    }
    frames.push(new ImageData(data, W, H));
  }

  // CPU reference — the exact loop the worker fallback runs.
  const fast = new Float32Array(W * H * 4);
  const slow = new Float32Array(W * H * 4);
  seedStates(frames[0].data, fast, slow);
  const cpuOut = frames.map(() => new Uint8ClampedArray(W * H * 4));
  for (let k = 0; k < 3; k++) {
    magnifyFrame(frames[k].data, fast, slow, cpuOut[k], ALPHA_FAST, ALPHA_SLOW, AMP, CHROMA);
  }

  // GPU path on an isolated renderer instance.
  const canvas = document.createElement('canvas');
  const renderer = new WebGLRenderer(canvas);
  if (!renderer.magnifySupported) {
    renderer.dispose();
    return { supported: false, maxDiff: null, pass: false };
  }
  renderer.setSize(W, H);
  renderer.resetMagnifyState();
  const useFullFloat = renderer._magUseFullFloat;

  const gl = renderer.gl;
  const px = new Uint8Array(W * H * 4);
  let maxDiff = 0;
  for (let k = 0; k < 3; k++) {
    renderer.uploadPixels(frames[k]);
    renderer.renderMagnify({
      alphaFast: ALPHA_FAST,
      alphaSlow: ALPHA_SLOW,
      amp: AMP,
      chroma: CHROMA,
      downsample: 1,
      blurEnabled: false,
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
  renderer.dispose();
  return { supported: true, useFullFloat, maxDiff, pass: maxDiff < 3 };
}

if (import.meta.env.DEV && typeof window !== 'undefined') {
  window.__magnifyParityHarness = runMagnifyParityHarness;
}
