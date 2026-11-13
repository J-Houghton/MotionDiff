/**
 * Particle traces: draws what core/particles.js computes.
 *
 * The particles themselves live in JavaScript (a few thousand: the step is
 * cheap, and plain arrays are easy to inspect). Per frame:
 *
 *   velocity field (a small float target, read back)
 *     → stepParticles: one line segment per moving particle
 *     → trail picture: the previous one dimmed, the new segments added
 *     → the mode's picture target (Raw space: black = nothing)
 *
 * The trail picture is feedback state and follows the usual rules: two
 * targets, a frame rendered again while paused redraws without stepping, and
 * everything starts over when the renderer's epoch changes.
 */
import { SEGMENT_STRIDE, createParticles, particleCount, stepParticles, traceFade } from '../core/particles.js';
import { FLOW_PRELUDE, flowPass, readField } from './flow.js';

/** The field the particles read is reduced until it is at most this wide. */
export const FIELD_MAX_WIDTH = 160;

// Mean of factor×factor blocks of a velocity texture (image coordinates, as
// in app/flow.js), so the readback stays small.
const FIELD_FRAG = `${FLOW_PRELUDE}
uniform sampler2D uSource;
uniform int uFactor;

void main() {
  ivec2 p = here() * uFactor;
  vec4 sum = vec4(0.0);
  for (int dy = 0; dy < uFactor; dy++) {
    for (int dx = 0; dx < uFactor; dx++) sum += px(uSource, p + ivec2(dx, dy));
  }
  fragColor = sum / float(uFactor * uFactor);
}`;

// The trail one step older. Whole 8-bit levels, rounded down, so a faint
// trace always reaches black instead of sticking at a level or two.
const FADE_FRAG = `#version 300 es
precision highp float;

uniform sampler2D uTrail;
uniform float uKeep;

out vec4 fragColor;

void main() {
  vec3 trail = texelFetch(uTrail, ivec2(gl_FragCoord.xy), 0).rgb;
  fragColor = vec4(floor(trail * 255.0 * uKeep) / 255.0, 1.0);
}`;

const SHOW_FRAG = `#version 300 es
precision highp float;

uniform sampler2D uTrail;

out vec4 fragColor;

void main() {
  fragColor = vec4(texelFetch(uTrail, ivec2(gl_FragCoord.xy), 0).rgb, 1.0);
}`;

// A segment's end: picture pixels (y down) to clip space; colour from the
// heading (the same hues as motion history) or one tint.
const LINE_VERT = `#version 300 es
in vec4 aPosition;       // x, y in picture pixels; strength 0..1; heading in turns

uniform vec2 uPicture;
uniform int uHeadingColour;
uniform vec3 uTint;

out vec3 vColour;

vec3 hue(float h) {
  return clamp(abs(fract(h + vec3(0.0, 2.0 / 3.0, 1.0 / 3.0)) * 6.0 - 3.0) - 1.0, 0.0, 1.0);
}

void main() {
  vec2 clip = aPosition.xy / uPicture * 2.0 - 1.0;
  // Image row 0 is the top of the picture, which is the top of clip space.
  gl_Position = vec4(clip.x, -clip.y, 0.0, 1.0);
  vColour = (uHeadingColour == 1 ? hue(aPosition.w) : uTint) * aPosition.z;
}`;

const LINE_FRAG = `#version 300 es
precision highp float;

in vec3 vColour;
out vec4 fragColor;

void main() {
  fragColor = vec4(vColour, 1.0);
}`;

const hexToUnit = (hex, fallback) => {
  const value = /^#[0-9a-f]{6}$/i.test(hex || '') ? hex : fallback;
  return [1, 3, 5].map((at) => parseInt(value.slice(at, at + 2), 16) / 255);
};

/** Per renderer: key → { particles, vertices, buffers, epoch, current, drawn }. */
const STATES = new WeakMap();

/**
 * Reduce a float texture by whole-block means until it is at most
 * `maxWidth` wide: small enough to read back every frame.
 * @param {object} renderer
 * @param {string} key - Names the target
 * @param {{tex, width, height}} source
 * @param {number} maxWidth
 * @returns {{tex, fb, width, height}}
 */
export function reduceField(renderer, key, source, maxWidth) {
  const factor = Math.max(1, Math.ceil(source.width / maxWidth));
  const target = renderer.target(key, Math.ceil(source.width / factor), Math.ceil(source.height / factor), { float: true });
  return flowPass(renderer, 'particles:field', FIELD_FRAG, { uSource: 0 }, target, [source.tex], (gl, u) => gl.uniform1i(u.uFactor, factor));
}

