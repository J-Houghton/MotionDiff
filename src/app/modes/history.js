// @ts-check
/**
 * Motion history: where things moved, how long ago, and which way.
 *
 * core/history.js is the source of truth; the shaders here mirror it:
 *
 *   motion mask (app/modes/mask.js)
 *     → age: one float per pixel, time since the mask last fired there, in
 *       history lengths. Two targets ping-ponged, so a frame rendered again
 *       while paused is recomputed from the state before it.
 *     → gradient: Sobel slope of the age field → a unit vector per pixel
 *     → pooled: those vectors averaged over patches, on a coarse grid
 *     → picture (age as a colour gradient, or direction as hue) and data
 *
 * Needs float render targets: the slope of an 8-bit age would be mostly
 * rounding.
 */
import { HISTORY_MAX_DELTA } from '../../core/history.js';
import { AGE_COLORS, GAP, THRESHOLD, asMs } from './params.js';
import { SECOND_GAP, maskLookback } from './mask.js';
import { FLOW_PRESENT, SPEED_RANGE } from './flow.js';

/** Direction grid: one cell per this many pixels… */
export const HISTORY_CELL = 8;
/** …each averaging the slopes of itself and this many cells on every side (56 px across). */
export const HISTORY_SPREAD = 3;

// Mirrors historyStep.
const AGE_FRAG = `#version 300 es
precision highp float;

uniform sampler2D uPrev;    // age before this frame
uniform sampler2D uMask;    // R > 0.5 where the pixel is moving now
uniform float uAgeStep;     // media time since the previous frame, in history lengths
uniform int uEmpty;         // 1 = no previous state: everything expired

out vec4 fragColor;

void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  float age = uEmpty == 1 ? 1.0 : min(texelFetch(uPrev, p, 0).r + uAgeStep, 1.0);
  if (texelFetch(uMask, p, 0).r > 0.5) age = 0.0;
  fragColor = vec4(age, 0.0, 0.0, 1.0);
}`;

// Mirrors historyGradient. Textures are stored bottom-up, so the image's
// "down" is the texture's "-y"; the vector written is in image coordinates
// (x right, y down).
const GRADIENT_FRAG = `#version 300 es
precision highp float;

uniform sampler2D uAge;
uniform float uMaxDelta;

out vec4 fragColor;

void main() {
  ivec2 size = textureSize(uAge, 0);
  ivec2 p = ivec2(gl_FragCoord.xy);
  fragColor = vec4(0.0, 0.0, 0.0, 1.0);
  if (p.x < 1 || p.y < 1 || p.x >= size.x - 1 || p.y >= size.y - 1) return;

  // l/c/r = left, centre, right; u/m/d = the image row above, this one, below
  float ul = texelFetch(uAge, p + ivec2(-1, 1), 0).r;
  float uc = texelFetch(uAge, p + ivec2(0, 1), 0).r;
  float ur = texelFetch(uAge, p + ivec2(1, 1), 0).r;
  float ml = texelFetch(uAge, p + ivec2(-1, 0), 0).r;
  float mc = texelFetch(uAge, p, 0).r;
  float mr = texelFetch(uAge, p + ivec2(1, 0), 0).r;
  float dl = texelFetch(uAge, p + ivec2(-1, -1), 0).r;
  float dc = texelFetch(uAge, p + ivec2(0, -1), 0).r;
  float dr = texelFetch(uAge, p + ivec2(1, -1), 0).r;

  float lo = min(min(min(ul, uc), min(ur, ml)), min(min(mc, mr), min(dl, min(dc, dr))));
  float hi = max(max(max(ul, uc), max(ur, ml)), max(max(mc, mr), max(dl, max(dc, dr))));
  if (hi >= 1.0 || hi - lo <= 1e-5 || hi - lo > uMaxDelta) return;

  float gx = (ur + 2.0 * mr + dr) - (ul + 2.0 * ml + dl);
  float gy = (dl + 2.0 * dc + dr) - (ul + 2.0 * uc + ur);
  float len = length(vec2(gx, gy));
  if (len < 1e-6) return;
  // Motion runs from old to new: down the slope.
  fragColor = vec4(-gx / len, -gy / len, 1.0, 1.0);
}`;

