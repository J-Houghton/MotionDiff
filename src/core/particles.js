/**
 * Particle traces through a velocity field, in the manner of a wind map:
 * thousands of points, each carried along by the field for a short life and
 * drawing the path it took.
 *
 * What a trace is: the path one point of the picture followed while the
 * particle lived (a pathline). Each step moves the particle by the field's
 * velocity at its position times the media time that passed, so at gain 1 a
 * step is as long as the measured movement in that interval. Direction and
 * length are read from the field. Where traces START is random, and how many
 * there are in a place is not a measurement: particles that land where
 * nothing moves are re-seeded at once, so traces gather wherever the field
 * is non-zero.
 *
 * Everything runs on media time (seconds), not on counted frames, so the
 * picture is the same at any frame rate or playback speed.
 *
 * Coordinates: pixels of the picture, x to the right, y down. The field is a
 * coarser grid over the same picture, row 0 at the top.
 *
 * There is no shader mirror: this is the only implementation. The app reads
 * the field back from the GPU, steps the particles here, and draws the
 * segments this module writes (app/particles.js).
 *
 * Pure functions only — it imports nothing.
 */

/** Values per particle in `data`: x, y, age (s), life (s). */
export const PARTICLE_STRIDE = 4;
/** Values per segment written by stepParticles: x0, y0, x1, y1, strength, heading. */
export const SEGMENT_STRIDE = 6;

/** A particle lives between these many seconds (chosen at random at birth). */
export const PARTICLE_LIFE = [0.6, 2.4];
/** A particle on a spot with no motion waits about this long before it is re-seeded. */
export const PARTICLE_IDLE_SECONDS = 0.12;
/** A trace fades in over this share of its life, and out over the same at the end. */
export const PARTICLE_FADE_SHARE = 0.15;
/** The slowest trace that is drawn at all is drawn at this share of full strength, so slow motion is still seen. */
export const PARTICLE_FLOOR = 0.45;

/**
 * @param {number} count
 * @param {number} [seed]
 * @returns {{count: number, data: Float32Array, segments: Float32Array, seed: number, born: boolean}}
 *   `born` turns true at the first step, which places every particle.
 */
export function createParticles(count, seed = 1) {
  return {
    count,
    data: new Float32Array(count * PARTICLE_STRIDE),
    segments: new Float32Array(count * SEGMENT_STRIDE),
    seed: seed >>> 0,
    born: false,
  };
}

/** The next pseudo-random number in 0..1 (the generator's state lives on the particles). */
function random(particles) {
  particles.seed = (Math.imul(particles.seed, 1664525) + 1013904223) >>> 0;
  return particles.seed / 4294967296;
}

/**
 * Velocity at a picture position, between the field's cells (bilinear; a
 * cell's value sits at its centre; beyond the edge the edge repeats).
 *
 * @param {{width: number, height: number, values: Float32Array, stride: number}} field
 *   values: `stride` numbers per cell, the first two are vx, vy in picture pixels per second
 * @param {number} x - Picture pixels
 * @param {number} y
 * @param {number} pictureWidth
 * @param {number} pictureHeight
 * @param {number[]} out - Written: vx, vy
 * @returns {number[]} out
 */
export function sampleField(field, x, y, pictureWidth, pictureHeight, out) {
  const { width, height, values, stride } = field;
  const fx = (x / pictureWidth) * width - 0.5;
  const fy = (y / pictureHeight) * height - 0.5;
  const x0 = Math.floor(fx);
  const y0 = Math.floor(fy);
  const tx = fx - x0;
  const ty = fy - y0;
  const xa = x0 < 0 ? 0 : x0 > width - 1 ? width - 1 : x0;
  const xb = x0 + 1 < 0 ? 0 : x0 + 1 > width - 1 ? width - 1 : x0 + 1;
  const ya = (y0 < 0 ? 0 : y0 > height - 1 ? height - 1 : y0) * width;
  const yb = (y0 + 1 < 0 ? 0 : y0 + 1 > height - 1 ? height - 1 : y0 + 1) * width;
  for (let c = 0; c < 2; c++) {
    const top = values[(ya + xa) * stride + c] + (values[(ya + xb) * stride + c] - values[(ya + xa) * stride + c]) * tx;
    const bottom = values[(yb + xa) * stride + c] + (values[(yb + xb) * stride + c] - values[(yb + xa) * stride + c]) * tx;
    out[c] = top + (bottom - top) * ty;
  }
  return out;
}

const VELOCITY = [0, 0];

