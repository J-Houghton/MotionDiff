import { describe, it, expect } from 'vitest';
import {
  PARTICLE_LIFE, PARTICLE_STRIDE, SEGMENT_STRIDE,
  createParticles, sampleField, stepParticles, traceFade, particleCount,
} from '../particles.js';

const W = 200;
const H = 100;

/** A field of cols×rows cells from a function of the cell (cx, cy) → [vx, vy]. */
function field(cols, rows, fn) {
  const values = new Float32Array(cols * rows * 4);
  for (let y = 0; y < rows; y++) for (let x = 0; x < cols; x++) values.set(fn(x, y), (y * cols + x) * 4);
  return { width: cols, height: rows, values, stride: 4 };
}

const options = { width: W, height: H, minSpeed: 2, fullSpeed: 100 };

/** Segments as arrays of [x0, y0, x1, y1, strength, heading]. */
function segmentsOf(particles, n) {
  return Array.from({ length: n }, (_, k) => Array.from(particles.segments.slice(k * SEGMENT_STRIDE, (k + 1) * SEGMENT_STRIDE)));
}

describe('sampleField', () => {
  it('reads a cell at its centre and blends between centres', () => {
    const f = field(2, 1, (x) => [x * 10, 5]);
    // Cell centres are at a quarter and three quarters of the width.
    expect(sampleField(f, 50, 50, W, H, [0, 0])[0]).toBeCloseTo(0, 5);
    expect(sampleField(f, 150, 50, W, H, [0, 0])[0]).toBeCloseTo(10, 5);
    expect(sampleField(f, 100, 50, W, H, [0, 0])).toEqual([5, 5]);
    // Beyond the outer centres the edge value repeats.
    expect(sampleField(f, 199, 99, W, H, [0, 0])[0]).toBeCloseTo(10, 5);
  });
});

describe('stepParticles', () => {
  it('moves each particle by velocity × time, and the segment is that step', () => {
    const particles = createParticles(50, 7);
    const n = stepParticles(particles, field(4, 2, () => [30, -10]), 0.1, options);
    expect(n).toBe(50);
    for (const [x0, y0, x1, y1, , heading] of segmentsOf(particles, n)) {
      expect(x1 - x0).toBeCloseTo(3, 4);
      expect(y1 - y0).toBeCloseTo(-1, 4);
      expect(heading).toBeCloseTo((Math.atan2(-10, 30) / (2 * Math.PI) + 1) % 1, 5);
    }
  });

  it('travels the same distance in the same media time, whatever the step', () => {
    const f = field(4, 2, () => [20, 0]);
    const distance = (dt, steps) => {
      const particles = createParticles(1, 3);
      stepParticles(particles, f, 0, options); // place it
      particles.data.set([10, 50, 0, 99]);
      for (let k = 0; k < steps; k++) stepParticles(particles, f, dt, options);
      return particles.data[0] - 10;
    };
    expect(distance(1 / 30, 30)).toBeCloseTo(distance(1 / 60, 60), 3);
    expect(distance(1 / 30, 30)).toBeCloseTo(20, 3);
  });

  it('gain lengthens the steps without turning them', () => {
    const particles = createParticles(10, 5);
    const n = stepParticles(particles, field(2, 2, () => [0, 40]), 0.05, { ...options, gain: 4 });
    for (const [x0, y0, x1, y1] of segmentsOf(particles, n)) {
      expect(x1 - x0).toBeCloseTo(0, 5);
      expect(y1 - y0).toBeCloseTo(8, 4);
    }
  });

  it('draws nothing where the field is still', () => {
    const particles = createParticles(200, 9);
    expect(stepParticles(particles, field(4, 2, () => [0.5, 0.5]), 1 / 30, options)).toBe(0);
  });

  it('gathers where something moves: still particles are re-seeded until they land there', () => {
    // Only the right-hand fifth of the picture moves.
    const f = field(10, 2, (x) => (x >= 8 ? [0, 25] : [0, 0]));
    const particles = createParticles(1000, 11);
    let n = 0;
    for (let k = 0; k < 60; k++) n = stepParticles(particles, f, 1 / 30, options);
    // A fifth of the area, far more than a fifth of the particles.
    expect(n).toBeGreaterThan(450);
    for (const [x0] of segmentsOf(particles, n)) expect(x0).toBeGreaterThan(150);
  });

  it('strength follows speed and fades in at the start of a life', () => {
    const particles = createParticles(1, 2);
    const f = field(2, 2, () => [50, 0]);
    stepParticles(particles, f, 0, options);
    particles.data.set([20, 50, 0, 2]); // newborn, two seconds to live
    stepParticles(particles, f, 0.03, options);
    const young = particles.segments[4];
    particles.data.set([20, 50, 1, 2]); // mid-life
    stepParticles(particles, f, 0.03, options);
    const grown = particles.segments[4];
    expect(grown).toBeCloseTo(0.45 + 0.55 * 0.5, 5); // 50 of 100 px/s, above the floor of 0.45
    expect(young).toBeGreaterThan(0);
    expect(young).toBeLessThan(grown);
  });

  it('a particle is re-seeded at the end of its life and when it leaves the picture', () => {
    const f = field(2, 2, () => [400, 0]);
    const particles = createParticles(1, 4);
    stepParticles(particles, f, 0, options);
    particles.data.set([190, 50, 0, 99]);
    stepParticles(particles, f, 0.1, options); // 40 px to the right: out
    expect(particles.data[2]).toBe(0);
    expect(particles.data[3]).toBeGreaterThanOrEqual(PARTICLE_LIFE[0]);
    expect(particles.data[3]).toBeLessThanOrEqual(PARTICLE_LIFE[1]);

    particles.data.set([10, 50, 1.99, 2]);
    stepParticles(particles, f, 0.02, options); // past its life
    expect(particles.data[2]).toBe(0);
  });

  it('is repeatable from a seed', () => {
    const f = field(6, 3, (x, y) => [x * 9 - 20, y * 7]);
    const run = () => {
      const particles = createParticles(100, 42);
      for (let k = 0; k < 20; k++) stepParticles(particles, f, 1 / 30, options);
      return Array.from(particles.data);
    };
    expect(run()).toEqual(run());
    expect(createParticles(3).data.length).toBe(3 * PARTICLE_STRIDE);
  });
});

describe('traceFade, particleCount', () => {
  it('leaves about 5% after the trace length, at any step', () => {
    expect(traceFade(0.5, 0.5)).toBeCloseTo(Math.exp(-3), 6);
    expect(traceFade(1 / 30, 0.5) ** 15).toBeCloseTo(traceFade(1 / 60, 0.5) ** 30, 6);
    expect(traceFade(0, 0.5)).toBe(1);
    expect(traceFade(0.1, 0)).toBe(0);
  });

  it('scales the count with the picture area, up to a limit', () => {
    expect(particleCount(640, 360, 25)).toBe(5760);
    expect(particleCount(1920, 1080, 25)).toBe(20000);
  });
});
