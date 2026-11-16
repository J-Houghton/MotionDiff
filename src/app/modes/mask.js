// @ts-check
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
import { BG_K } from '../../core/background.js';
import { TRAIL_HOLD, TRAIL_REFRESH } from '../../core/trails.js';
import { MASK_VOTES } from '../../core/mask.js';
import { DEPTH_SHOW, GAP, MASK_DEPTH, MASK_FILL, MASK_NAMES, MASK_TRACK, THRESHOLD, TRAIL, asMs } from './params.js';

// Pass 1. Mirrors boxBlur (core/blur.js) on each frame, then
// threeFrameDifference and thresholdMask (core/mask.js).
// Output: R = raw decision (0 or 1), G = the smaller difference / 765.
const DIFFERENCE_FRAG = `#version 300 es
precision highp float;
precision highp sampler2DArray;

uniform sampler2D uCurrent;
uniform sampler2DArray uRing;
uniform sampler2D uVariance; // per-pixel noise (0..1 units), when uAuto == 1
uniform sampler2D uOlderA;  // camera-stabilised older frames, when uStabilised == 1
uniform sampler2D uOlderB;
uniform ivec2 uLayers;      // ring layers of the two older frames
uniform float uThreshold;   // mean channel difference, 0..255
uniform float uK;           // standard deviations the difference must clear
uniform int uAuto;          // 1 = per-pixel floor from uVariance (mirrors thresholdMaskAuto)
uniform int uGradient;      // 1 = difference edge strength, not brightness (mirrors lumaSobel)
uniform int uBlur;          // 1 = 3x3 box blur before differencing
uniform int uStabilised;    // 1 = read the older frames from uOlderA/B (camera compensation)

out vec4 fragColor;

vec3 current(ivec2 q) { return floor(texelFetch(uCurrent, q, 0).rgb * 255.0 + 0.5); }
// 'which' picks the first or second older frame, from the warped copies or
// straight from the ring (the warp already rounded to whole levels).
vec3 older(ivec2 q, int which) {
  vec4 texel = uStabilised == 1
    ? (which == 0 ? texelFetch(uOlderA, q, 0) : texelFetch(uOlderB, q, 0))
    : texelFetch(uRing, ivec3(q, which == 0 ? uLayers.x : uLayers.y), 0);
  return floor(texel.rgb * 255.0 + 0.5);
}

const vec3 LUMA = vec3(0.2126, 0.7152, 0.0722);

// Mirrors lumaSobel at one pixel: 'which' -1 is the current frame.
float edgeAt(ivec2 p, int which, ivec2 size) {
  float l[9];
  int n = 0;
  for (int dy = -1; dy <= 1; dy++) {
    for (int dx = -1; dx <= 1; dx++) {
      ivec2 q = clamp(p + ivec2(dx, dy), ivec2(0), size - 1);
      l[n++] = dot(which < 0 ? current(q) : older(q, which), LUMA);
    }
  }
  float gx = (l[2] + 2.0 * l[5] + l[8]) - (l[0] + 2.0 * l[3] + l[6]);
  float gy = (l[6] + 2.0 * l[7] + l[8]) - (l[0] + 2.0 * l[1] + l[2]);
  return (abs(gx) + abs(gy)) / 8.0;
}

void main() {
  ivec2 size = textureSize(uCurrent, 0);
  ivec2 p = ivec2(gl_FragCoord.xy);
  vec3 c;
  vec3 a;
  vec3 b;
  if (uGradient == 1) {
    // Edge strength replaces brightness (and the blur: Sobel smooths).
    c = vec3(edgeAt(p, -1, size));
    a = vec3(edgeAt(p, 0, size));
    b = vec3(edgeAt(p, 1, size));
  } else if (uBlur == 1) {
    vec3 sumC = vec3(0.0);
    vec3 sumA = vec3(0.0);
    vec3 sumB = vec3(0.0);
    float count = 0.0;
    for (int dy = -1; dy <= 1; dy++) {
      for (int dx = -1; dx <= 1; dx++) {
        ivec2 q = p + ivec2(dx, dy);
        if (q.x < 0 || q.y < 0 || q.x >= size.x || q.y >= size.y) continue;
        sumC += current(q);
        sumA += older(q, 0);
        sumB += older(q, 1);
        count += 1.0;
      }
    }
    // Rounded to whole values, like boxBlur.
    c = floor(sumC / count + 0.5);
    a = floor(sumA / count + 0.5);
    b = floor(sumB / count + 0.5);
  } else {
    c = current(p);
    a = older(p, 0);
    b = older(p, 1);
  }
  vec3 d1 = abs(c - a);
  vec3 d2 = abs(c - b);
  float difference = min(d1.r + d1.g + d1.b, d2.r + d2.g + d2.b); // channel sum, 0..765
  float moving = (difference > 0.0 && difference >= uThreshold * 3.0) ? 1.0 : 0.0;
  // Blurred frames carry a third of the learnt noise (nine pixels averaged).
  if (uAuto == 1 && difference < uK * sqrt(2.0 * texelFetch(uVariance, p, 0).r) * 765.0 * (uBlur == 1 ? 1.0 / 3.0 : 1.0)) moving = 0.0;
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

// Mirrors dilate and erode (core/mask.js): min or max of the decisions in a
// square window, strength carried through the same min/max. Outside the
// image a dilate sees "not set" and an erode "set" (both: skip the cell), so
// a close neither grows in from the border nor eats shapes touching it.
const MORPH_FRAG = `#version 300 es
precision highp float;

