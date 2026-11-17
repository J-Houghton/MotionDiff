// @ts-check
/**
 * Optical flow: how fast, and which way, each patch of the picture is moving.
 *
 * core/flow.js is the source of truth; app/flow.js holds the shader mirror.
 * Here:
 *
 *   luma of the current frame and of the frame one gap back, reduced to the
 *   working size (at most FLOW_WIDTH wide)
 *     → flow between them, coarse to fine (pixels per gap)
 *     → velocity: picture pixels per second of media time
 *     → running average over time (weighted by confidence)
 *     → picture: particle traces (app/particles.js) or colour (hue =
 *       heading, brightness = speed); and the data field
 *
 * Needs float render targets.
 */
import { FLOW_MAX_STEP, flowReadings } from '../../core/flow.js';
import { lookbackTime } from '../../core/timebase.js';
import { FLOW_PRELUDE, flowBetween, flowLuma, flowPass, flowSmooth, readField } from '../flow.js';
import { particleField, reduceField, renderParticles } from '../particles.js';
import { renderArrows } from '../arrows.js';
import { maskDraw, maskLookback } from './mask.js';
import { THRESHOLD, asMs } from './params.js';

/** Flow is solved on a copy of the frame at most this wide. */
export const FLOW_WIDTH = 320;
/** A vector counts fully from this confidence up (levels² per pixel², see core/flow.js). */
export const FLOW_TRUSTED = 4;
/** A place counts as measured while at least this share of recent frames gave a trusted vector there. */
export const FLOW_PRESENT = 0.25;
/** Motion slower than this share of the speed range is not drawn. */
export const FLOW_FLOOR = 0.04;
/** The readouts read the field back at most this wide: small enough for every frame. */
export const READINGS_WIDTH = 96;
/** Warn when at least this share of what moves is at the measurable ceiling. */
export const READINGS_SATURATED = 0.2;

/** Whole factor that brings the processing width down to the working size. */
export const flowFactor = (width) => Math.max(1, Math.ceil(width / FLOW_WIDTH));
/** Pyramid sizes for a working width: four where the smallest still has something to match. */
export const flowLevels = (workingWidth) => (workingWidth >= 240 ? 4 : 3);
/** The largest shift (working pixels per gap) the pyramid finds reliably: about half its theoretical reach. */
export const flowReach = (levels) => (FLOW_MAX_STEP * (2 ** levels - 1)) / 2;

// Flow (working pixels per gap) → velocity (picture pixels per second),
// less the camera's own motion while compensation is on: the fitted
// similarity evaluated at each cell (records/design/camera-compensation.md).
const VELOCITY_FRAG = `${FLOW_PRELUDE}
uniform sampler2D uFlow;
uniform float uScale;
uniform int uCamOn;
uniform vec4 uCamera;   // dx, dy picture px/s; zoom 1/s; rotation rad/s
uniform float uFactor;  // picture px per working px

void main() {
  vec3 flow = px(uFlow, here()).rgb;
  vec2 v = flow.rg * uScale;
  if (uCamOn == 1) {
    vec2 size = vec2(textureSize(uFlow, 0));
    vec2 r = (vec2(here()) - (size - 1.0) / 2.0) * uFactor;
    v -= uCamera.xy + vec2(uCamera.z * r.x - uCamera.w * r.y, uCamera.w * r.x + uCamera.z * r.y);
  }
  fragColor = vec4(v, flow.b, 1.0);
}`;

// The colour picture (Raw space: black = nothing) or the data field.
const SHOW_FRAG = `${FLOW_PRELUDE}
uniform sampler2D uVelocity;
uniform float uFull;     // speed shown at full brightness, picture pixels per second
uniform float uFloor;    // slower than this is not shown
uniform int uOutput;     // 0 = picture, 1 = data

vec3 hue(float h) {
  return clamp(abs(fract(h + vec3(0.0, 2.0 / 3.0, 1.0 / 3.0)) * 6.0 - 3.0) - 1.0, 0.0, 1.0);
}

void main() {
  vec2 at = (vec2(here()) + 0.5) * vec2(textureSize(uVelocity, 0)) / vec2(uSize) - 0.5;
  vec2 v = between(uVelocity, at).rg;
  float speed = length(v);
  float level = min(1.0, speed / uFull);
  if (uOutput == 1) {
    // R = speed as a share of the range, G/B = velocity (x right, y down)
    fragColor = vec4(level, v, 1.0);
    return;
  }
  float shown = step(uFloor, speed) * (0.3 + 0.7 * level);
  fragColor = vec4(hue(atan(v.y, v.x) / 6.2831853) * shown, 1.0);
}`;

