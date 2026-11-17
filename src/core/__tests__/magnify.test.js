import { describe, it, expect } from 'vitest';
import {
  emaAlpha,
  emaUpdate,
  magnifySample,
  magnifyPixel,
  seedStates,
  magnifyFrame,
  velocityBandStep, displacementStep, warpByField,
} from '../magnify.js';

/**
 * Build a Uint8ClampedArray from RGBA quads.
 * Usage: makePixels([R,G,B,A], [R,G,B,A], ...)
 */
function makePixels(...channels) {
  const arr = new Uint8ClampedArray(channels.length * 4);
  for (let i = 0; i < channels.length; i++) {
    arr[i * 4]     = channels[i][0];
    arr[i * 4 + 1] = channels[i][1];
    arr[i * 4 + 2] = channels[i][2];
    arr[i * 4 + 3] = channels[i][3];
  }
  return arr;
}

// The mode's defaults, for the band-pass simulation
const DT_MS = 1000 / 30;
const FREQ_LOW = 0.7;
const FREQ_HIGH = 2.0;

/**
 * Feed x(t) = 0.5 + inputAmp·sin(2π·f·t) through both EMAs for `steps`
 * frames at dt = DT_MS and return the steady-state band amplitude
 * measured as (max − min) / 2 over the last `measure` steps.
 */
function bandAmplitude(freqHz, steps = 900, measure = 300, inputAmp = 0.1) {
  const alphaFast = emaAlpha(FREQ_HIGH, DT_MS);
  const alphaSlow = emaAlpha(FREQ_LOW, DT_MS);
  let fast = 0.5;
  let slow = 0.5;
  let min = Infinity;
  let max = -Infinity;
  for (let n = 0; n < steps; n++) {
    const t = (n * DT_MS) / 1000;
    const x = 0.5 + inputAmp * Math.sin(2 * Math.PI * freqHz * t);
    fast = emaUpdate(fast, x, alphaFast);
    slow = emaUpdate(slow, x, alphaSlow);
    const band = fast - slow;
    if (n >= steps - measure) {
      if (band < min) min = band;
      if (band > max) max = band;
    }
  }
  return (max - min) / 2;
}

// ─────────────────────────────────────
//  magnify.js — emaAlpha
// ─────────────────────────────────────

describe('emaAlpha', () => {
  it('is monotonic in frequency', () => {
    const freqs = [0.05, 0.1, 0.5, 0.7, 1, 2, 5, 10, 50];
    for (let i = 1; i < freqs.length; i++) {
      expect(emaAlpha(freqs[i], DT_MS)).toBeGreaterThan(emaAlpha(freqs[i - 1], DT_MS));
    }
  });

  it('is monotonic in dt', () => {
    const dts = [1, 5, 16.7, 33.3, 66.7, 200, 1000];
    for (let i = 1; i < dts.length; i++) {
      expect(emaAlpha(1, dts[i])).toBeGreaterThan(emaAlpha(1, dts[i - 1]));
    }
  });

  it('emaAlpha(f, 0) is approximately 0 but stays positive', () => {
    const a = emaAlpha(2, 0);
    expect(a).toBeGreaterThan(0);
    expect(a).toBeLessThan(1e-5);
  });

  it('is clamped to at most 1', () => {
    expect(emaAlpha(1000, 1000)).toBeLessThanOrEqual(1);
    expect(emaAlpha(Infinity, DT_MS)).toBeLessThanOrEqual(1);
  });

  it('stays within (0, 1] for adversarial inputs', () => {
    for (const [f, dt] of [[0, 0], [0, 100], [5, -10], [-1, 33], [NaN, 33], [5, NaN]]) {
      const a = emaAlpha(f, dt);
      expect(a).toBeGreaterThan(0);
      expect(a).toBeLessThanOrEqual(1);
    }
  });

  it('matches the closed form for a typical frame interval', () => {
    const expected = 1 - Math.exp((-2 * Math.PI * 2 * DT_MS) / 1000);
    expect(emaAlpha(2, DT_MS)).toBeCloseTo(expected, 12);
  });
});

// ─────────────────────────────────────
//  magnify.js — emaUpdate
// ─────────────────────────────────────

