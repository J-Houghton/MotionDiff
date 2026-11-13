/**
 * Motion mask: marks what is moving, once, where it is now.
 *
 * Causal three-frame differencing (core/mask.js is the source of truth; the
 * two shaders here mirror it in whole 0..255 numbers):
 *
 *   1. box-blur the current frame and two older ones, take the smaller of
 *      the two differences, threshold it            → raw mask + strength
 *   2. 3x3 majority vote                            → mask
 *
 * The picture is the current frame cut out by the mask (or the mask itself),
 * drawn in Raw space so the shared trail and diff / overlay / glow follow.
 * The data output is the mask.
 */
import { lookbackTime } from '../../core/timebase.js';
import { TRAIL_HOLD, TRAIL_REFRESH } from '../../core/trails.js';
import { MASK_VOTES } from '../../core/mask.js';
import { GAP, THRESHOLD, TRAIL, asMs } from './params.js';

// Pass 1. Mirrors boxBlur (core/blur.js) on each frame, then
// threeFrameDifference and thresholdMask (core/mask.js).
// Output: R = raw decision (0 or 1), G = the smaller difference / 765.
const DIFFERENCE_FRAG = `#version 300 es
precision highp float;
precision highp sampler2DArray;

uniform sampler2D uCurrent;
uniform sampler2DArray uRing;
uniform ivec2 uLayers;      // ring layers of the two older frames
uniform float uThreshold;   // mean channel difference, 0..255
uniform int uBlur;          // 1 = 3x3 box blur before differencing

out vec4 fragColor;

vec3 current(ivec2 q) { return floor(texelFetch(uCurrent, q, 0).rgb * 255.0 + 0.5); }
vec3 older(ivec2 q, int layer) { return floor(texelFetch(uRing, ivec3(q, layer), 0).rgb * 255.0 + 0.5); }

void main() {
  ivec2 size = textureSize(uCurrent, 0);
  ivec2 p = ivec2(gl_FragCoord.xy);
  vec3 c;
  vec3 a;
  vec3 b;
  if (uBlur == 1) {
    vec3 sumC = vec3(0.0);
    vec3 sumA = vec3(0.0);
    vec3 sumB = vec3(0.0);
    float count = 0.0;
    for (int dy = -1; dy <= 1; dy++) {
      for (int dx = -1; dx <= 1; dx++) {
        ivec2 q = p + ivec2(dx, dy);
        if (q.x < 0 || q.y < 0 || q.x >= size.x || q.y >= size.y) continue;
        sumC += current(q);
        sumA += older(q, uLayers.x);
        sumB += older(q, uLayers.y);
        count += 1.0;
      }
    }
    // Rounded to whole values, like boxBlur.
    c = floor(sumC / count + 0.5);
    a = floor(sumA / count + 0.5);
    b = floor(sumB / count + 0.5);
  } else {
    c = current(p);
    a = older(p, uLayers.x);
    b = older(p, uLayers.y);
  }
  vec3 d1 = abs(c - a);
  vec3 d2 = abs(c - b);
  float difference = min(d1.r + d1.g + d1.b, d2.r + d2.g + d2.b); // channel sum, 0..765
  float moving = (difference > 0.0 && difference >= uThreshold * 3.0) ? 1.0 : 0.0;
  fragColor = vec4(moving, difference / 765.0, 0.0, 1.0);
}`;

// Pass 2. Mirrors majority3x3 (core/mask.js), then writes either the picture
// (Raw space) or the data field.
const OUTPUT_FRAG = `#version 300 es
precision highp float;

uniform sampler2D uMask;    // pass 1
uniform sampler2D uCurrent;
uniform int uClean;         // 0 = as it is, else the votes a pixel needs of its 3x3 cells
uniform int uOutput;        // 0 = cut-out of the current frame, 1 = solid mask, 2 = data

out vec4 fragColor;

void main() {
  ivec2 size = textureSize(uMask, 0);
  ivec2 p = ivec2(gl_FragCoord.xy);
  vec4 here = texelFetch(uMask, p, 0);
  float moving = here.r > 0.5 ? 1.0 : 0.0;
  if (uClean > 0) {
    float votes = 0.0;
    for (int dy = -1; dy <= 1; dy++) {
      for (int dx = -1; dx <= 1; dx++) {
        ivec2 q = p + ivec2(dx, dy);
        if (q.x < 0 || q.y < 0 || q.x >= size.x || q.y >= size.y) continue;
        votes += texelFetch(uMask, q, 0).r > 0.5 ? 1.0 : 0.0;
      }
    }
    moving = votes >= float(uClean) ? 1.0 : 0.0;
  }
  if (uOutput == 2) fragColor = vec4(moving, here.g, 0.0, 1.0);
  else if (uOutput == 1) fragColor = vec4(vec3(moving), 1.0);
  else fragColor = vec4(texelFetch(uCurrent, p, 0).rgb * moving, 1.0);
}`;

/**
 * Pass 1 for the frame in the renderer's current texture.
 *
 * @param {object} renderer - WebGLRenderer
 * @param {object} opts
 * @param {number[]} opts.layers - Ring layers of the two older frames
 * @param {number} opts.threshold - Mean channel difference, 0..255
 * @param {boolean} opts.blur
 * @returns {object} The target holding R = raw decision, G = strength
 */
