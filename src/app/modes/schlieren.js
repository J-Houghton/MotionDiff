/**
 * Schlieren: hot air and gas made visible by how they shift the background.
 *
 * core/schlieren.js says what is measured and how it is judged; the solve is
 * core/flow.js through app/flow.js. Per frame:
 *
 *   luma of the frame, in levels
 *     → a short running average of it (less noise)           ┐ two feedback
 *     → the reference: a long running average, or held still ┘ states
 *     → shift of every patch between reference and now (Lucas–Kanade, two
 *       sizes, no "nothing moved" test: the shifts are far below the noise
 *       of single pixels)
 *     → a small grid of it read back: the camera's own shift (the median),
 *       how much of the picture is measurable, the noise floor; from those
 *       the note on the status line
 *     → picture: knife edge (Posy space, 128 = no shift), strength,
 *       direction, the setup check, or particle traces; and the data field
 *
 * Traces follow how the PATTERN of shifts moves from one frame to the next
 * (flow of the schlieren picture itself): the travel of the eddies, not the
 * shift, which is not a velocity.
 *
 * Needs float render targets.
 */
import { FLOW_NOISE, globalShift } from '../../core/flow.js';
import { noiseFloor, referenceAlpha, setupProblem } from '../../core/schlieren.js';
import { FLOW_PRELUDE, flowBetween, flowLuma, flowPass, flowSmooth, pingPong, readField } from '../flow.js';
import { particleField, reduceField, renderParticles } from '../particles.js';
import { FLOW_FLOOR, FLOW_PRESENT, FLOW_TRUSTED, SPEED_RANGE, TRACE_PARAMS, flowLevels } from './flow.js';
import { asMs } from './params.js';

/** Shifts are measured on a copy of the frame at most this wide: the full processing size up to 1280 px, so a fine background can be resolved by raising the processing width. */
export const SCHLIEREN_WIDTH = 1280;
/** A shift counts fully from this confidence up; nothing is drawn below half of it. */
export const SCHLIEREN_TRUSTED = 20;
/** The grid read back for the camera shift and the setup check is at most this wide. */
const GRID_WIDTH = 64;
/** The picture whose movement the traces follow is at most this wide. */
const TRACK_WIDTH = 320;
/** In that picture, a full-scale shift is this many levels. */
const TRACK_LEVELS = 64;
/** Time constant of the running average of the eddies' velocity, seconds. */
const TRACK_SECONDS = 0.4;

// Mirrors averageStep.
const AVERAGE_FRAG = `${FLOW_PRELUDE}
uniform sampler2D uPrevious;
uniform sampler2D uFrame;
uniform float uAlpha;

void main() {
  ivec2 p = here();
  float previous = px(uPrevious, p).r;
  fragColor = vec4(previous + (px(uFrame, p).r - previous) * uAlpha, 0.0, 0.0, 1.0);
}`;

// What the functions of core/schlieren.js compute per pixel, shared by the passes below.
const SHIFT = `
uniform sampler2D uFlow;     // RG = shift in working pixels, B = confidence
uniform vec2 uCamera;        // the whole picture's shift, working pixels
uniform float uFull;         // shift drawn at full scale, working pixels
uniform float uTrusted;

// xy = shift with the camera's taken out; z = weight (mirrors shiftWeight)
vec3 shiftAt(vec2 at) {
  vec3 flow = between(uFlow, at).rgb;
  return vec3(flow.rg - uCamera, clamp((flow.b / uTrusted - 0.5) * 2.0, 0.0, 1.0));
}`;

// The picture, or the data field. Knife edge is in Posy space, the rest in Raw.
const SHOW_FRAG = `${FLOW_PRELUDE}
${SHIFT}
uniform sampler2D uCurrent;  // the frame, for the setup check
uniform int uView;           // 0 knife edge, 1 strength, 2 direction, 3 setup check
uniform int uAxis;           // knife edge: 0 = sideways shifts, 1 = up-down shifts
uniform int uOutput;         // 0 = picture, 1 = data
uniform float uFactor;       // working pixels → picture pixels

vec3 hue(float h) {
  return clamp(abs(fract(h + vec3(0.0, 2.0 / 3.0, 1.0 / 3.0)) * 6.0 - 3.0) - 1.0, 0.0, 1.0);
}

void main() {
  ivec2 p = here();
  vec3 s = shiftAt((vec2(p) + 0.5) * vec2(textureSize(uFlow, 0)) / vec2(uSize) - 0.5);
  float strength = min(1.0, length(s.xy) / uFull) * s.z;    // mirrors shiftStrength
  if (uOutput == 1) {
    // R = strength, G/B = the shift in picture pixels (x right, y down)
    fragColor = vec4(strength, s.xy * uFactor * step(0.001, s.z), 1.0);
    return;
  }
  vec3 colour;
  if (uView == 0) {
    // mirrors knifeEdge
    float part = clamp((uAxis == 1 ? s.y : s.x) / uFull, -1.0, 1.0);
    colour = vec3((128.0 + part * 127.0 * s.z) / 255.0);
  } else if (uView == 1) {
    colour = min(vec3(1.0), vec3(1.0, 0.72, 0.35) * strength + vec3(strength * strength * strength));
  } else if (uView == 2) {
    colour = hue(atan(s.y, s.x) / 6.2831853) * strength;
  } else {
    // The frame, dimmed; hatched in red where nothing can be measured.
    vec3 frame = texelFetch(uCurrent, ivec2(gl_FragCoord.xy), 0).rgb;
    float grey = dot(frame, vec3(0.2126, 0.7152, 0.0722)) * 0.55;
    float hatch = step(0.5, fract(float(p.x + p.y) / 8.0));
    colour = mix(mix(vec3(grey), vec3(0.85, 0.1, 0.1), 0.35 + 0.45 * hatch), vec3(grey), s.z);
  }
  fragColor = vec4(colour, 1.0);
}`;

