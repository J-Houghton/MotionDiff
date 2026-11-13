import { describe, it, test, expect } from 'vitest';
import { posyBlend, rawDiff } from '../diff.js';
import { boxBlur } from '../blur.js';
import { FrameRing, ringCapacity } from '../buffer.js';
import { analyzeSample } from '../analyze.js';
import { buildSourceProfile, isStreamSource } from '../../app/source-profile.js';
import { PARAMETER_PRESETS, PRESET_VERSION, migratePresetParams } from '../../app/clips.js';

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

// ─────────────────────────────────────
//  diff.js — posyBlend
// ─────────────────────────────────────

describe('posyBlend', () => {
  it('static pixel (no motion) produces exactly 128', () => {
    const cur = makePixels([100, 100, 100, 255]);
    const old = makePixels([100, 100, 100, 255]);
    const out = new Uint8ClampedArray(4);

    posyBlend(cur, old, out, 0);

    expect(out[0]).toBe(128);
    expect(out[1]).toBe(128);
    expect(out[2]).toBe(128);
    expect(out[3]).toBe(255);
  });

  it('static pixel converges to 128 regardless of threshold', () => {
    const cur = makePixels([200, 50, 128, 255]);
    const old = makePixels([200, 50, 128, 255]);
    const out = new Uint8ClampedArray(4);

    posyBlend(cur, old, out, 50);

    expect(out[0]).toBe(128);
    expect(out[1]).toBe(128);
    expect(out[2]).toBe(128);
  });

  it('full inversion produces maximum motion', () => {
    const cur = makePixels([255, 0, 0, 255]);
    const old = makePixels([0, 255, 255, 255]);
    const out = new Uint8ClampedArray(4);

    posyBlend(cur, old, out, 0);

    // bR = (255 + 255 + 1) >> 1 = 255 (clamped), bG = (0+0+1)>>1 = 0, bB = 0
    expect(out[0]).toBe(255);
    expect(out[1]).toBe(0);
    expect(out[2]).toBe(0);
    expect(out[3]).toBe(255);
  });

  it('below threshold suppresses to gray (128)', () => {
    // cur=[140,128,128], old=[128,128,128]
    // bR = (140+127+1)>>1 = 134, bG = 128, bB = 128
    // devR=6, devG=0, devB=0: mean deviation 2 = mean difference 4
    const cur = makePixels([140, 128, 128, 255]);
    const old = makePixels([128, 128, 128, 255]);
    const out = new Uint8ClampedArray(4);

    posyBlend(cur, old, out, 10);

    expect(out[0]).toBe(128);
    expect(out[1]).toBe(128);
    expect(out[2]).toBe(128);
    expect(out[3]).toBe(255);
  });

  it('above threshold preserves blended values', () => {
    const cur = makePixels([140, 128, 128, 255]);
    const old = makePixels([128, 128, 128, 255]);
    const out = new Uint8ClampedArray(4);

    posyBlend(cur, old, out, 0);

    // bR = (140+127+1)>>1 = 134
    expect(out[0]).toBe(134);
    expect(out[1]).toBe(128);
    expect(out[2]).toBe(128);
    expect(out[3]).toBe(255);
  });
});

// ─────────────────────────────────────
//  diff.js — rawDiff
// ─────────────────────────────────────