/** The speed drawn at full strength, as a share of the picture's width per second. */
export const SPEED_RANGE = { key: 'flowRange', label: 'Speed range', type: 'range', min: 2, max: 100, step: 1, default: 25, format: (v) => `${v}% of width / s` };

/** Controls for particle traces, shared by every mode that can show them. */
export const TRACE_PARAMS = [
  { key: 'traceDensity', label: 'Traces', type: 'range', min: 5, max: 60, step: 5, default: 25, format: (v) => `${v} per 1000 px` },
  { key: 'traceLength', label: 'Trace length', type: 'range', min: 3, max: 60, step: 1, default: 15, format: asMs },
  { key: 'traceGain', label: 'Trace speed', type: 'select', default: 1, options: { 'True (1x)': 1, '2x': 2, '4x': 4, '8x': 8 } },
  { key: 'traceColour', label: 'Trace colour', type: 'select', default: 'heading', options: { 'By heading': 'heading', 'Plain': 'plain' } },
];

/** Speed range in picture pixels per second, from the control (percent of the width per second). */
export const fullSpeed = (params, width) => (params.flowRange / 100) * width;

// The gate at the working size: maximum of the voted decision over each
// texel's footprint (any moving pixel gates its cell in)…
const GATE_REDUCE_FRAG = `${FLOW_PRELUDE}
uniform sampler2D uDecision; // full size, R = moving
uniform int uFactor;

void main() {
  ivec2 p = here();
  float set = 0.0;
  for (int dy = 0; dy < uFactor; dy++) {
    for (int dx = 0; dx < uFactor; dx++) set = max(set, px(uDecision, p * uFactor + ivec2(dx, dy)).r);
  }
  fragColor = vec4(set, 0.0, 0.0, 1.0);
}`;

// …then dilated by the solve window, so a mover's rim keeps its vectors.
const GATE_DILATE_FRAG = `${FLOW_PRELUDE}
uniform sampler2D uGate;

void main() {
  ivec2 p = here();
  float set = 0.0;
  for (int dy = -3; dy <= 3; dy++) {
    for (int dx = -3; dx <= 3; dx++) set = max(set, px(uGate, p + ivec2(dx, dy)).r);
  }
  fragColor = vec4(set, 0.0, 0.0, 1.0);
}`;

// Confidence gated BEFORE smoothing: gated places decay below the presence
// floor rather than blinking off.
const GATE_APPLY_FRAG = `${FLOW_PRELUDE}
uniform sampler2D uFlow;
uniform sampler2D uGate;

void main() {
  ivec2 p = here();
  vec3 flow = px(uFlow, p).rgb;
  fragColor = vec4(flow.rg, flow.b * step(0.5, px(uGate, p).r), 1.0);
}`;

/**
 * The gate at the working size (R = 1 where flow may keep its confidence),
 * from a full-size decision texture (the plain mask or the model's
 * foreground, R = moving/foreground — which one is decided by the stage
 * layer). Null when nothing gates this frame.
 * @param {*} renderer - WebGLRenderer
 * @param {number} width - The working size flow is solved at
 * @param {number} height
 * @param {{tex: *}|null} decision
 */
export function flowGate(renderer, width, height, decision) {
  if (!decision) return null;
  // Targets before binds.
  const voted = renderer.target('flow:gate-voted', renderer.width, renderer.height);
  const reduced = renderer.target('flow:gate-reduced', width, height);
  const gate = renderer.target('flow:gate', width, height);
  maskDraw(renderer, decision.tex, voted.fb, { clean: true, output: 'data' });
  flowPass(renderer, 'flow:gate-reduce', GATE_REDUCE_FRAG, { uDecision: 0 }, reduced, [voted.tex], (gl, u) => gl.uniform1i(u.uFactor, flowFactor(renderer.width)));
  return flowPass(renderer, 'flow:gate-dilate', GATE_DILATE_FRAG, { uGate: 0 }, gate, [reduced.tex]);
}

