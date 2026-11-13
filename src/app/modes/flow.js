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
import { FLOW_MAX_STEP } from '../../core/flow.js';
import { lookbackTime } from '../../core/timebase.js';
import { FLOW_PRELUDE, flowBetween, flowLuma, flowPass, flowSmooth } from '../flow.js';
import { particleField, renderParticles } from '../particles.js';
import { asMs } from './params.js';

/** Flow is solved on a copy of the frame at most this wide. */
export const FLOW_WIDTH = 320;
/** A vector counts fully from this confidence up (levels² per pixel², see core/flow.js). */
export const FLOW_TRUSTED = 4;
/** A place counts as measured while at least this share of recent frames gave a trusted vector there. */
export const FLOW_PRESENT = 0.25;
/** Motion slower than this share of the speed range is not drawn. */
export const FLOW_FLOOR = 0.04;

/** Whole factor that brings the processing width down to the working size. */
export const flowFactor = (width) => Math.max(1, Math.ceil(width / FLOW_WIDTH));
/** Pyramid sizes for a working width: four where the smallest still has something to match. */
export const flowLevels = (workingWidth) => (workingWidth >= 240 ? 4 : 3);
/** The largest shift (working pixels per gap) the pyramid finds reliably: about half its theoretical reach. */
export const flowReach = (levels) => (FLOW_MAX_STEP * (2 ** levels - 1)) / 2;

// Flow (working pixels per gap) → velocity (picture pixels per second).
const VELOCITY_FRAG = `${FLOW_PRELUDE}
uniform sampler2D uFlow;
uniform float uScale;

void main() {
  vec3 flow = px(uFlow, here()).rgb;
  fragColor = vec4(flow.rg * uScale, flow.b, 1.0);
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
const fullSpeed = (params, width) => (params.flowRange / 100) * width;

/**
 * The velocity field for this frame, or null while there is no older frame.
 * @param {object} frame - The per-frame context from Pipeline.process
 * @returns {{tex, fb, width, height}|null} RG = picture pixels per second,
 *   averaged over time by confidence, zero where nothing is measured;
 *   B = how present a measurement is, 0..1
 */
export function flowVelocity(frame) {
  const { gl: renderer, ring, time, params } = frame;
  const age = ring.nearest(lookbackTime(time, params.flowGap, 0, 0), time);
  if (age < 0) return null;
  const gapSeconds = time - ring.timeAt(age);
  if (!(gapSeconds > 1e-4)) return null;

  const factor = flowFactor(renderer.width);
  const current = flowLuma(renderer, 'flow:current', factor);
  const older = flowLuma(renderer, 'flow:older', factor, ring.slotAt(age));
  const velocity = renderer.target('flow:velocity', current.width, current.height, { float: true });
  const flow = flowBetween(renderer, 'flow', older, current, { levels: flowLevels(current.width) });
  flowPass(renderer, 'flow:velocity', VELOCITY_FRAG, { uFlow: 0 }, velocity, [flow.tex], (gl, u) => gl.uniform1f(u.uScale, factor / gapSeconds));

  const seconds = params.flowSmoothing / 30;
  return flowSmooth(renderer, 'flow', velocity, {
    alpha: seconds > 0 ? 1 - Math.exp(-(frame.stepMs / 1000) / seconds) : 1,
    trusted: FLOW_TRUSTED,
    floor: FLOW_PRESENT,
    repeat: frame.step === 'repeat',
  });
}

export default {
  id: 'flow',
  label: 'Optical flow',
  blurb: 'How fast and which way each patch of the picture is moving, measured between two frames: as flowing traces, or as colour.',
  help: [
    'A trace is the path a point of the picture followed; its direction and, at true speed, its length are measured. Where traces start is random, and how many there are in a place means nothing: they gather on whatever moves.',
    'Heading colours: right is red, down is yellow-green, left is cyan, up is violet.',
    'Nothing is measured on a flat surface: a plain object carries flow only at its edges and markings.',
    'Along a straight edge only the motion across the edge can be seen.',
    'Fast things need a short gap, slow things a long one: beyond the reach shown under the picture, the answer is wrong, not just weak.',
    'A moving camera makes everything flow.',
    'Traces are drawn at the processing size, so they are soft when shown large.',
  ],
  data: { kind: 'vector', what: 'R: speed as a share of the speed range; G, B: velocity in picture pixels per second, x to the right and y down' },
  composite: true,
  worker: false,
  needsFloat: true,
  params: [
    { key: 'flowShow', label: 'Show', type: 'select', default: 'particles', options: { 'Particle traces': 'particles', 'Colour': 'colour' } },
    { key: 'flowGap', label: 'Gap', type: 'range', min: 1, max: 15, step: 1, default: 2, format: asMs },
    SPEED_RANGE,
    { key: 'flowSmoothing', label: 'Smoothing', type: 'range', min: 0, max: 30, step: 1, default: 6, format: asMs },
    ...TRACE_PARAMS.map((param) => ({ ...param, when: (p) => p.flowShow === 'particles' })),
  ],
  lookback: (params) => [params.flowGap, params.flowGap],
  summary(params) {
    return `Compares frames ${asMs(params.flowGap)} apart. Full brightness is ${params.flowRange}% of the picture's width per second; a shorter gap follows faster motion, a longer one finds slower.`;
  },
  render(frame) {
    const { gl: renderer, params } = frame;
    const velocity = flowVelocity(frame);
    if (!velocity) {
      renderer.renderBlank('raw', false);
      return false;
    }
    const { width, height } = renderer;
    const full = fullSpeed(params, width);
    // Targets before binds.
    const data = renderer.dataFramebuffer(width, height);
    const field = params.flowShow === 'particles' ? particleField(renderer, 'flow', velocity) : null;

    const show = (framebuffer, output) => flowPass(renderer, 'flow:show', SHOW_FRAG, { uVelocity: 0 }, { fb: framebuffer, width, height }, [velocity.tex], (gl, u) => {
      gl.uniform1f(u.uFull, full);
      gl.uniform1f(u.uFloor, full * FLOW_FLOOR);
      gl.uniform1i(u.uOutput, output);
    });
    show(data, 1);
    if (field) {
      renderParticles(renderer, 'flow', field, {
        dt: frame.stepMs / 1000,
        repeat: frame.step === 'repeat',
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
};