describe('rawDiff', () => {
  it('no motion produces zero', () => {
    const cur = makePixels([100, 150, 200, 255]);
    const old = makePixels([100, 150, 200, 255]);
    const out = new Uint8ClampedArray(4);

    rawDiff(cur, old, out, 0);

    expect(out[0]).toBe(0);
    expect(out[1]).toBe(0);
    expect(out[2]).toBe(0);
    expect(out[3]).toBe(255);
  });

  it('full difference produces 255', () => {
    const cur = makePixels([255, 255, 255, 255]);
    const old = makePixels([0, 0, 0, 255]);
    const out = new Uint8ClampedArray(4);

    rawDiff(cur, old, out, 0);

    expect(out[0]).toBe(255);
    expect(out[1]).toBe(255);
    expect(out[2]).toBe(255);
    expect(out[3]).toBe(255);
  });

  it('below threshold suppresses to zero', () => {
    // cur=[110,150,200], old=[100,150,200] → dR=10, dG=0, dB=0, mag=3.33
    const cur = makePixels([110, 150, 200, 255]);
    const old = makePixels([100, 150, 200, 255]);
    const out = new Uint8ClampedArray(4);

    rawDiff(cur, old, out, 10);

    expect(out[0]).toBe(0);
    expect(out[1]).toBe(0);
    expect(out[2]).toBe(0);
    expect(out[3]).toBe(255);
  });

  it('does not mutate input arrays', () => {
    const cur = makePixels([200, 100, 50, 255]);
    const old = makePixels([100, 100, 100, 255]);
    const out = new Uint8ClampedArray(4);

    const curCopy = new Uint8ClampedArray(cur);
    const oldCopy = new Uint8ClampedArray(old);

    rawDiff(cur, old, out, 0);

    expect(cur).toEqual(curCopy);
    expect(old).toEqual(oldCopy);
  });
});

// ─────────────────────────────────────
//  diff.js — one threshold unit for both modes
// ─────────────────────────────────────

describe('threshold means the same in Posy and Raw', () => {
  // A uniform difference of 20 on every channel.
  const cur = makePixels([140, 140, 140, 255]);
  const old = makePixels([120, 120, 120, 255]);

  const kept = (fn, threshold, baseline) => {
    const out = new Uint8ClampedArray(4);
    fn(cur, old, out, threshold);
    return out[0] !== baseline;
  };

  it('a threshold at the mean channel difference keeps the pixel in both', () => {
    expect(kept(rawDiff, 20, 0)).toBe(true);
    expect(kept(posyBlend, 20, 128)).toBe(true);
  });

  it('one above it suppresses the pixel in both', () => {
    expect(kept(rawDiff, 21, 0)).toBe(false);
    expect(kept(posyBlend, 21, 128)).toBe(false);
  });

  it('agrees pixel for pixel on which pixels survive (even differences)', () => {
    // Even per-channel differences, so Posy's halving loses nothing.
    const n = 64;
    const a = new Uint8ClampedArray(n * 4);
    const b = new Uint8ClampedArray(n * 4);
    for (let i = 0; i < n; i++) {
      for (let c = 0; c < 3; c++) {
        b[i * 4 + c] = 100;
        a[i * 4 + c] = 100 + 2 * ((i * (c + 3)) % 23);
      }
      a[i * 4 + 3] = b[i * 4 + 3] = 255;
    }

    for (const threshold of [0, 6, 13, 20, 31]) {
      const raw = new Uint8ClampedArray(n * 4);
      const posy = new Uint8ClampedArray(n * 4);
      rawDiff(a, b, raw, threshold);
      posyBlend(a, b, posy, threshold);

      for (let i = 0; i < n; i++) {
        const rawKept = raw[i * 4] + raw[i * 4 + 1] + raw[i * 4 + 2] > 0;
        const posyKept = posy[i * 4] !== 128 || posy[i * 4 + 1] !== 128 || posy[i * 4 + 2] !== 128;
        expect(posyKept).toBe(rawKept);
      }
    }
  });
});

// ─────────────────────────────────────
//  clips.js — preset migration
// ─────────────────────────────────────