/**
 * The velocity field for this frame, or null while there is no older frame.
 * @param {import('./index.js').ModeFrame} frame - The per-frame context from Pipeline.process
 * @param {(() => {tex: *}|null)|null} [gateSource] - Measures the full-size
 *   decision that gates the flow (stages.velocity decides which), or null to
 *   measure everywhere. A function, not a texture: a stateful decision (the
 *   background model) must not advance on a frame whose solve never runs,
 *   so it is asked for only after the early-outs
 * @param {{dx: number, dy: number, zoom: number, rot: number}|null} [camera] -
 *   The camera's fitted motion (stages.camera), subtracted from the field
 *   before smoothing; null leaves the field as measured
 * @returns {VelocityField|null} RG = picture pixels per second,
 *   averaged over time by confidence, zero where nothing is measured;
 *   B = how present a measurement is, 0..1
 */
export function flowVelocity(frame, gateSource = null, camera = null) {
  const { gl: renderer, ring, time, params } = frame;
  const age = ring.nearest(lookbackTime(time, params.flowGap, 0, 0), time);
  if (age < 0) return null;
  const gapSeconds = time - ring.timeAt(age);
  if (!(gapSeconds > 1e-4)) return null;

  const factor = flowFactor(renderer.width);
  const current = flowLuma(renderer, 'flow:current', factor);
  const older = flowLuma(renderer, 'flow:older', factor, ring.slotAt(age));
  const velocity = renderer.target('flow:velocity', current.width, current.height, { float: true });
  const gated = renderer.target('flow:gated', current.width, current.height, { float: true });
  let flow = flowBetween(renderer, 'flow', older, current, { levels: flowLevels(current.width) });
  const gate = gateSource ? flowGate(renderer, current.width, current.height, gateSource()) : null;
  if (gate) flow = flowPass(renderer, 'flow:gate-apply', GATE_APPLY_FRAG, { uFlow: 0, uGate: 1 }, gated, [flow.tex, gate.tex]);
  flowPass(renderer, 'flow:velocity', VELOCITY_FRAG, { uFlow: 0 }, velocity, [flow.tex], (gl, u) => {
    gl.uniform1f(u.uScale, factor / gapSeconds);
    gl.uniform1i(u.uCamOn, camera ? 1 : 0);
    if (camera) {
      gl.uniform4f(u.uCamera, camera.dx, camera.dy, camera.zoom, camera.rot);
      gl.uniform1f(u.uFactor, factor);
    }
  });

  const seconds = params.flowSmoothing / 30;
  const smoothed = /** @type {VelocityField} */ (flowSmooth(renderer, 'flow', velocity, {
    alpha: seconds > 0 ? 1 - Math.exp(-(frame.stepMs / 1000) / seconds) : 1,
    trusted: FLOW_TRUSTED,
    floor: FLOW_PRESENT,
    repeat: frame.step === 'repeat',
  }));
  // The fastest speed this gap and pyramid could have measured, in picture
  // pixels per second: carried with the field for the readouts.
  smoothed.ceiling = (flowReach(flowLevels(current.width)) * factor) / gapSeconds;
  return smoothed;
}

/**
 * A smoothed velocity target with the measurable ceiling carried along.
 * @typedef {{tex: *, fb: *, width: number, height: number, ceiling?: number}} VelocityField
 */

/** Reused readback buffers, per renderer. */
const READ_BUFFERS = new WeakMap();

/** Eight compass names for a heading in radians (x right, y DOWN). */
const SECTORS = [
  ['→', 'right'], ['↘', 'down-right'], ['↓', 'down'], ['↙', 'down-left'],
  ['←', 'left'], ['↖', 'up-left'], ['↑', 'up'], ['↗', 'up-right'],
];
const sector = (heading) => SECTORS[Math.round(((heading + Math.PI * 2) % (Math.PI * 2)) / (Math.PI / 4)) % 8];

/**
 * Read the velocity field back small and measure it: the live readouts, and
 * the sentence and data they become. Speeds are reported as a share of the
 * picture's width per second, matching the Speed range control.
 *
 * @param {import('./index.js').ModeFrame} frame - The per-frame context
 * @param {{tex, width, height, ceiling?: number}} velocity - From flowVelocity
 * @param {number} full - Speed at full brightness, picture pixels per second
 */