describe('emaUpdate', () => {
  it('alpha = 1 jumps to the current sample', () => {
    expect(emaUpdate(0.2, 0.9, 1)).toBeCloseTo(0.9, 12);
  });

  it('moves the state toward the current sample by alpha', () => {
    expect(emaUpdate(0, 1, 0.25)).toBeCloseTo(0.25, 12);
    expect(emaUpdate(1, 0, 0.25)).toBeCloseTo(0.75, 12);
  });

  it('static input leaves the state unchanged', () => {
    expect(emaUpdate(0.42, 0.42, 0.3)).toBeCloseTo(0.42, 12);
  });
});

// ─────────────────────────────────────
//  Band-pass response — scalar simulation with defaults
// ─────────────────────────────────────

describe('band-pass response (defaults 0.7 Hz / 2.0 Hz, dt = 1000/30 ms)', () => {
  it('passes 1.2 Hz with amplitude ≥ 0.35 × input (expect ≈ 0.48)', () => {
    const ratio = bandAmplitude(1.2) / 0.1;
    expect(ratio).toBeGreaterThanOrEqual(0.35);
    expect(ratio).toBeCloseTo(0.48, 1);
  });

  it('attenuates 8 Hz to ≤ 0.20 × input (expect ≈ 0.175)', () => {
    const ratio = bandAmplitude(8) / 0.1;
    expect(ratio).toBeLessThanOrEqual(0.20);
    expect(ratio).toBeCloseTo(0.175, 1);
  });

  it('constant input settles to |band| < 1e-4', () => {
    const alphaFast = emaAlpha(FREQ_HIGH, DT_MS);
    const alphaSlow = emaAlpha(FREQ_LOW, DT_MS);
    // Start the states away from the input so the band has to decay.
    let fast = 0;
    let slow = 0;
    for (let n = 0; n < 900; n++) {
      fast = emaUpdate(fast, 0.5, alphaFast);
      slow = emaUpdate(slow, 0.5, alphaSlow);
    }
    expect(Math.abs(fast - slow)).toBeLessThan(1e-4);
  });
});

// ─────────────────────────────────────
//  magnify.js — magnifySample
// ─────────────────────────────────────

describe('magnifySample', () => {
  it('static signal (cur = fast = slow) returns cur', () => {
    expect(magnifySample(0.4, 0.4, 0.4, 15)).toBeCloseTo(0.4, 12);
  });

  it('amplifies the band by amp', () => {
    // band = 0.02, amp = 10 → 0.5 + 0.2
    expect(magnifySample(0.5, 0.51, 0.49, 10)).toBeCloseTo(0.7, 12);
  });

  it('chroma scales the amplification', () => {
    expect(magnifySample(0.5, 0.51, 0.49, 10, 0.5)).toBeCloseTo(0.6, 12);
  });

  it('clamps output to [0, 1]', () => {
    expect(magnifySample(0.9, 1, 0, 60)).toBe(1);
    expect(magnifySample(0.1, 0, 1, 60)).toBe(0);
  });
});

// ─────────────────────────────────────
//  magnify.js — magnifyPixel
// ─────────────────────────────────────

describe('magnifyPixel', () => {
  it('static input (cur = fast = slow) returns cur exactly', () => {
    const px = [0.25, 0.5, 0.75];
    const out = magnifyPixel(px, px, px, 60, 1);
    expect(out[0]).toBe(0.25);
    expect(out[1]).toBe(0.5);
    expect(out[2]).toBe(0.75);
  });

  it('output is clamped to [0, 1] for adversarial inputs', () => {
    const cases = [
      [[1, 1, 1], [1, 1, 1], [0, 0, 0]],
      [[0, 0, 0], [0, 0, 0], [1, 1, 1]],
      [[0.5, 0.5, 0.5], [1, 0, 1], [0, 1, 0]],
      [[1, 0, 0.5], [0, 1, 1], [1, 0, 0]],
    ];
    for (const [cur, fast, slow] of cases) {
      const out = magnifyPixel(cur, fast, slow, 60, 1);
      for (const v of out) {
        expect(v).toBeGreaterThanOrEqual(0);
        expect(v).toBeLessThanOrEqual(1);
        expect(Number.isFinite(v)).toBe(true);
      }
    }
  });

  it('chroma = 0 on a pure color oscillation with constant luma returns near-unamplified output', () => {
    // Band with exactly zero Rec.709 luma: ΔR·0.2126 + ΔG·0.7152 = 0
    const slow = [0.5, 0.5, 0.5];
    const fast = [0.5 + 0.07152, 0.5 - 0.02126, 0.5];
    const cur = [0.5, 0.5, 0.5];
    const out = magnifyPixel(cur, fast, slow, 60, 0);
    expect(out[0]).toBeCloseTo(0.5, 6);
    expect(out[1]).toBeCloseTo(0.5, 6);
    expect(out[2]).toBeCloseTo(0.5, 6);
  });

  it('chroma = 1 amplifies each channel by the full band', () => {
    // Uniform band on all channels: bandLuma equals the band, so
    // out = cur + amp·band per channel.
    const out = magnifyPixel([0.5, 0.5, 0.5], [0.52, 0.52, 0.52], [0.5, 0.5, 0.5], 10, 1);
    expect(out[0]).toBeCloseTo(0.7, 10);
    expect(out[1]).toBeCloseTo(0.7, 10);
    expect(out[2]).toBeCloseTo(0.7, 10);
  });
});