uniform sampler2D uMask;    // R = decision, G = strength
uniform int uRadius;
uniform int uMode;          // 0 = dilate, 1 = erode

out vec4 fragColor;

void main() {
  ivec2 size = textureSize(uMask, 0);
  ivec2 p = ivec2(gl_FragCoord.xy);
  vec2 picked = uMode == 0 ? vec2(0.0) : vec2(1.0);
  for (int dy = -2; dy <= 2; dy++) {
    for (int dx = -2; dx <= 2; dx++) {
      if (abs(dx) > uRadius || abs(dy) > uRadius) continue;
      ivec2 q = p + ivec2(dx, dy);
      if (q.x < 0 || q.y < 0 || q.x >= size.x || q.y >= size.y) continue;
      vec2 cell = texelFetch(uMask, q, 0).rg;
      picked = uMode == 0 ? max(picked, cell) : min(picked, cell);
    }
  }
  fragColor = vec4(picked, 0.0, 1.0);
}`;

/**
 * Vote, then close: the 3x3 vote first (so speckle is gone before anything
 * dilates), then dilate and erode by `radius`, which fills holes up to twice
 * the radius across without growing the cut-out. Returns a decision texture
 * for maskDraw with `clean: false`.
 *
 * @param {*} renderer
 * @param {WebGLTexture} decision - R = 0 or 1, G = strength
 * @param {{clean: boolean|number, radius: number}} opts
 * @param {string} [key] - Names this caller's targets
 * @returns {{tex: *, fb: *, width: number, height: number}}
 */
export function closeMask(renderer, decision, opts, key = 'mask') {
  const gl = renderer.gl;
  const { width, height } = renderer;
  // Targets before binds.
  const voted = renderer.target(`${key}:voted`, width, height);
  const dilated = renderer.target(`${key}:dilated`, width, height);
  const closed = renderer.target(`${key}:closed`, width, height);
  maskDraw(renderer, decision, voted.fb, { clean: opts.clean, output: 'data' });
  const morph = renderer.program('mask:morph', MORPH_FRAG, { uMask: 0 });
  const pass = (source, target, mode) => {
    gl.useProgram(morph.prog);
    renderer.bind(0, source.tex);
    gl.uniform1i(morph.u.uRadius, opts.radius);
    gl.uniform1i(morph.u.uMode, mode);
    renderer.draw(target.fb, width, height);
  };
  pass(voted, dilated, 0);
  pass(dilated, closed, 1);
  return closed;
}

/**
 * Pass 1 for the frame in the renderer's current texture.
 *
 * @param {*} renderer - WebGLRenderer
 * @param {object} opts
 * @param {number[]} opts.layers - Ring layers of the two older frames
 * @param {number} opts.threshold - Mean channel difference, 0..255
 * @param {boolean} opts.blur
 * @param {WebGLTexture} [opts.variance] - Per-pixel noise: the threshold
 *   becomes max(global, BG_K·σ·√2), as in core thresholdMaskAuto
 * @param {boolean} [opts.gradient] - Difference edge strength (lumaSobel)
 *   instead of brightness: a lighting change stops marking the frame
 * @param {string} [opts.key] - Names the target this variant draws into, so
 *   two variants computed in one frame do not overwrite each other
 * @param {*[]} [opts.older] - The two older frames as camera-stabilised 2D
 *   textures (stages.stabilised) in place of the ring layers
 * @returns {{tex: *, fb: *, width: number, height: number}} The target holding R = raw decision, G = strength
 */
export function maskDifference(renderer, opts) {
  const gl = renderer.gl;
  const { width, height } = renderer;
  // Targets before binds: creating one binds its texture, which would
  // disturb the units set up for a draw.
  const raw = renderer.target(opts.key || 'mask:raw', width, height);
  const difference = renderer.program('mask:difference', DIFFERENCE_FRAG, { uCurrent: 0, uRing: 1, uVariance: 2, uOlderA: 3, uOlderB: 4 });
  gl.useProgram(difference.prog);
  renderer.bind(0, renderer.currentTexture);
  renderer.bind(1, renderer.ringTexture, true);
  renderer.bind(2, opts.variance || renderer.currentTexture);
  renderer.bind(3, opts.older ? opts.older[0] : renderer.currentTexture);
  renderer.bind(4, opts.older ? opts.older[1] : renderer.currentTexture);
  gl.uniform2i(difference.u.uLayers, opts.layers[0], opts.layers[1]);
  gl.uniform1f(difference.u.uThreshold, opts.threshold);
  gl.uniform1f(difference.u.uK, BG_K);
  gl.uniform1i(difference.u.uAuto, opts.variance ? 1 : 0);
  gl.uniform1i(difference.u.uGradient, opts.gradient ? 1 : 0);
  gl.uniform1i(difference.u.uBlur, opts.blur ? 1 : 0);
  gl.uniform1i(difference.u.uStabilised, opts.older ? 1 : 0);
  renderer.draw(raw.fb, width, height);
  return raw;
}

/**
 * Pass 2: draw a decision texture (R = 0 or 1, G = strength; pass 1's
 * output or another mode's) into a framebuffer, with or without the vote.
 *
 * @param {*} renderer
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
 * @param {*} renderer
 * @param {{layers?: number[], threshold?: number, blur?: boolean, clean: boolean, show: 'cutout'|'solid', fill?: number, variance?: WebGLTexture, gradient?: boolean, raw?: {tex: *}}} opts - maskDifference's, plus clean, show and fill (close radius, 0 = off). With `raw` (a decision already measured, stages.maskRaw), the difference pass is skipped and layers/threshold/blur are not needed.
 */
export function renderMask(renderer, opts) {
  const data = renderer.dataFramebuffer(renderer.width, renderer.height);
  const raw = opts.raw || maskDifference(renderer, /** @type {*} */ (opts));
  const fill = opts.fill || 0;
  // With a fill, the vote happens inside closeMask; maskDraw then must not
  // vote again, or the close's filling is carved back out.
  const decision = fill > 0 ? closeMask(renderer, raw.tex, { clean: opts.clean, radius: fill }) : raw;
  const clean = fill > 0 ? false : opts.clean;
  // The picture, where the trail and compositing passes expect a diff.
  maskDraw(renderer, decision.tex, renderer.diffFramebuffer, { clean, output: opts.show });
  // The mask as data: R = moving (0 or 1), G = strength.
  maskDraw(renderer, decision.tex, data, { clean, output: 'data' });
}

/** Controls shared by the modes built on the mask. */
export const SECOND_GAP = { key: 'secondGap', label: 'Second gap', type: 'range', min: 2, max: 120, step: 1, default: 30, format: asMs };
export const MASK_BLUR = { key: 'maskBlur', label: 'Blur first', type: 'toggle', default: true };
export const MASK_CLEAN = { key: 'maskClean', label: 'Clean up', type: 'toggle', default: true };
export { MASK_FILL };
export const MASK_AUTO = { key: 'maskAuto', label: 'Auto threshold', type: 'toggle', default: false };
export const MASK_GRADIENT = { key: 'maskGradient', label: 'Ignore lighting', type: 'toggle', default: false };

/** The second gap is always behind the first. */
const secondGap = (params) => Math.max(params.secondGap, params.frameOffset + 1);

/** How far the mask reads back into the frame ring, for a mode's `lookback`. */
export const maskLookback = (params) => [params.frameOffset, secondGap(params)];

/**
 * The ring layers of the two older frames for this frame, or null while
 * there is no history. While the ring is still filling both may be the same.
 * @param {import('./index.js').ModeFrame} frame - The per-frame context from Pipeline.process
 * @returns {number[]|null}
 */
export function maskLayers(frame) {
  const { ring, time, params } = frame;
  const near = ring.nearest(lookbackTime(time, params.frameOffset, 0, 0), time);
  const far = ring.nearest(lookbackTime(time, secondGap(params), 0, 0), time);
  return near < 0 || far < 0 ? null : [ring.slotAt(near), ring.slotAt(far)];
}

export default /** @type {import('./index.js').Mode} */ ({
  id: 'mask',
  label: 'Motion mask',
  blurb: 'Whatever is moving, cut out where it is now. A pixel counts only if it differs from two earlier moments, so nothing is drawn where a thing used to be.',
  help: [
    'An object must move by more than its own width between the two gaps, or part of its ghost survives: lengthen the second gap for slow or large things.',
    'A flat-coloured object shows only its leading edge: differencing cannot see inside a single colour.',
    'A stopped object disappears.',
    'For the first moments after loading or seeking there is no second frame yet, and it behaves like Raw.',
    'Fill holes closes gaps in a cut-out up to twice its size across, after the clean-up vote, without growing the cut-out.',
    'Ignore lighting differences each frame\'s edges instead of its brightness, so a lighting or exposure change stops marking the whole frame; it replaces the blur. The mask is then sparse — thin lines where edges moved — and soft, diffuse fronts respond weakly: a remedy for lighting drift, not a better general mask.',
    'Box the movers groups what the mask finds into shapes and follows each one: a box with a number that stays with it, its measured speed, and an arrow one second ahead. A mover must persist a few frames before it is boxed, and survives a brief loss; what the mask merges (two movers touching) is one box, and a flat-coloured mover whose interior the mask cannot see may briefly carry a box per edge.',
    'Name the movers loads a small image classifier (about 4 MB, fetched only when asked) that looks at the original frame under each box a few times a second and writes its best guess on the plate; the box carries the name while it lives. It names things as one of 1,000 everyday classes: a merged clump is named as one thing, and unusual footage gets a wrong or absent name.',
    'The count line (X, or the link in the readings margin) counts boxed movers crossing a line you draw, each way. Counts are of boxes: a merged clump counts once, and a mover whose box dies before the line never counts. A new source clears the line.',
    'Depth the scene loads a depth model (about 25 MB, fetched only when asked, then cached) that estimates relative depth beside the pipeline, a look or two behind the picture — the overlay\'s age chip says by how much. With it on, each box\'s shown speed is scaled to the scene\'s median depth (marked ≈), so the far carriageway stops reading slower than the near one; where the estimate is too flat or too far to trust, the plain measured speed shows unmarked. The depth picture and everything scaled by it is a model\'s estimate, not a measurement.',
    'Auto threshold learns each pixel\'s own noise (the background model\'s variance) and asks a difference to clear it as well as the set threshold, which becomes a floor: grainy footage cleans up without raising the threshold for the whole picture. The noise takes a second or two to be learnt.',
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
    MASK_FILL,
    MASK_AUTO,
    MASK_GRADIENT,
    MASK_TRACK,
    MASK_NAMES,
    MASK_DEPTH,
    DEPTH_SHOW,
    { key: 'maskShow', label: 'Show', type: 'select', default: 'cutout', options: { 'Cut-out': 'cutout', 'Solid mask': 'solid' } },
    TRAIL,
  ],
  lookback: maskLookback,
  render(frame) {
    const { gl: renderer, params } = frame;
    // The raw decision is a shared stage (with auto threshold it keeps the
    // background model's variance learning, computed once however many
    // views want it).
    const raw = frame.stages.maskRaw();
    if (!raw) {
      renderer.renderBlank('raw', false);
      return false;
    }

    renderMask(renderer, {
      raw,
      clean: params.maskClean,
      show: params.maskShow,
      fill: params.maskFill,
    });

    // Grouping and tracking: shapes become boxes with an ID (docs/tracking.md).
    if (params.maskTrack) frame.stages.objects(raw);

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
});