// poolDirection in two steps. First the sums per cell: one output texel per
// cell, RG = sum of the vectors, B = valid pixels, A = pixels. Cells are
// anchored at the image's top-left, so rows are flipped here.
const CELL_FRAG = `#version 300 es
precision highp float;

uniform sampler2D uGradient;
uniform int uCell;

out vec4 fragColor;

void main() {
  ivec2 size = textureSize(uGradient, 0);
  ivec2 cell = ivec2(gl_FragCoord.xy);
  int rows = (size.y + uCell - 1) / uCell;
  int x0 = cell.x * uCell;
  int y0 = (rows - 1 - cell.y) * uCell; // first image row of the cell

  vec2 sum = vec2(0.0);
  float valid = 0.0;
  float total = 0.0;
  for (int dy = 0; dy < uCell; dy++) {
    int y = y0 + dy;
    if (y >= size.y) break;
    for (int dx = 0; dx < uCell; dx++) {
      int x = x0 + dx;
      if (x >= size.x) break;
      vec3 g = texelFetch(uGradient, ivec2(x, size.y - 1 - y), 0).rgb;
      sum += g.rg;
      valid += g.b;
      total += 1.0;
    }
  }
  fragColor = vec4(sum, valid, total);
}`;

// The colour a ribbon was laid down in: where the mask says "moving now"
// and the flow field has a measurement there, take it; where the mask says
// moving but flow measured nothing (a flat mover's interior), keep what was
// measured there before rather than writing black. Feedback state at full
// size; the flow field is smaller and nearest-sampled (both bottom-up).
const VELOCITY_FRAG = `#version 300 es
precision highp float;

uniform sampler2D uPrev;    // RG = velocity when last moving (px/s), B = presence
uniform sampler2D uMask;    // R > 0.5 where the pixel is moving now
uniform sampler2D uFlow;    // the smoothed velocity field, working size
uniform float uFloor;       // presence below which flow measured nothing
uniform int uEmpty;         // 1 = no previous state

out vec4 fragColor;

vec3 flowAt(vec2 q) { // bilinear, by hand: the target has no linear filter
  vec2 base = floor(q);
  vec2 f = q - base;
  ivec2 i = ivec2(base);
  ivec2 edge = textureSize(uFlow, 0) - 1;
  vec3 a = texelFetch(uFlow, clamp(i, ivec2(0), edge), 0).rgb;
  vec3 b = texelFetch(uFlow, clamp(i + ivec2(1, 0), ivec2(0), edge), 0).rgb;
  vec3 c = texelFetch(uFlow, clamp(i + ivec2(0, 1), ivec2(0), edge), 0).rgb;
  vec3 d = texelFetch(uFlow, clamp(i + ivec2(1, 1), ivec2(0), edge), 0).rgb;
  return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
}

void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  vec3 kept = uEmpty == 1 ? vec3(0.0) : texelFetch(uPrev, p, 0).rgb;
  if (texelFetch(uMask, p, 0).r > 0.5) {
    vec2 scale = vec2(textureSize(uFlow, 0)) / vec2(textureSize(uPrev, 0));
    vec3 flow = flowAt((vec2(p) + 0.5) * scale - 0.5);
    if (flow.b >= uFloor) kept = flow;
  }
  fragColor = vec4(kept, 1.0);
}`;

// Then each cell with its neighbours: RG = mean vector, B = share valid.
const POOL_FRAG = `#version 300 es
precision highp float;

uniform sampler2D uCells;
uniform int uSpread;

out vec4 fragColor;

void main() {
  ivec2 size = textureSize(uCells, 0);
  ivec2 cell = ivec2(gl_FragCoord.xy);
  vec4 sum = vec4(0.0);
  for (int dy = -uSpread; dy <= uSpread; dy++) {
    for (int dx = -uSpread; dx <= uSpread; dx++) {
      ivec2 q = cell + ivec2(dx, dy);
      if (q.x < 0 || q.y < 0 || q.x >= size.x || q.y >= size.y) continue;
      sum += texelFetch(uCells, q, 0);
    }
  }
  fragColor = vec4(sum.b > 0.0 ? sum.rg / sum.b : vec2(0.0), sum.a > 0.0 ? sum.b / sum.a : 0.0, 1.0);
}`;