// ─────────────────────────────────────
//  Numerical stability
// ─────────────────────────────────────

describe('numerical stability', () => {
  it('10 000 emaUpdate iterations with random inputs stay finite and within [0, 1]', () => {
    // Deterministic LCG so failures are reproducible.
    let seed = 123456789;
    const rand = () => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed / 2147483648;
    };

    for (const alpha of [1e-6, 0.01, 0.136, 0.342, 0.999, 1]) {
      let state = rand();
      for (let n = 0; n < 10000; n++) {
        state = emaUpdate(state, rand(), alpha);
        expect(Number.isFinite(state)).toBe(true);
        expect(state).toBeGreaterThanOrEqual(0);
        expect(state).toBeLessThanOrEqual(1);
      }
    }
  });
});

// ─────────────────────────────────────
//  seedStates + magnifyFrame
// ─────────────────────────────────────

describe('seedStates', () => {
  it('first magnified frame after seeding equals the input frame exactly', () => {
    const frame = makePixels(
      [0, 0, 0, 255],
      [255, 255, 255, 255],
      [17, 128, 240, 255],
      [200, 3, 99, 255],
    );
    const fast = new Float32Array(frame.length);
    const slow = new Float32Array(frame.length);
    seedStates(frame, fast, slow);

    const out = new Uint8ClampedArray(frame.length);
    magnifyFrame(frame, fast, slow, out, 0.342, 0.136, 60, 1);

    expect(out).toEqual(frame);
  });

  it('copies normalized values into both states', () => {
    const frame = makePixels([51, 102, 204, 255]);
    const fast = new Float32Array(4);
    const slow = new Float32Array(4);
    seedStates(frame, fast, slow);

    expect(fast[0]).toBeCloseTo(0.2, 6);
    expect(fast[1]).toBeCloseTo(0.4, 6);
    expect(fast[2]).toBeCloseTo(0.8, 6);
    expect(slow[0]).toBeCloseTo(0.2, 6);
    expect(slow[1]).toBeCloseTo(0.4, 6);
    expect(slow[2]).toBeCloseTo(0.8, 6);
  });
});