describe('migratePresetParams', () => {
  it('doubles the threshold of an unversioned Posy preset', () => {
    const old = { algorithm: 'posy', threshold: 8, frameOffset: 2 };
    expect(migratePresetParams(old, undefined)).toEqual({ algorithm: 'posy', threshold: 16, frameOffset: 2 });
    expect(migratePresetParams(old, 1)).toEqual({ algorithm: 'posy', threshold: 16, frameOffset: 2 });
  });

  it('leaves Raw and Magnify presets alone', () => {
    const raw = { algorithm: 'raw', threshold: 5 };
    const magnify = { algorithm: 'magnify', threshold: 10 };
    expect(migratePresetParams(raw, 1)).toBe(raw);
    expect(migratePresetParams(magnify, 1)).toBe(magnify);
  });

  it('never migrates a current-version preset twice', () => {
    const current = { algorithm: 'posy', threshold: 16 };
    expect(migratePresetParams(current, PRESET_VERSION)).toBe(current);
  });

  it('caps the migrated threshold at the control maximum', () => {
    expect(migratePresetParams({ algorithm: 'posy', threshold: 60 }, 1).threshold).toBe(120);
    expect(migratePresetParams({ algorithm: 'posy', threshold: 90 }, 1).threshold).toBe(120);
  });

  it('does not mutate its input', () => {
    const old = { algorithm: 'posy', threshold: 8 };
    migratePresetParams(old, 1);
    expect(old.threshold).toBe(8);
  });

  it('built-in presets are stored in current units', () => {
    const subtle = PARAMETER_PRESETS.find((preset) => preset.name === 'Subtle Wind');
    const contrast = PARAMETER_PRESETS.find((preset) => preset.name === 'High Contrast');
    expect(subtle.params.threshold).toBe(16); // was 8 in half-difference units
    expect(contrast.params.threshold).toBe(5); // Raw: unchanged
  });
});

// ─────────────────────────────────────
//  blur.js — boxBlur
// ─────────────────────────────────────

describe('boxBlur', () => {
  it('center pixel averages its 3x3 neighborhood', () => {
    // 3x3 image, all black except center = [90,90,90,255]
    const data = new Uint8ClampedArray(3 * 3 * 4);
    for (let i = 0; i < data.length; i += 4) data[i + 3] = 255;
    const center = (1 * 3 + 1) * 4;
    data[center]     = 90;
    data[center + 1] = 90;
    data[center + 2] = 90;

    boxBlur(data, 3, 3);

    // center has 9 neighbors: (90/9 + 0.5)|0 = 10
    expect(data[center]).toBe(10);
    expect(data[center + 1]).toBe(10);
    expect(data[center + 2]).toBe(10);
  });

  it('corner pixel uses only available neighbors (count=4)', () => {
    // 3x3 image, top-left corner = [90,90,90,255], rest black
    const data = new Uint8ClampedArray(3 * 3 * 4);
    for (let i = 0; i < data.length; i += 4) data[i + 3] = 255;
    data[0] = 90;
    data[1] = 90;
    data[2] = 90;

    boxBlur(data, 3, 3);

    // corner (0,0) has 4 neighbors: (90/4 + 0.5)|0 = 23
    expect(data[0]).toBe(23);
    expect(data[1]).toBe(23);
    expect(data[2]).toBe(23);
  });

  it('uniform image is unchanged', () => {
    // 3x3, all pixels = [100,100,100,255]
    const data = new Uint8ClampedArray(3 * 3 * 4);
    for (let i = 0; i < data.length; i += 4) {
      data[i]     = 100;
      data[i + 1] = 100;
      data[i + 2] = 100;
      data[i + 3] = 255;
    }

    boxBlur(data, 3, 3);

    for (let i = 0; i < data.length; i += 4) {
      expect(data[i]).toBe(100);
      expect(data[i + 1]).toBe(100);
      expect(data[i + 2]).toBe(100);
    }
  });

  it('mutates input array in-place', () => {
    const data = new Uint8ClampedArray(3 * 3 * 4);
    for (let i = 0; i < data.length; i += 4) data[i + 3] = 255;
    const center = (1 * 3 + 1) * 4;
    data[center] = 90;

    const ref = data;
    boxBlur(data, 3, 3);

    // Same reference, but value changed
    expect(ref).toBe(data);
    expect(data[center]).not.toBe(90);
  });
});

// ─────────────────────────────────────
//  buffer.js — FrameRing
// ─────────────────────────────────────