// The picture (Raw space: black = nothing) or the data field.
const SHOW_FRAG = `#version 300 es
precision highp float;

uniform sampler2D uAge;
uniform sampler2D uPooled;
uniform sampler2D uVelocity; // measured view: RG = velocity when last moving, B = presence
uniform int uCell;
uniform int uView;        // 0 = age as a colour gradient, 1 = direction as hue, 2 = measured velocity
uniform int uOutput;      // 0 = picture, 1 = data
uniform float uFull;      // measured view: speed shown at full brightness, px/s
uniform vec3 uNew;
uniform vec3 uOld;

out vec4 fragColor;

vec3 hue(float h) {
  return clamp(abs(fract(h + vec3(0.0, 2.0 / 3.0, 1.0 / 3.0)) * 6.0 - 3.0) - 1.0, 0.0, 1.0);
}

void main() {
  ivec2 size = textureSize(uAge, 0);
  ivec2 p = ivec2(gl_FragCoord.xy);
  float age = texelFetch(uAge, p, 0).r;
  float live = age < 1.0 ? 1.0 : 0.0;
  ivec2 cells = textureSize(uPooled, 0);
  int row = (size.y - 1 - p.y) / uCell; // cell row from the top
  vec3 d = texelFetch(uPooled, ivec2(p.x / uCell, cells.y - 1 - row), 0).rgb;

  if (uOutput == 1) {
    // R = how recent (1 = moving now), G/B = direction (x right, y down)
    fragColor = vec4((1.0 - age) * live, d.rg * live, 1.0);
    return;
  }
  vec3 colour;
  if (uView == 2) {
    // The measurement laid down with the ribbon: hue = heading, brightness =
    // speed against the range; grey where nothing was ever measured.
    vec3 v = texelFetch(uVelocity, p, 0).rgb;
    float speed = length(v.rg);
    float level = 0.3 + 0.7 * min(1.0, speed / uFull);
    float known = v.b > 0.0 ? 1.0 : 0.0;
    vec3 tint = mix(vec3(0.55), hue(atan(v.g, v.r) / 6.2831853) * level, known);
    colour = tint * (1.0 - 0.7 * age);
  } else if (uView == 1) {
    // For the picture, blend between cell centres so hues do not step in
    // blocks. In texture space a cell's centre is at (index + 0.5) * cell,
    // counted from the bottom row of the top-anchored grid.
    float bottom = float(size.y - cells.y * uCell); // the top-anchored grid may overhang the bottom edge
    vec2 at = vec2(float(p.x) + 0.5, float(p.y) + 0.5 - bottom) / float(uCell) - 0.5;
    ivec2 lo = ivec2(floor(at));
    vec2 f = at - vec2(lo);
    ivec2 edge = cells - 1;
    vec2 d00 = texelFetch(uPooled, clamp(lo, ivec2(0), edge), 0).rg;
    vec2 d10 = texelFetch(uPooled, clamp(lo + ivec2(1, 0), ivec2(0), edge), 0).rg;
    vec2 d01 = texelFetch(uPooled, clamp(lo + ivec2(0, 1), ivec2(0), edge), 0).rg;
    vec2 d11 = texelFetch(uPooled, clamp(lo + ivec2(1, 1), ivec2(0), edge), 0).rg;
    vec2 smoothed = mix(mix(d00, d10, f.x), mix(d01, d11, f.x), f.y);
    // Hue is the heading; where the patch does not agree on one, fade to grey.
    float agreement = clamp(length(smoothed) * 1.5, 0.0, 1.0);
    vec3 tint = mix(vec3(0.55), hue(atan(smoothed.y, smoothed.x) / 6.2831853), agreement);
    colour = tint * (1.0 - 0.7 * age);
  } else {
    colour = mix(uNew, uOld, age);
  }
  fragColor = vec4(colour * live, 1.0);
}`;

const hexToUnit = (hex, fallback) => {
  const value = /^#[0-9a-f]{6}$/i.test(hex || '') ? hex : fallback;
  return [1, 3, 5].map((at) => parseInt(value.slice(at, at + 2), 16) / 255);
};

/** Which of the two age targets holds what, per renderer. */
const STATES = new WeakMap();

/**
 * Advance the history for this frame without drawing what a mode shows: the
 * age field, the pooled directions, and (measured view) the laid-down flow
 * colours. The measurement half of renderHistory; stages.history memoizes it.
 *
 * @param {*} renderer - WebGLRenderer
 * @param {object} opts
 * @param {WebGLTexture} opts.mask - R > 0.5 where moving
 * @param {number} opts.ageStep - Media time since the previous frame, in history lengths
 * @param {boolean} [opts.repeat] - The same frame again: recompute, do not advance
 * @param {'age'|'direction'|'measured'} opts.view
 * @param {{tex: *, width: number, height: number}|null} [opts.velocity] - Measured
 *   view: the smoothed velocity field (flowVelocity), or null while there is none
 * @returns {{age: {tex: *}, pooled: {tex: *}, vel: {tex: *}|null}}
 */