// The schlieren picture as one signed number per pixel, for following its movement.
const TRACK_FRAG = `${FLOW_PRELUDE}
${SHIFT}
uniform float uLevels;

void main() {
  vec3 s = shiftAt((vec2(here()) + 0.5) * vec2(textureSize(uFlow, 0)) / vec2(uSize) - 0.5);
  fragColor = vec4((s.x + s.y) / uFull * uLevels * s.z, 0.0, 0.0, 1.0);
}`;

// Flow (pixels of the tracking picture per frame) → velocity (picture pixels per second).
const VELOCITY_FRAG = `${FLOW_PRELUDE}
uniform sampler2D uFlow;
uniform float uScale;

void main() {
  vec3 flow = px(uFlow, here()).rgb;
  fragColor = vec4(flow.rg * uScale, flow.b, 1.0);
}`;

const VIEWS = { knife: 0, strength: 1, direction: 2, check: 3 };

/** What the grid said last time, per renderer. */
const SETUPS = new WeakMap();

const NOTES = {
  plain: (s) => [`Schlieren: only ${Math.round(s.usable * 100)}% of the picture has texture to measure against. Put a patterned background behind the hot air.`, 'error'],
  moved: (s) => [`Schlieren: the camera has moved ${Math.hypot(s.camera.dx, s.camera.dy).toFixed(1)} px since the reference was held. Prop it still, then release and hold again.`, 'error'],
  shaking: () => ['Schlieren: the camera is moving. Prop it against something solid.', 'error'],
  settling: () => ['Schlieren: settling the reference…', 'info'],
};

/**
 * Measure the shift field for this frame.
 * @param {object} frame - The per-frame context from Pipeline.process
 * @returns {{flow: object, factor: number, setup: object}} flow: RG = shift in
 *   working pixels, B = confidence; setup: camera shift (working pixels),
 *   usable share, noise floor (working pixels), frames seen
 */