/**
 * Reduce a velocity texture to the size the particles read.
 * @param {object} renderer
 * @param {string} key
 * @param {{tex, width, height}} velocity - RG = picture pixels per second
 * @returns {{tex, fb, width, height}}
 */
export function particleField(renderer, key, velocity) {
  return reduceField(renderer, `${key}:field`, velocity, FIELD_MAX_WIDTH);
}

/**
 * Step the particles through a velocity field and draw their traces into
 * the renderer's picture target.
 *
 * @param {object} renderer - WebGLRenderer
 * @param {string} key - Names this caller's state and targets
 * @param {{tex, fb, width, height}} field - From particleField
 * @param {object} opts
 * @param {number} opts.dt - Media time since the previous frame, seconds
 * @param {boolean} [opts.repeat] - The same frame again: redraw, do not step
 * @param {number} opts.density - Particles per 1,000 picture pixels
 * @param {number} opts.seconds - How long a trace stays visible
 * @param {number} opts.minSpeed - Picture pixels per second below which nothing is drawn
 * @param {number} opts.fullSpeed - Speed drawn at full strength
 * @param {number} [opts.gain] - Steps are this many times the measured movement
 * @param {'heading'|'plain'} [opts.colour]
 * @param {string} [opts.tint] - Hex, for 'plain'
 * @returns {{moving: number, count: number}} How many particles drew a segment, of how many
 */
export function renderParticles(renderer, key, field, opts) {
  const gl = renderer.gl;
  const { width, height } = renderer;
  // Targets before binds (creating one binds its texture).
  const trails = [renderer.target(`${key}:trail0`, width, height), renderer.target(`${key}:trail1`, width, height)];

  let states = STATES.get(renderer);
  if (!states) STATES.set(renderer, (states = new Map()));
  let state = states.get(key);
  const count = particleCount(width, height, opts.density);
  if (!state || state.epoch !== renderer.epoch || trails[0].fresh || trails[1].fresh || state.particles.count !== count) {
    state = {
      epoch: renderer.epoch,
      particles: createParticles(count, 20261113),
      vertices: new Float32Array(count * 8),
      buffers: state?.buffers,
      current: 0,
      drawn: false,
      moving: 0,
    };
    states.set(key, state);
    for (const trail of trails) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, trail.fb);
      gl.clearColor(0, 0, 0, 1);
      gl.clear(gl.COLOR_BUFFER_BIT);
      trail.fresh = false;
    }
  }

  if (!(opts.repeat && state.drawn)) {
    state.buffers = readField(renderer, field, state.buffers);
    const moving = stepParticles(state.particles, { width: field.width, height: field.height, values: state.buffers.values, stride: 4 }, opts.dt, {
      width, height, minSpeed: opts.minSpeed, fullSpeed: opts.fullSpeed, gain: opts.gain,
    });
    const { segments } = state.particles;
    const { vertices } = state;
    for (let n = 0; n < moving; n++) {
      const s = n * SEGMENT_STRIDE;
      const v = n * 8;
      vertices[v] = segments[s];
      vertices[v + 1] = segments[s + 1];
      vertices[v + 4] = segments[s + 2];
      vertices[v + 5] = segments[s + 3];
      vertices[v + 2] = vertices[v + 6] = segments[s + 4];
      vertices[v + 3] = vertices[v + 7] = segments[s + 5];
    }

    const from = trails[state.current];
    const to = trails[1 - state.current];
    const fade = renderer.program('particles:fade', FADE_FRAG, { uTrail: 0 });
    gl.useProgram(fade.prog);
    renderer.bind(0, from.tex);
    gl.uniform1f(fade.u.uKeep, traceFade(opts.dt, opts.seconds));
    renderer.draw(to.fb, width, height);

    const lines = renderer.program('particles:lines', LINE_FRAG, {}, LINE_VERT);
    gl.useProgram(lines.prog);
    gl.uniform2f(lines.u.uPicture, width, height);
    gl.uniform1i(lines.u.uHeadingColour, opts.colour === 'plain' ? 0 : 1);
    gl.uniform3fv(lines.u.uTint, hexToUnit(opts.tint, '#ffffff'));
    renderer.drawLines(vertices, moving * 2, to.fb, width, height);

    state.current = 1 - state.current;
    state.drawn = true;
    state.moving = moving;
  }

  const show = renderer.program('particles:show', SHOW_FRAG, { uTrail: 0 });
  gl.useProgram(show.prog);
  renderer.bind(0, trails[state.current].tex);
  renderer.draw(renderer.pictureFramebuffer, width, height);
  return { moving: state.moving, count };
}