export function advanceHistory(renderer, opts) {
  const gl = renderer.gl;
  const { width, height } = renderer;
  const cols = Math.ceil(width / HISTORY_CELL);
  const rows = Math.ceil(height / HISTORY_CELL);
  const measured = opts.view === 'measured';

  // Targets before binds (creating one binds its texture).
  const ages = [renderer.target('history:age0', width, height, { float: true }), renderer.target('history:age1', width, height, { float: true })];
  const vels = measured
    ? [renderer.target('history:vel0', width, height, { float: true }), renderer.target('history:vel1', width, height, { float: true })]
    : null;
  const gradient = renderer.target('history:gradient', width, height, { float: true });
  const cellSums = renderer.target('history:cells', cols, rows, { float: true });
  const pooled = renderer.target('history:pooled', cols, rows, { float: true });

  let state = STATES.get(renderer);
  if (!state || state.epoch !== renderer.epoch || ages[0].fresh || ages[1].fresh) {
    state = { epoch: renderer.epoch, current: 0, previous: 0, empty: true, previousEmpty: true, velEmpty: true, previousVelEmpty: true, drawn: false };
    STATES.set(renderer, state);
    ages[0].fresh = ages[1].fresh = false;
  }
  if (vels && (vels[0].fresh || vels[1].fresh)) {
    state.velEmpty = true;
    vels[0].fresh = vels[1].fresh = false;
  }
  // While another view runs, no colours are laid down: start over on return.
  if (!measured) state.velEmpty = true;
  let read;
  let empty;
  let velEmpty;
  if (opts.repeat && state.drawn) {
    read = state.previous;
    empty = state.previousEmpty;
    velEmpty = state.previousVelEmpty;
  } else {
    read = state.current;
    empty = state.empty;
    velEmpty = state.velEmpty;
    state.previous = read;
    state.previousEmpty = empty;
    state.previousVelEmpty = velEmpty;
    state.current = 1 - read;
  }
  const age = ages[state.current];

  const step = renderer.program('history:age', AGE_FRAG, { uPrev: 0, uMask: 1 });
  gl.useProgram(step.prog);
  renderer.bind(0, ages[read].tex);
  renderer.bind(1, opts.mask);
  gl.uniform1f(step.u.uAgeStep, opts.ageStep);
  gl.uniform1i(step.u.uEmpty, empty ? 1 : 0);
  renderer.draw(age.fb, width, height);
  state.empty = false;
  state.drawn = true;

  if (vels) {
    // The colour each ribbon pixel was laid down in. Without a flow field
    // yet, the floor lets nothing through and the state is only carried.
    const lay = renderer.program('history:velocity', VELOCITY_FRAG, { uPrev: 0, uMask: 1, uFlow: 2 });
    gl.useProgram(lay.prog);
    renderer.bind(0, vels[read].tex);
    renderer.bind(1, opts.mask);
    renderer.bind(2, opts.velocity ? opts.velocity.tex : vels[read].tex);
    // The field zeroes its vectors below flow's own presence floor, so a
    // lower floor here would lay down phantom zero-vectors, not colours.
    gl.uniform1f(lay.u.uFloor, opts.velocity ? FLOW_PRESENT : 1e9);
    gl.uniform1i(lay.u.uEmpty, velEmpty ? 1 : 0);
    renderer.draw(vels[state.current].fb, width, height);
    state.velEmpty = false;
  }

  const slope = renderer.program('history:gradient', GRADIENT_FRAG, { uAge: 0 });
  gl.useProgram(slope.prog);
  renderer.bind(0, age.tex);
  gl.uniform1f(slope.u.uMaxDelta, HISTORY_MAX_DELTA);
  renderer.draw(gradient.fb, width, height);

  const perCell = renderer.program('history:cells', CELL_FRAG, { uGradient: 0 });
  gl.useProgram(perCell.prog);
  renderer.bind(0, gradient.tex);
  gl.uniform1i(perCell.u.uCell, HISTORY_CELL);
  renderer.draw(cellSums.fb, cols, rows);

  const pool = renderer.program('history:pool', POOL_FRAG, { uCells: 0 });
  gl.useProgram(pool.prog);
  renderer.bind(0, cellSums.tex);
  gl.uniform1i(pool.u.uSpread, HISTORY_SPREAD);
  renderer.draw(pooled.fb, cols, rows);

  return { age, pooled, vel: vels ? vels[state.current] : null };
}