export function reportReadings(frame, velocity, full) {
  const renderer = frame.gl;
  const field = reduceField(renderer, 'flow:readings', velocity, READINGS_WIDTH);
  const buffers = readField(renderer, field, READ_BUFFERS.get(renderer));
  READ_BUFFERS.set(renderer, buffers);
  const readings = flowReadings(buffers.values, field.width * field.height, {
    floor: full * FLOW_FLOOR,
    present: FLOW_PRESENT,
    stride: 4,
    ceiling: velocity.ceiling,
  });

  // Spread of the moving cells, for the readings panel: eight heading bins
  // (bin 0 = right, then clockwise on screen, matching SECTORS) and three
  // speed bins against the range (slow < a third of full, medium < full,
  // fast at or beyond). Shares of the moving cells; all zero while nothing
  // moves. Same pass shape as core's flowReadings, over the field already
  // read back.
  const rose = new Array(8).fill(0);
  const speedBins = [0, 0, 0];
  let movingCells = 0;
  const cells = field.width * field.height;
  const floor = full * FLOW_FLOOR;
  for (let p = 0; p < cells; p++) {
    if (buffers.values[p * 4 + 2] < FLOW_PRESENT) continue;
    const vx = buffers.values[p * 4];
    const vy = buffers.values[p * 4 + 1];
    const speed = Math.hypot(vx, vy);
    if (speed < floor) continue;
    movingCells++;
    rose[Math.round(((Math.atan2(vy, vx) + Math.PI * 2) % (Math.PI * 2)) / (Math.PI / 4)) % 8]++;
    speedBins[speed < full / 3 ? 0 : speed < full ? 1 : 2]++;
  }
  if (movingCells > 0) {
    for (let i = 0; i < 8; i++) rose[i] /= movingCells;
    for (let i = 0; i < 3; i++) speedBins[i] /= movingCells;
  }

  const pct = (speed) => Math.round((speed / renderer.width) * 100);
  const camera = readings.camera;
  const cameraSpeed = Math.hypot(camera.dx, camera.dy);
  // The median shift speaks for the camera only when at least half the frame
  // is measured; under 2.5% of the width per second it is read as still
  // (moving things among the measured cells drag the median a little).
  const cameraPart = camera.share < 0.5 ? ''
    : cameraSpeed >= renderer.width * 0.025 ? ` · camera ${sector(Math.atan2(camera.dy, camera.dx))[0]} ${pct(cameraSpeed)}%/s`
      : ' · camera still';

  frame.readings = {
    mode: 'flow',
    ...readings,
    cameraSpeed,
    rose,
    speeds: speedBins,
    width: renderer.width,
    height: renderer.height,
    ceiling: velocity.ceiling ?? null,
  };

  if (readings.saturated >= READINGS_SATURATED && readings.moving > 0.01) {
    frame.note(`Motion beyond this gap's reach (over ${pct(velocity.ceiling)}% of width/s): shorten the gap`, 'error');
  } else if (readings.moving < 0.005) {
    frame.note(`nothing moving${cameraPart}`, 'info');
  } else {
    const [arrow, name] = sector(readings.heading);
    const headingPart = readings.coherence < 0.25 ? 'mixed headings' : `${arrow} ${name}`;
    frame.note(`${headingPart} · peak ${pct(readings.peak)}%/s · ${Math.round(readings.moving * 100)}% of frame${cameraPart}`, 'info');
  }
  return frame.readings;
}