describe('FrameRing', () => {
  it('hands out slots in order and wraps at capacity', () => {
    const ring = new FrameRing(3);

    expect(ring.push(0.0)).toBe(0);
    expect(ring.push(0.1)).toBe(1);
    expect(ring.push(0.2)).toBe(2);
    expect(ring.push(0.3)).toBe(0); // evicts the frame stamped 0.0

    expect(ring.size).toBe(3);
    expect(ring.capacity).toBe(3);
    expect(ring.newestTime).toBe(0.3);
    expect(ring.oldestTime).toBe(0.1);
    expect(ring.slotAt(0)).toBe(0);
    expect(ring.slotAt(1)).toBe(2);
    expect(ring.slotAt(2)).toBe(1);
  });

  it('reports missing frames as -1 / NaN', () => {
    const ring = new FrameRing(4);

    expect(ring.slotAt(0)).toBe(-1);
    expect(ring.newestTime).toBeNaN();
    expect(ring.nearest(1)).toBe(-1);

    ring.push(1);
    expect(ring.slotAt(1)).toBe(-1);
    expect(ring.slotAt(-1)).toBe(-1);
    expect(ring.timeAt(1)).toBeNaN();
  });

  it('nearest picks the closest stamp', () => {
    const ring = new FrameRing(8);
    [0, 1, 2, 3, 4].forEach((t) => ring.push(t));

    expect(ring.timeAt(ring.nearest(2.2))).toBe(2);
    expect(ring.timeAt(ring.nearest(2.6))).toBe(3);
    expect(ring.timeAt(ring.nearest(4))).toBe(4);
  });

  it('nearest breaks ties toward the newer frame', () => {
    const ring = new FrameRing(8);
    [0, 1, 2].forEach((t) => ring.push(t));

    expect(ring.timeAt(ring.nearest(1.5))).toBe(2);
  });

  it('nearest clamps a target older than the ring to the oldest frame', () => {
    const ring = new FrameRing(8);
    [10, 11, 12].forEach((t) => ring.push(t));

    expect(ring.timeAt(ring.nearest(3))).toBe(10);
  });

  it('nearest only considers frames stamped strictly before the limit', () => {
    const ring = new FrameRing(8);
    [0, 1, 2, 3].forEach((t) => ring.push(t));

    // The current frame (3) must never be compared with itself.
    expect(ring.timeAt(ring.nearest(3, 3))).toBe(2);
    expect(ring.nearest(0, 0)).toBe(-1);
  });

  it('nearest still works after the ring has wrapped', () => {
    const ring = new FrameRing(4);
    for (let t = 0; t < 10; t++) ring.push(t);

    expect(ring.oldestTime).toBe(6);
    expect(ring.timeAt(ring.nearest(7.4))).toBe(7);
    expect(ring.timeAt(ring.nearest(0))).toBe(6);
  });

  it('dropFrom removes frames at or after the given time', () => {
    const ring = new FrameRing(8);
    [0, 1, 2, 3, 4].forEach((t) => ring.push(t));

    expect(ring.dropFrom(3)).toBe(2);
    expect(ring.size).toBe(3);
    expect(ring.newestTime).toBe(2);

    // The freed slots are reused for the frames that follow.
    ring.push(2.5);
    expect(ring.newestTime).toBe(2.5);
    expect(ring.timeAt(1)).toBe(2);
  });

  it('dropFrom past the oldest frame empties the ring', () => {
    const ring = new FrameRing(4);
    for (let t = 0; t < 6; t++) ring.push(t);

    expect(ring.dropFrom(0)).toBe(4);
    expect(ring.size).toBe(0);
    expect(ring.push(0)).toBe(0);
    expect(ring.newestTime).toBe(0);
  });

  it('clear resets state', () => {
    const ring = new FrameRing(4);
    ring.push(1);
    ring.push(2);
    ring.clear();

    expect(ring.size).toBe(0);
    expect(ring.nearest(1)).toBe(-1);
    expect(ring.push(5)).toBe(0);
  });
});

