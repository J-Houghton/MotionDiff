/**
 * Arrow grid: draws a velocity field as a sparse regular grid of arrows.
 *
 * Each arrow is the field sampled at its own grid point: it points the way
 * that patch of the picture is moving, its length is the speed as a share of
 * the speed range (full length = the range), and nothing is drawn where the
 * measurement is not trusted or the motion is below the floor. The grid is
 * fixed to the picture, not to objects.
 *
 * Reads the same reduced field the particles read (app/particles.js), so the
 * one readback is shared when both are used in a session. Stateless apart
 * from reusable buffers: arrows are redrawn from the field every frame.
 */
import { readField } from './flow.js';

/** Picture pixels between arrows, at the processing size. */
export const ARROW_SPACING = 28;
/** A grid point needs at least this share of recent frames measured (matches FLOW_PRESENT). */
const ARROW_PRESENT = 0.25;
/** Shortest shaft still drawn, picture pixels: a reading, not a speck. */
const ARROW_MIN = 4;
/** Head strokes: this share of the shaft, swept back at this angle. */
const HEAD_SHARE = 0.34;
const HEAD_ANGLE = 2.65; // radians from the heading, ±

// Same vertex format as the particle traces: x, y in picture pixels;
// strength 0..1; heading in turns. The hues must match the legend and the
// other heading-coloured views, so the hue() ramp is repeated here.
const LINE_VERT = `#version 300 es
in vec4 aPosition;

uniform vec2 uPicture;
uniform int uHeadingColour;
uniform vec3 uTint;

out vec3 vColour;

vec3 hue(float h) {
  return clamp(abs(fract(h + vec3(0.0, 2.0 / 3.0, 1.0 / 3.0)) * 6.0 - 3.0) - 1.0, 0.0, 1.0);
}

void main() {
  vec2 clip = aPosition.xy / uPicture * 2.0 - 1.0;
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

const TWO_PI = Math.PI * 2;

/** Reusable buffers per renderer: key → { buffers, vertices }. */
const STATES = new WeakMap();

/**
 * Draw the field as arrows into the renderer's picture target (Raw space:
 * black = nothing).
 *
 * @param {object} renderer - WebGLRenderer
 * @param {string} key - Names this caller's buffers
 * @param {{tex, fb, width, height}} field - Reduced velocity field
 *   (app/particles.js particleField): RG = picture px/s, B = presence 0..1
 * @param {object} opts
 * @param {number} opts.minSpeed - Picture px/s below which nothing is drawn
 * @param {number} opts.fullSpeed - Speed drawn at full length and strength
 * @param {'heading'|'plain'} [opts.colour]
 * @returns {{drawn: number}} How many arrows were drawn
 */
export function renderArrows(renderer, key, field, opts) {
  const gl = renderer.gl;
  const { width, height } = renderer;

  let states = STATES.get(renderer);
  if (!states) STATES.set(renderer, (states = new Map()));
  let state = states.get(key);
  if (!state) states.set(key, (state = {}));
  state.buffers = readField(renderer, field, state.buffers);
  const { values } = state.buffers;

  const cols = Math.max(1, Math.floor(width / ARROW_SPACING));
  const rows = Math.max(1, Math.floor(height / ARROW_SPACING));
  const x0 = (width - cols * ARROW_SPACING) / 2 + ARROW_SPACING / 2;
  const y0 = (height - rows * ARROW_SPACING) / 2 + ARROW_SPACING / 2;
  // 3 segments per arrow (shaft and two head strokes), 2 vertices each, 4 floats per vertex.
  const need = cols * rows * 24;
  if (!state.vertices || state.vertices.length < need) state.vertices = new Float32Array(need);
  const v = state.vertices;

  let drawn = 0;
  let at = 0;
  const reach = ARROW_SPACING * 0.85;
  for (let r = 0; r < rows; r++) {
    const y = y0 + r * ARROW_SPACING;
    const fy = Math.min(field.height - 1, Math.max(0, Math.round((y / height) * field.height - 0.5)));
    for (let c = 0; c < cols; c++) {
      const x = x0 + c * ARROW_SPACING;
      const fx = Math.min(field.width - 1, Math.max(0, Math.round((x / width) * field.width - 0.5)));
      const i = (fy * field.width + fx) * 4;
      const vx = values[i];
      const vy = values[i + 1];
      const present = values[i + 2];
      const speed = Math.hypot(vx, vy);
      if (present < ARROW_PRESENT || speed < opts.minSpeed) continue;

      const share = Math.min(1, speed / opts.fullSpeed);
      const len = Math.max(ARROW_MIN, share * reach);
      const strength = 0.45 + 0.55 * share;
      const heading = Math.atan2(vy, vx);
      const turns = heading / TWO_PI;
      const cos = vx / speed;
      const sin = vy / speed;
      // Centred on the grid point, so the grid stays regular whatever the lengths.
      const tailX = x - cos * len * 0.5;
      const tailY = y - sin * len * 0.5;
      const tipX = x + cos * len * 0.5;
      const tipY = y + sin * len * 0.5;
      const head = Math.max(3, len * HEAD_SHARE);

      const put = (ax, ay, bx, by) => {
        v[at++] = ax; v[at++] = ay; v[at++] = strength; v[at++] = turns;
        v[at++] = bx; v[at++] = by; v[at++] = strength; v[at++] = turns;
      };
      put(tailX, tailY, tipX, tipY);
      for (const side of [HEAD_ANGLE, -HEAD_ANGLE]) {
        const a = heading + side;
        put(tipX, tipY, tipX + Math.cos(a) * head, tipY + Math.sin(a) * head);
      }
      drawn++;
    }
  }

  // The picture target holds black; the arrows land on the canvas after the
  // composite, crisp at the backing size (records/design/display-layer.md).
  gl.bindFramebuffer(gl.FRAMEBUFFER, renderer.pictureFramebuffer);
  gl.viewport(0, 0, width, height);
  gl.clearColor(0, 0, 0, 1);
  gl.clear(gl.COLOR_BUFFER_BIT);

  if (drawn > 0) {
    renderer.addOverlay((r) => {
      const g = r.gl;
      const lines = r.program('arrows:lines', LINE_FRAG, {}, LINE_VERT);
      g.useProgram(lines.prog);
      // Vertices are in picture coordinates; the larger viewport rasterises
      // the same clip-space arrows as hairlines.
      g.uniform2f(lines.u.uPicture, width, height);
      g.uniform1i(lines.u.uHeadingColour, opts.colour === 'plain' ? 0 : 1);
      g.uniform3f(lines.u.uTint, 1, 1, 1);
      r.drawLines(v, drawn * 6, null, r.canvasWidth || width, r.canvasHeight || height);
    });
  }
  return { drawn };
}