/**
 * Advance the history with a mask and draw it. Fills the picture target and
 * the data target.
 *
 * @param {*} renderer - WebGLRenderer
 * @param {object} opts - advanceHistory's (mask, ageStep, repeat, velocity —
 *   not needed with `state`), plus:
 * @param {{age: {tex: *}, pooled: {tex: *}, vel: {tex: *}|null}} [opts.state] -
 *   The history already advanced this frame (stages.history): the advance is
 *   then skipped
 * @param {WebGLTexture} [opts.mask]
 * @param {number} [opts.ageStep]
 * @param {boolean} [opts.repeat]
 * @param {{tex: *, width: number, height: number}|null} [opts.velocity]
 * @param {'age'|'direction'|'measured'} opts.view
 * @param {string} [opts.colourNew] - Hex, age view
 * @param {string} [opts.colourOld]
 * @param {number} [opts.full] - Measured view: speed at full brightness, px/s
 */
export function renderHistory(renderer, opts) {
  const state = opts.state || advanceHistory(renderer, /** @type {*} */ (opts));
  const gl = renderer.gl;
  const { width, height } = renderer;
  // Targets before binds.
  const data = renderer.dataFramebuffer(width, height);

  const show = renderer.program('history:show', SHOW_FRAG, { uAge: 0, uPooled: 1, uVelocity: 2 });
  gl.useProgram(show.prog);
  renderer.bind(0, state.age.tex);
  renderer.bind(1, state.pooled.tex);
  renderer.bind(2, state.vel ? state.vel.tex : state.age.tex);
  gl.uniform1i(show.u.uCell, HISTORY_CELL);
  gl.uniform1i(show.u.uView, opts.view === 'measured' ? 2 : opts.view === 'direction' ? 1 : 0);
  gl.uniform1f(show.u.uFull, Math.max(1, opts.full || 0));
  gl.uniform3fv(show.u.uNew, hexToUnit(opts.colourNew, '#ff4400'));
  gl.uniform3fv(show.u.uOld, hexToUnit(opts.colourOld, '#0044ff'));
  gl.uniform1i(show.u.uOutput, 0);
  renderer.draw(renderer.pictureFramebuffer, width, height);
  gl.uniform1i(show.u.uOutput, 1);
  renderer.draw(data, width, height);
}

export default /** @type {import('./index.js').Mode} */ ({
  id: 'history',
  label: 'Motion history',
  blurb: 'Every mover leaves a band along its path: coloured by how long ago it passed, or by which way it was heading.',
  help: [
    'Direction hues: right is red, down is yellow-green, left is cyan, up is violet. Grey means the patch does not agree on a heading.',
    'Direction is read from the shape of the trail and averaged over patches about 56 pixels across: a trail wider than that shows different hues along its two sides.',
    'Things that sway back and forth (foliage, water) give mixed or grey hues.',
    'A flat-coloured object registers only at its edges, so its own footprint is uneven; the band behind it is not.',
    'Built on the motion mask: the same gap, second gap and threshold apply.',
    'Measured colours are optical flow\'s: each ribbon keeps the heading and speed measured as it was laid down. Grey means flow measured nothing there; a flat mover\'s interior keeps the last colour measured on it.',
  ],
  data: { kind: 'vector', what: 'R: how recently the pixel moved (1 = now, 0 = not within the history); G, B: heading as a vector, x to the right and y down' },
  composite: true,
  worker: false,
  needsFloat: true,
  params: [
    { key: 'historyShow', label: 'Show', type: 'select', default: 'age', options: { 'Age': 'age', 'Direction': 'direction', 'Measured (flow)': 'measured' } },
    { key: 'historyLength', label: 'History', type: 'range', min: 5, max: 150, step: 5, default: 30, format: asMs },
    GAP,
    SECOND_GAP,
    THRESHOLD,
    ...AGE_COLORS.map((colour) => ({ ...colour, when: (p) => p.historyShow === 'age' })),
    { ...SPEED_RANGE, when: (p) => p.historyShow === 'measured' },
  ],
  lookback: maskLookback,
  render(frame) {
    const { gl: renderer, params } = frame;
    // The strict-voted mask feed and the advanced ages are shared stages;
    // the measured view pulls the flow field through the same stage the
    // flow mode uses.
    const state = frame.stages.history(params.historyShow);
    if (!state) {
      renderer.renderBlank('raw', false);
      return false;
    }
    renderHistory(renderer, {
      state,
      view: params.historyShow,
      colourNew: params.ageColorNew,
      colourOld: params.ageColorOld,
      full: (params.flowRange / 100) * renderer.width,
    });
    renderer.renderComposite(frame.display, 'raw', false);
    return true;
  },
});