describe('ringCapacity', () => {
  it('keeps the 120-frame cap at the default processing size', () => {
    expect(ringCapacity(640, 360)).toBe(120);
  });

  it('scales down at 1280px and 1920px', () => {
    const at1280 = ringCapacity(1280, 720);
    const at1920 = ringCapacity(1920, 1080);

    expect(at1280).toBeLessThan(120);
    expect(at1920).toBeLessThan(at1280);
    // Never more than the budget allows.
    expect(at1280 * 1280 * 720 * 4).toBeLessThanOrEqual(192 * 1024 * 1024);
    expect(at1920 * 1920 * 1080 * 4).toBeLessThanOrEqual(192 * 1024 * 1024);
  });

  it('honours an explicit budget and frame cap', () => {
    expect(ringCapacity(100, 100, { budgetBytes: 400000, maxFrames: 50 })).toBe(10);
    expect(ringCapacity(10, 10, { budgetBytes: 1e9, maxFrames: 50 })).toBe(50);
  });

  it('never drops below the minimum, even for huge or invalid sizes', () => {
    expect(ringCapacity(8000, 8000)).toBe(4);
    expect(ringCapacity(0, 0)).toBe(4);
    expect(ringCapacity(NaN, 100)).toBe(4);
  });
});

// ─────────────────────────────────────
//  analyze.js — analyzeSample
// ─────────────────────────────────────

/** Deterministic pseudo-random generator so noise tests are repeatable. */
function makeRandom(seed) {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 4294967296;
  };
}

/**
 * A burst of `count` consecutive W x H frames: a flat background with
 * uniform noise of the given amplitude and, optionally, a bright block that
 * moves `speed` px per frame.
 */
function makeBurst({ width = 64, height = 32, count = 6, noise = 0, speed = 0, block = 8, seed = 1 }) {
  const random = makeRandom(seed);
  const frames = [];
  for (let n = 0; n < count; n++) {
    const data = new Uint8ClampedArray(width * height * 4);
    const x0 = 4 + Math.floor(n * speed);
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const i = (y * width + x) * 4;
        const inBlock = speed > 0 && x >= x0 && x < x0 + block && y >= 8 && y < 8 + block;
        const base = inBlock ? 220 : 90;
        for (let c = 0; c < 3; c++) {
          data[i + c] = base + Math.round((random() - 0.5) * 2 * noise);
        }
        data[i + 3] = 255;
      }
    }
    frames.push(data);
  }
  return frames;
}