function measure(frame) {
  const { gl: renderer, params } = frame;
  const gl = renderer.gl;
  const repeat = frame.step === 'repeat';
  const factor = Math.max(1, Math.ceil(renderer.width / SCHLIEREN_WIDTH));
  const luma = flowLuma(renderer, 'schlieren:luma', factor);
  const { width, height } = luma;
  // Targets before binds.
  const float = { float: true };
  const currents = [renderer.target('schlieren:now0', width, height, float), renderer.target('schlieren:now1', width, height, float)];
  const references = [renderer.target('schlieren:ref0', width, height, float), renderer.target('schlieren:ref1', width, height, float)];

  const average = (state, alpha) => {
    if (state.held) return state.to;
    return flowPass(renderer, 'schlieren:average', AVERAGE_FRAG, { uPrevious: 0, uFrame: 1 }, state.to, [state.from.tex, luma.tex], (g, u) => g.uniform1f(u.uAlpha, state.empty ? 1 : alpha));
  };
  const smoothSeconds = params.schlierenSmooth / 30;
  const current = average(pingPong(renderer, 'schlieren:now', currents, repeat),
    smoothSeconds > 0 ? 1 - Math.exp(-(frame.stepMs / 1000) / smoothSeconds) : 1);
  const refState = pingPong(renderer, 'schlieren:ref', references, repeat, params.schlierenHold);
  const reference = average(refState, referenceAlpha(frame.stepMs, params.schlierenReference / 30, refState.seen, false));

  const flow = flowBetween(renderer, 'schlieren', reference, current, { levels: 2, radius: params.schlierenWindow, noise: FLOW_NOISE, still: 0 });

  // The grid: read back for the camera's shift and the state of the setup.
  let setup = SETUPS.get(renderer);
  if (!setup || setup.epoch !== renderer.epoch) SETUPS.set(renderer, (setup = { epoch: renderer.epoch, camera: { dx: 0, dy: 0 }, previous: null, usable: 1, noise: 0 }));
  if (!repeat) {
    const grid = reduceField(renderer, 'schlieren:grid', flow, GRID_WIDTH);
    setup.buffers = readField(renderer, grid, setup.buffers);
    const cells = grid.width * grid.height;
    const shift = globalShift(setup.buffers.values, cells, SCHLIEREN_TRUSTED, 4);
    setup.previous = setup.camera;
    setup.camera = params.schlierenSteady ? { dx: shift.dx, dy: shift.dy } : { dx: 0, dy: 0 };
    setup.usable = shift.share;
    setup.noise = noiseFloor(setup.buffers.values, cells, 4, SCHLIEREN_TRUSTED, setup.camera);
    setup.seen = refState.seen;
    // Judge the setup on the measured shift, whether or not it is being cancelled.
    const problem = setupProblem({
      usable: setup.usable,
      camera: { dx: shift.dx * factor, dy: shift.dy * factor },
      previous: setup.measured || null,
      seen: refState.seen,
      held: params.schlierenHold,
    });
    setup.measured = { dx: shift.dx * factor, dy: shift.dy * factor };
    if (problem) {
      frame.note?.(...NOTES[problem]({ usable: setup.usable, camera: setup.measured }));
    } else {
      const floor = Math.max(0.01, setup.noise * factor * 2.5);
      frame.note?.(`Schlieren: measuring ${Math.round(setup.usable * 100)}% of the picture. Shifts above about ${floor.toFixed(2)} px stand out. ${params.schlierenHold ? 'Reference held.' : 'Reference follows: steady hot air fades out; hold it to keep everything.'}`, 'info');
    }
  }
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  return { flow, factor, setup };
}