/**
 * Move every particle by `dt` seconds of the field and write the segments
 * to draw.
 *
 * @param {object} particles - From createParticles
 * @param {{width, height, values, stride}} field - See sampleField
 * @param {number} dt - Media time since the previous step, seconds
 * @param {object} options
 * @param {number} options.width - Picture size, pixels
 * @param {number} options.height
 * @param {number} options.minSpeed - Below this many pixels per second a spot counts as still
 * @param {number} options.fullSpeed - Speed drawn at full strength, pixels per second
 * @param {number} [options.gain] - Steps are this many times the measured movement (1 = true length)
 * @returns {number} How many segments were written to particles.segments
 *   (SEGMENT_STRIDE values each: x0, y0, x1, y1; strength 0..1 from speed
 *   (PARTICLE_FLOOR at the slowest, 1 at fullSpeed) and the fade at both ends
 *   of a life; heading in turns, 0 = right, 0.25 = down)
 */
export function stepParticles(particles, field, dt, options) {
  const { data, segments, count } = particles;
  const { width, height, minSpeed, fullSpeed } = options;
  const gain = options.gain ?? 1;
  const [lifeMin, lifeMax] = PARTICLE_LIFE;
  // The chance that a still particle is moved on during this step.
  const reseed = 1 - Math.exp(-dt / PARTICLE_IDLE_SECONDS);
  const firstStep = !particles.born;
  particles.born = true;

  let written = 0;
  for (let n = 0; n < count; n++) {
    const i = n * PARTICLE_STRIDE;
    if (firstStep) {
      place(particles, i, width, height, lifeMin, lifeMax);
      // Spread the first deaths out, so the whole crowd does not die together.
      data[i + 2] = random(particles) * data[i + 3];
    }
    const x = data[i];
    const y = data[i + 1];
    sampleField(field, x, y, width, height, VELOCITY);
    const speed = Math.sqrt(VELOCITY[0] * VELOCITY[0] + VELOCITY[1] * VELOCITY[1]);

    if (!(speed >= minSpeed)) {
      // Nothing measured here: draw nothing, and try somewhere else soon.
      if (random(particles) < reseed) place(particles, i, width, height, lifeMin, lifeMax);
      continue;
    }

    const nx = x + VELOCITY[0] * dt * gain;
    const ny = y + VELOCITY[1] * dt * gain;
    const age = data[i + 2];
    const life = data[i + 3];
    const fadeTime = life * PARTICLE_FADE_SHARE;
    const fade = Math.min(1, Math.min(age + dt, life - age) / fadeTime);
    const s = written * SEGMENT_STRIDE;
    segments[s] = x;
    segments[s + 1] = y;
    segments[s + 2] = nx;
    segments[s + 3] = ny;
    segments[s + 4] = (PARTICLE_FLOOR + (1 - PARTICLE_FLOOR) * Math.min(1, speed / fullSpeed)) * Math.max(0, fade);
    segments[s + 5] = (Math.atan2(VELOCITY[1], VELOCITY[0]) / (2 * Math.PI) + 1) % 1;
    written++;

    data[i] = nx;
    data[i + 1] = ny;
    data[i + 2] = age + dt;
    if (age + dt >= life || nx < 0 || ny < 0 || nx >= width || ny >= height) place(particles, i, width, height, lifeMin, lifeMax);
  }
  return written;
}

/** Put a particle at a random spot with a new life. */
function place(particles, i, width, height, lifeMin, lifeMax) {
  const { data } = particles;
  data[i] = random(particles) * width;
  data[i + 1] = random(particles) * height;
  data[i + 2] = 0;
  data[i + 3] = lifeMin + random(particles) * (lifeMax - lifeMin);
}

/**
 * How much of a trace's brightness is left after `dt` seconds, for a trace
 * meant to stay visible for about `seconds`: the trail picture is multiplied
 * by this each step. (Brightness falls to about 5% after `seconds`.)
 *
 * @param {number} dt - Seconds
 * @param {number} seconds - Trace length in time
 * @returns {number} 0..1
 */
export function traceFade(dt, seconds) {
  if (!(seconds > 0)) return 0;
  return Math.exp((-3 * Math.max(0, dt)) / seconds);
}

/**
 * How many particles a picture gets: a density per area, so a larger picture
 * is as busy as a small one.
 *
 * @param {number} width
 * @param {number} height
 * @param {number} per1000 - Particles per 1,000 pixels (a patch about 32 pixels square)
 * @param {number} [max]
 * @returns {number}
 */
export function particleCount(width, height, per1000, max = 20000) {
  return Math.max(1, Math.min(max, Math.round((width * height * per1000) / 1000)));
}