describe('analyzeSample', () => {
  it('returns the defaults when there is nothing to analyse', () => {
    expect(analyzeSample([], 30)).toMatchObject({ frameOffset: 5, threshold: 20 });
    expect(analyzeSample(null, 30)).toMatchObject({ frameOffset: 5, threshold: 20 });
    expect(analyzeSample([[makePixels([1, 2, 3, 255])]], 30)).toMatchObject({ frameOffset: 5, threshold: 20 });
  });

  it('a clean static scene gets the minimum threshold and a long gap', () => {
    const result = analyzeSample([makeBurst({}), makeBurst({ seed: 2 })], 30);

    expect(result.noiseFloor).toBe(0);
    expect(result.threshold).toBe(3);
    expect(result.frameOffset).toBe(15);
  });

  it('the noise floor follows the noise level, and the threshold sits above it', () => {
    const quiet = analyzeSample([makeBurst({ noise: 2 })], 30);
    const noisy = analyzeSample([makeBurst({ noise: 12 })], 30);

    expect(noisy.noiseFloor).toBeGreaterThan(quiet.noiseFloor * 3);
    expect(quiet.threshold).toBeGreaterThan(quiet.noiseFloor);
    expect(noisy.threshold).toBeGreaterThan(noisy.noiseFloor * 2);
    expect(noisy.threshold).toBeGreaterThan(quiet.threshold);
  });

  it('noise alone does not read as motion', () => {
    const result = analyzeSample([makeBurst({ noise: 10 }), makeBurst({ noise: 10, seed: 7 })], 30);

    expect(result.activeFraction).toBeLessThan(0.01);
    expect(result.frameOffset).toBeGreaterThanOrEqual(15);
  });

  it('the noise floor is the median, so a moving object does not raise it', () => {
    const still = analyzeSample([makeBurst({ noise: 3 })], 30);
    const moving = analyzeSample([makeBurst({ noise: 3, speed: 4 })], 30);

    expect(moving.noiseFloor).toBeCloseTo(still.noiseFloor, 0);
    expect(moving.threshold).toBe(still.threshold);
  });

  it('fast motion gets the shortest gap', () => {
    // 8 px/frame: 2 x 64 changed pixels out of 2048 at a gap of one frame.
    const result = analyzeSample([makeBurst({ noise: 2, speed: 8 })], 30);
    expect(result.frameOffset).toBe(1);
  });

  it('slow motion gets a longer gap than fast motion', () => {
    // 0.5 px/frame on a 64x32 frame: one column of 8 pixels every 2 frames.
    const slow = analyzeSample([makeBurst({ noise: 2, speed: 0.5 })], 30);
    const fast = analyzeSample([makeBurst({ noise: 2, speed: 8 })], 30);

    expect(slow.frameOffset).toBeGreaterThan(fast.frameOffset);
  });

  it('uses fps to convert the gap to 1/30 s units', () => {
    const burst = makeBurst({ noise: 2, speed: 0.5, count: 8 });
    const at30 = analyzeSample([burst], 30);
    const at60 = analyzeSample([burst], 60);
    const at15 = analyzeSample([burst], 15);

    // The same frames sampled twice as fast cover half the time.
    expect(at60.frameOffset).toBe(Math.max(1, Math.round(at30.frameOffset / 2)));
    expect(at15.frameOffset).toBe(at30.frameOffset * 2);
    expect(at30.gapSeconds).toBeCloseTo(at30.frameOffset / 30, 9);
  });

  it('ignores duplicated frames when measuring the noise floor', () => {
    const burst = makeBurst({ noise: 6 });
    // Every frame twice: half the neighbouring pairs are identical.
    const doubled = burst.flatMap((frame) => [frame, frame]);

    const clean = analyzeSample([burst], 30);
    const withDuplicates = analyzeSample([doubled], 30);

    expect(withDuplicates.noiseFloor).toBeCloseTo(clean.noiseFloor, 5);
  });

  it('accepts a flat array of frames as one burst', () => {
    const burst = makeBurst({ noise: 2, speed: 8 });
    expect(analyzeSample(burst, 30)).toEqual(analyzeSample([burst], 30));
  });

  it('clamps the threshold and the gap to the control ranges', () => {
    const wild = analyzeSample([makeBurst({ noise: 120 })], 30);
    expect(wild.threshold).toBeLessThanOrEqual(60);
    expect(wild.frameOffset).toBeGreaterThanOrEqual(1);
    expect(wild.frameOffset).toBeLessThanOrEqual(90);
  });
});

describe('buildSourceProfile', () => {
  test('screen → isStream true, frameCapture draw-image', () => {
    const p = buildSourceProfile('screen', true);
    expect(p.isStream).toBe(true);
    expect(p.frameCapture).toBe('draw-image');
  });

  test('camera → isStream true, frameCapture draw-image', () => {
    const p = buildSourceProfile('camera', true);
    expect(p.isStream).toBe(true);
    expect(p.frameCapture).toBe('draw-image');
  });

  test('file with rVFC → frameCapture video-frame', () => {
    const p = buildSourceProfile('file', true);
    expect(p.isStream).toBe(false);
    expect(p.frameCapture).toBe('video-frame');
  });

  test('file without rVFC → frameCapture draw-image', () => {
    const p = buildSourceProfile('file', false);
    expect(p.frameCapture).toBe('draw-image');
  });

  test('hls with rVFC → frameCapture video-frame', () => {
    expect(buildSourceProfile('hls', true).frameCapture).toBe('video-frame');
  });

  test('url without rVFC → frameCapture draw-image', () => {
    expect(buildSourceProfile('url', false).frameCapture).toBe('draw-image');
  });
});

describe('isStreamSource', () => {
  test('screen and camera are stream sources', () => {
    expect(isStreamSource('screen')).toBe(true);
    expect(isStreamSource('camera')).toBe(true);
  });

  test('file, url, hls are not stream sources', () => {
    expect(isStreamSource('file')).toBe(false);
    expect(isStreamSource('url')).toBe(false);
    expect(isStreamSource('hls')).toBe(false);
  });
});