export default {
  id: 'schlieren',
  label: 'Schlieren',
  blurb: 'Hot air and gas made visible: they bend light, so a textured background seen through them shifts by a fraction of a pixel, and that shift is measured and drawn.',
  help: [
    'What it shows: where the air is unevenly hot (the shift follows the change in air density across the line of sight). It is not a speed.',
    'Setup: prop the camera so it cannot move; put a detailed background a metre or so behind the hot air (print public/schlieren-pattern.svg, or use brick, gravel, foliage, a bookshelf); lock focus and exposure on the background. The Setup check view hatches in red whatever cannot be measured.',
    'Reference: by default it follows the scene, so only hot air that changes is shown and a steady plume fades out. Let it settle with nothing hot in view, switch on Hold reference, then light the candle: everything is shown.',
    'Knife edge is the classic look: light where the background is pushed one way, dark where it is pushed the other. Strength and Direction show the size and the heading of the shift.',
    'Traces follow how the pattern of hot air travels from frame to frame: the movement of its eddies. That is slower than the air itself, and there is nothing to follow where the flow is smooth.',
    'Nothing is drawn where the background is plain. Lamp flicker, auto-exposure and focus hunting all read as signal; video compression smooths away the smallest shifts.',
    'Sensitivity is the shift drawn at full strength. A larger window and more smoothing see weaker plumes, more coarsely and more slowly.',
  ],
  data: { kind: 'vector', what: 'R: size of the shift as a share of the sensitivity setting; G, B: the shift in picture pixels, x to the right and y down, with the camera\'s own shift taken out' },
  composite: true,
  worker: false,
  needsFloat: true,
  params: [
    { key: 'schlierenShow', label: 'Show', type: 'select', default: 'knife', options: { 'Knife edge': 'knife', 'Strength': 'strength', 'Direction': 'direction', 'Particle traces': 'traces', 'Setup check': 'check' } },
    { key: 'schlierenHold', label: 'Hold reference', type: 'toggle', default: false },
    { key: 'schlierenRange', label: 'Sensitivity', type: 'range', min: 2, max: 200, step: 1, default: 25, format: (v) => `${(v / 100).toFixed(2)} px` },
    { key: 'schlierenWindow', label: 'Window', type: 'range', min: 2, max: 7, step: 1, default: 4, format: (v) => `${2 * v + 1} px` },
    { key: 'schlierenSmooth', label: 'Smoothing', type: 'range', min: 0, max: 15, step: 1, default: 1, format: asMs },
    { key: 'schlierenReference', label: 'Reference time', type: 'range', min: 15, max: 300, step: 15, default: 60, format: (v) => `${(v / 30).toFixed(1)} s`, when: (p) => !p.schlierenHold },
    { key: 'schlierenAxis', label: 'Knife shows', type: 'select', default: 'x', options: { 'Sideways shifts': 'x', 'Up-down shifts': 'y' }, when: (p) => p.schlierenShow === 'knife' },
    { key: 'schlierenSteady', label: 'Cancel camera shift', type: 'toggle', default: true },
    { ...SPEED_RANGE, when: (p) => p.schlierenShow === 'traces' },
    ...TRACE_PARAMS.map((param) => ({ ...param, when: (p) => p.schlierenShow === 'traces' })),
  ],
  lookback: () => [2, 2],
  summary(params) {
    const side = 2 * params.schlierenWindow + 1;
    const against = params.schlierenHold ? 'a held reference' : `the average of the last ${(params.schlierenReference / 30).toFixed(1)} s`;
    return `Shifts of the background up to ${(params.schlierenRange / 100).toFixed(2)} px, measured over ${side}×${side} pixel patches against ${against}.`;
  },
  render(frame) {
    const { gl: renderer, params } = frame;
    const { width, height } = renderer;
    const { flow, factor, setup } = measure(frame);
    const full = params.schlierenRange / 100 / factor;
    const traces = params.schlierenShow === 'traces';
    // Targets before binds.
    const data = renderer.dataFramebuffer(width, height);
    const trackWidth = Math.min(flow.width, TRACK_WIDTH);
    const trackHeight = Math.round((flow.height * trackWidth) / flow.width);
    const tracks = traces
      ? [renderer.target('schlieren:track0', trackWidth, trackHeight, { float: true }), renderer.target('schlieren:track1', trackWidth, trackHeight, { float: true })]
      : null;
    const velocity = traces ? renderer.target('schlieren:velocity', trackWidth, trackHeight, { float: true }) : null;

    const shift = (gl, u) => {
      gl.uniform2f(u.uCamera, setup.camera.dx, setup.camera.dy);
      gl.uniform1f(u.uFull, full);
      gl.uniform1f(u.uTrusted, SCHLIEREN_TRUSTED);
    };
    const show = (framebuffer, output) => flowPass(renderer, 'schlieren:show', SHOW_FRAG, { uFlow: 0, uCurrent: 1 }, { fb: framebuffer, width, height }, [flow.tex, renderer.currentTexture], (gl, u) => {
      shift(gl, u);
      gl.uniform1i(u.uView, VIEWS[params.schlierenShow] ?? 1);
      gl.uniform1i(u.uAxis, params.schlierenAxis === 'y' ? 1 : 0);
      gl.uniform1i(u.uOutput, output);
      gl.uniform1f(u.uFactor, factor);
    });
    show(data, 1);

    if (!traces) {
      show(renderer.pictureFramebuffer, 0);
      const knife = params.schlierenShow === 'knife';
      // The setup check is a picture of its own: it is never blended onto the frame.
      renderer.renderComposite(params.schlierenShow === 'check' ? 'diff' : frame.display, knife ? 'posy' : 'raw', false);
      return true;
    }

    // Traces: follow the schlieren picture from the previous frame to this one.
    const repeat = frame.step === 'repeat';
    const track = pingPong(renderer, 'schlieren:track', tracks, repeat);
    flowPass(renderer, 'schlieren:track', TRACK_FRAG, { uFlow: 0 }, track.to, [flow.tex], (gl, u) => {
      shift(gl, u);
      gl.uniform1f(u.uLevels, TRACK_LEVELS);
    });
    const seconds = frame.stepMs / 1000;
    if (track.empty || !(seconds > 0)) {
      renderer.renderBlank('raw', false);
      // The data field was drawn: the frame does have a measurement.
      renderer.dataFramebuffer(width, height);
      return true;
    }
    const moved = flowBetween(renderer, 'schlieren:move', track.from, track.to, { levels: flowLevels(trackWidth), noise: 16 });
    flowPass(renderer, 'flow:velocity', VELOCITY_FRAG, { uFlow: 0 }, velocity, [moved.tex], (gl, u) => gl.uniform1f(u.uScale, width / trackWidth / seconds));
    const smoothed = flowSmooth(renderer, 'schlieren:move', velocity, {
      alpha: 1 - Math.exp(-seconds / TRACK_SECONDS),
      trusted: FLOW_TRUSTED,
      floor: FLOW_PRESENT,
      repeat,
    });
    const fullSpeed = (params.flowRange / 100) * width;
    renderParticles(renderer, 'schlieren', particleField(renderer, 'schlieren', smoothed), {
      dt: seconds,
      repeat,
      density: params.traceDensity,
      seconds: params.traceLength / 30,
      minSpeed: fullSpeed * FLOW_FLOOR,
      fullSpeed,
      gain: params.traceGain,
      colour: params.traceColour,
    });
    renderer.renderComposite(frame.display, 'raw', false);
    return true;
  },
};