export default /** @type {import('./index.js').Mode} */ ({
  id: 'flow',
  label: 'Optical flow',
  blurb: 'How fast and which way each patch of the picture is moving, measured between two frames: as flowing traces, or as colour.',
  help: [
    'A trace is the path a point of the picture followed; its direction and, at true speed, its length are measured. Where traces start is random, and how many there are in a place means nothing: they gather on whatever moves.',
    'Heading colours: right is red, down is yellow-green, left is cyan, up is violet. Plain traces show the line of travel in a still picture, but which way along it only in motion.',
    'An arrow is the measurement at its own grid point: it points the way that patch moves, its length is the speed (full length = the speed range). The grid is fixed to the picture, not to objects, and a point between two movers averages them; small and slow movers can fall between grid points.',
    'Nothing is measured on a flat surface: a plain object carries flow only at its edges and markings.',
    'Along a straight edge only the motion across the edge can be seen.',
    'Fast things need a short gap, slow things a long one: beyond the reach shown under the picture, the answer is wrong, not just weak.',
    'A moving camera makes everything flow.',
    'Measure on limits where flow exists: the mask gate keeps vectors only where the three-frame mask says something moves now; the foreground gate keeps what the background model has not absorbed, so a stopper\'s flow fades out over the absorb time. A mover\'s rim keeps its vectors either way.',
    'A gate is only as good as its mask: what the mask misses (small, far or slow movers, and most of a surface that moves everywhere, like water) loses its flow with it. On motion-everywhere footage leave Measure on at Everything; for slow drift prefer the foreground gate.',
  ],
  data: { kind: 'vector', what: 'R: speed as a share of the speed range; G, B: velocity in picture pixels per second, x to the right and y down' },
  composite: true,
  worker: false,
  needsFloat: true,
  params: [
    { key: 'flowShow', label: 'Show', type: 'select', default: 'particles', options: { 'Particle traces': 'particles', 'Colour': 'colour', 'Arrow grid': 'arrows' } },
    { key: 'flowOnly', label: 'Measure on', type: 'select', default: 'all', options: { 'Everything': 'all', 'Moving (mask)': 'mask', 'Foreground (model)': 'foreground' } },
    { ...THRESHOLD, when: (p) => p.flowOnly !== 'all' },
    { key: 'absorbSeconds', label: 'Absorb after', type: 'range', min: 0.5, max: 20, step: 0.5, default: 4, format: (v) => `${v} s`, when: (p) => p.flowOnly === 'foreground' },
    { key: 'flowGap', label: 'Gap', type: 'range', min: 1, max: 15, step: 1, default: 2, format: asMs },
    SPEED_RANGE,
    { key: 'flowSmoothing', label: 'Smoothing', type: 'range', min: 0, max: 30, step: 1, default: 6, format: asMs },
    ...TRACE_PARAMS.map((param) => ({ ...param, when: (p) => p.flowShow === 'particles' })),
  ],
  lookback: (params) => {
    if (params.flowOnly === 'mask') {
      const [near, far] = maskLookback(params);
      return [Math.min(params.flowGap, near), Math.max(params.flowGap, far)];
    }
    if (params.flowOnly === 'foreground') return [Math.min(params.flowGap, params.frameOffset), Math.max(params.flowGap, params.frameOffset)];
    return [params.flowGap, params.flowGap];
  },
  animates: (params) => params.flowShow === 'particles',
  summary(params) {
    return `Compares frames ${asMs(params.flowGap)} apart. Full brightness is ${params.flowRange}% of the picture's width per second; a shorter gap follows faster motion, a longer one finds slower.`;
  },
  render(frame) {
    const { gl: renderer, params } = frame;
    // The field and its readback are shared stages: measured once, whoever
    // else draws from them.
    const velocity = frame.stages.velocity();
    if (!velocity) {
      renderer.renderBlank('raw', false);
      return false;
    }
    const { width, height } = renderer;
    const full = fullSpeed(params, width);
    // Targets before binds.
    const data = renderer.dataFramebuffer(width, height);
    const field = params.flowShow === 'particles' || params.flowShow === 'arrows' ? particleField(renderer, 'flow', velocity) : null;

    const show = (framebuffer, output) => flowPass(renderer, 'flow:show', SHOW_FRAG, { uVelocity: 0 }, { fb: framebuffer, width, height }, [velocity.tex], (gl, u) => {
      gl.uniform1f(u.uFull, full);
      gl.uniform1f(u.uFloor, full * FLOW_FLOOR);
      gl.uniform1i(u.uOutput, output);
    });
    show(data, 1);
    frame.stages.flowReadings();
    if (params.flowShow === 'arrows') {
      renderArrows(renderer, 'flow', field, {
        minSpeed: full * FLOW_FLOOR,
        fullSpeed: full,
        colour: 'heading',
      });
    } else if (field) {
      renderParticles(renderer, 'flow', field, {
        dt: frame.stepMs / 1000,
        repeat: frame.step === 'repeat',
        pausedDt: frame.pausedDt,
        density: params.traceDensity,
        seconds: params.traceLength / 30,
        minSpeed: full * FLOW_FLOOR,
        fullSpeed: full,
        gain: params.traceGain,
        colour: params.traceColour,
      });
    } else {
      show(renderer.pictureFramebuffer, 0);
    }
    renderer.renderComposite(frame.display, 'raw', false);
    return true;
  },
});