describe('magnifyFrame', () => {
  it('amplifies a uniform step change beyond its raw size', () => {
    const gray = makePixels([128, 128, 128, 255]);
    const brighter = makePixels([153, 153, 153, 255]);
    const fast = new Float32Array(4);
    const slow = new Float32Array(4);
    seedStates(gray, fast, slow);

    const alphaFast = emaAlpha(FREQ_HIGH, DT_MS);
    const alphaSlow = emaAlpha(FREQ_LOW, DT_MS);
    const out = new Uint8ClampedArray(4);
    magnifyFrame(brighter, fast, slow, out, alphaFast, alphaSlow, 15, 1);

    // band = (alphaFast − alphaSlow) · step ≈ 0.0202, out ≈ 0.6 + 15·0.0202
    const step = 25 / 255;
    const expected = (153 / 255 + 15 * (alphaFast - alphaSlow) * step) * 255;
    expect(out[0]).toBe(Math.round(expected));
    expect(out[0]).toBeGreaterThan(153 + 25);
    expect(out[3]).toBe(255);
  });

  it('updates both EMA states in place', () => {
    const gray = makePixels([128, 128, 128, 255]);
    const brighter = makePixels([228, 228, 228, 255]);
    const fast = new Float32Array(4);
    const slow = new Float32Array(4);
    seedStates(gray, fast, slow);

    const out = new Uint8ClampedArray(4);
    magnifyFrame(brighter, fast, slow, out, 0.5, 0.1, 15, 1);

    expect(fast[0]).toBeCloseTo(128 / 255 + 0.5 * (100 / 255), 6);
    expect(slow[0]).toBeCloseTo(128 / 255 + 0.1 * (100 / 255), 6);
  });

  it('static video stays unchanged over many frames (no drift, no blow-out)', () => {
    const frame = makePixels([30, 128, 220, 255]);
    const fast = new Float32Array(4);
    const slow = new Float32Array(4);
    seedStates(frame, fast, slow);

    const out = new Uint8ClampedArray(4);
    for (let n = 0; n < 300; n++) {
      magnifyFrame(frame, fast, slow, out, 0.342, 0.136, 60, 1);
      expect(out[0]).toBe(30);
      expect(out[1]).toBe(128);
      expect(out[2]).toBe(220);
    }
  });

  it('adds the band onto baseData when the EMA input is pre-blurred', () => {
    const blurred = makePixels([140, 140, 140, 255]);
    const original = makePixels([128, 128, 128, 255]);
    const fast = new Float32Array(4);
    const slow = new Float32Array(4);
    seedStates(original, fast, slow);

    const out = new Uint8ClampedArray(4);
    magnifyFrame(blurred, fast, slow, out, 0.5, 0.1, 10, 1, original);

    // States follow the blurred signal; the band is added onto original.
    const band = (0.5 - 0.1) * (12 / 255);
    const expected = (128 / 255 + 10 * band) * 255;
    expect(out[0]).toBe(Math.round(expected));
  });
});

describe('velocityBandStep + displacementStep (motion magnification)', () => {
  const alphaF = emaAlpha(2.0, 1000 / 30);
  const alphaS = emaAlpha(0.2, 1000 / 30);
  const dt = 1 / 30;

  const run = (velocityAt, frames) => {
    const fast = new Float32Array(2);
    const slow = new Float32Array(2);
    const disp = new Float32Array(2);
    const band = new Float32Array(2);
    const history = [];
    for (let k = 0; k < frames; k++) {
      velocityBandStep(fast, slow, velocityAt(k), 1, alphaF, alphaS, band);
      displacementStep(disp, band, 1, dt, alphaS);
      history.push(disp[0]);
    }
    return history;
  };

  it('a constant velocity (a pan) decays out of the band', () => {
    const history = run(() => Float32Array.from([30, 0]), 300);
    const early = Math.max(...history.slice(10, 60).map(Math.abs));
    const late = Math.max(...history.slice(-30).map(Math.abs));
    expect(late).toBeLessThan(early * 0.2);
  });

  it('an in-band oscillation passes; one far above the band is attenuated', () => {
    const osc = (freq) => run((k) => Float32Array.from([20 * Math.sin(2 * Math.PI * freq * (k / 30)), 0]), 300);
    const inBand = Math.max(...osc(0.8).slice(-90).map(Math.abs));
    const above = Math.max(...osc(10).slice(-90).map(Math.abs));
    expect(inBand).toBeGreaterThan(above * 3);
  });
});

describe('warpByField', () => {
  it('shifts content against the field and caps the shift', () => {
    const width = 16; const height = 8;
    const src = new Uint8ClampedArray(width * height * 4);
    for (let x = 0; x < width; x++) for (let y = 0; y < height; y++) src[(y * width + x) * 4] = x * 10;
    const field = Float32Array.from([2, 0]); // one cell, 2 px right
    const out = warpByField(src, width, height, field, 1, 1, 1, 8);
    // Sampling at x − 2: interior pixels take the value from two to the left.
    expect(out[(3 * width + 6) * 4]).toBe(src[(3 * width + 4) * 4]);
    // Amp beyond the cap clamps at 8 px.
    const capped = warpByField(src, width, height, field, 1, 1, 100, 8);
    expect(capped[(3 * width + 12) * 4]).toBe(src[(3 * width + 4) * 4]);
  });
});