export function maskDifference(renderer, opts) {
  const gl = renderer.gl;
  const { width, height } = renderer;
  // Targets before binds: creating one binds its texture, which would
  // disturb the units set up for a draw.
  const raw = renderer.target('mask:raw', width, height);
  const difference = renderer.program('mask:difference', DIFFERENCE_FRAG, { uCurrent: 0, uRing: 1 });
  gl.useProgram(difference.prog);
  renderer.bind(0, renderer.currentTexture);
  renderer.bind(1, renderer.ringTexture, true);
  gl.uniform2i(difference.u.uLayers, opts.layers[0], opts.layers[1]);
  gl.uniform1f(difference.u.uThreshold, opts.threshold);
  gl.uniform1i(difference.u.uBlur, opts.blur ? 1 : 0);
  renderer.draw(raw.fb, width, height);
  return raw;
}

/**
 * Pass 2: draw a decision texture (R = 0 or 1, G = strength; pass 1's
 * output or another mode's) into a framebuffer, with or without the vote.
 *
 * @param {object} renderer
 * @param {WebGLTexture} decision
 * @param {WebGLFramebuffer} framebuffer
 * @param {object} opts
 * @param {boolean|number} opts.clean - 3x3 vote: true for a majority
 *   (MASK_VOTES), or the number of votes a pixel needs
 * @param {'cutout'|'solid'|'data'} opts.output - The current frame cut out
 *   by the mask, the mask in white, or R = mask and G = strength
 */
export function maskDraw(renderer, decision, framebuffer, opts) {
  const gl = renderer.gl;
  const output = renderer.program('mask:output', OUTPUT_FRAG, { uMask: 0, uCurrent: 1 });
  gl.useProgram(output.prog);
  renderer.bind(0, decision);
  renderer.bind(1, renderer.currentTexture);
  gl.uniform1i(output.u.uClean, opts.clean === true ? MASK_VOTES : opts.clean || 0);
  gl.uniform1i(output.u.uOutput, opts.output === 'data' ? 2 : opts.output === 'solid' ? 1 : 0);
  renderer.draw(framebuffer, renderer.width, renderer.height);
}

/**
 * Both passes: fills the diff target with the picture and the data target
 * with the mask.
 * @param {object} renderer
 * @param {object} opts - maskDifference's, plus clean and show ('cutout' | 'solid')
 */
export function renderMask(renderer, opts) {
  const data = renderer.dataFramebuffer(renderer.width, renderer.height);
  const raw = maskDifference(renderer, opts);
  // The picture, where the trail and compositing passes expect a diff.
  maskDraw(renderer, raw.tex, renderer.diffFramebuffer, { clean: opts.clean, output: opts.show });
  // The mask as data: R = moving (0 or 1), G = strength.
  maskDraw(renderer, raw.tex, data, { clean: opts.clean, output: 'data' });
}

/** Controls shared by the modes built on the mask. */
export const SECOND_GAP = { key: 'secondGap', label: 'Second gap', type: 'range', min: 2, max: 120, step: 1, default: 30, format: asMs };
export const MASK_BLUR = { key: 'maskBlur', label: 'Blur first', type: 'toggle', default: true };
export const MASK_CLEAN = { key: 'maskClean', label: 'Clean up', type: 'toggle', default: true };

/** The second gap is always behind the first. */
const secondGap = (params) => Math.max(params.secondGap, params.frameOffset + 1);

/** How far the mask reads back into the frame ring, for a mode's `lookback`. */
export const maskLookback = (params) => [params.frameOffset, secondGap(params)];

/**
 * The ring layers of the two older frames for this frame, or null while
 * there is no history. While the ring is still filling both may be the same.
 * @param {object} frame - The per-frame context from Pipeline.process
 * @returns {number[]|null}
 */
export function maskLayers(frame) {
  const { ring, time, params } = frame;
  const near = ring.nearest(lookbackTime(time, params.frameOffset, 0, 0), time);
  const far = ring.nearest(lookbackTime(time, secondGap(params), 0, 0), time);
  return near < 0 || far < 0 ? null : [ring.slotAt(near), ring.slotAt(far)];
}

export default {
  id: 'mask',
  label: 'Motion mask',
  blurb: 'Whatever is moving, cut out where it is now. A pixel counts only if it differs from two earlier moments, so nothing is drawn where a thing used to be.',
  help: [
    'An object must move by more than its own width between the two gaps, or part of its ghost survives: lengthen the second gap for slow or large things.',
    'A flat-coloured object shows only its leading edge: differencing cannot see inside a single colour.',
    'A stopped object disappears.',
    'For the first moments after loading or seeking there is no second frame yet, and it behaves like Raw.',
  ],
  data: { kind: 'mask', what: '1 where the pixel is moving, 0 where it is still; G holds the strength of the difference' },
  composite: true,
  worker: false,
  params: [
    GAP,
    SECOND_GAP,
    THRESHOLD,
    MASK_BLUR,
    MASK_CLEAN,
    { key: 'maskShow', label: 'Show', type: 'select', default: 'cutout', options: { 'Cut-out': 'cutout', 'Solid mask': 'solid' } },
    TRAIL,
  ],
  lookback: maskLookback,
  render(frame) {
    const { gl: renderer, params } = frame;
    const layers = maskLayers(frame);
    if (!layers) {
      renderer.renderBlank('raw', false);
      return false;
    }

    renderMask(renderer, {
      layers,
      threshold: params.threshold,
      blur: params.maskBlur,
      clean: params.maskClean,
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
