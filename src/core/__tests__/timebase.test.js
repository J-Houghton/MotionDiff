import { describe, it, expect } from 'vitest';
import { FrameRing } from '../buffer.js';
import {
  REFERENCE_FPS,
  MAX_CONTINUOUS_GAP,
  MAX_SEEK_STEP,
  MAX_GAP_JITTER,
  framesToSeconds,
  lookbackTime,
  classifyStep,
  frameDeltaMs,
  storeInterval,
  shouldStore,
} from '../timebase.js';

/**
 * Feed `seconds` of frames at `fps` through the same store/select logic the
 * pipeline uses and return, for the last frame, the real gap (in seconds)
 * between it and the frame each channel was compared against.
 */
function simulate({ fps, seconds, frameOffset, channelSpread = 0, capacity = 120, keepEvery = 1 }) {
  const ring = new FrameRing(capacity);
  const interval = storeInterval(frameOffset, channelSpread, capacity);
  let lastStored = NaN;
  let gaps = null;
  const total = Math.round(fps * seconds);

  for (let n = 0; n < total; n++) {
    if (n % keepEvery !== 0) continue; // frames the pipeline never saw
    const time = n / fps;
    gaps = [0, 1, 2].map((channel) => {
      const age = ring.nearest(lookbackTime(time, frameOffset, channelSpread, channel), time);
      return age < 0 ? NaN : time - ring.timeAt(age);
    });
    if (shouldStore(lastStored, time, interval)) {
      ring.push(time);
      lastStored = time;
    }
  }
  return gaps;
}

describe('framesToSeconds / lookbackTime', () => {
  it('one unit is one frame of the 30 fps reference', () => {
    expect(REFERENCE_FPS).toBe(30);
    expect(framesToSeconds(30)).toBe(1);
    expect(framesToSeconds(5)).toBeCloseTo(1 / 6, 12);
  });

  it('spreads the three channels by channelSpread', () => {
    expect(lookbackTime(10, 30, 0, 0)).toBeCloseTo(9, 12);
    expect(lookbackTime(10, 30, 0, 2)).toBeCloseTo(9, 12);
    expect(lookbackTime(10, 6, 3, 0)).toBeCloseTo(10 - 6 / 30, 12);
    expect(lookbackTime(10, 6, 3, 1)).toBeCloseTo(10 - 9 / 30, 12);
    expect(lookbackTime(10, 6, 3, 2)).toBeCloseTo(10 - 12 / 30, 12);
  });
});

describe('classifyStep', () => {
  it('first frame has no predecessor', () => {
    expect(classifyStep(NaN, 3)).toBe('first');
    expect(classifyStep(undefined, 0)).toBe('first');
  });

  it('the same stamp is a repeat', () => {
    expect(classifyStep(2.5, 2.5)).toBe('repeat');
    expect(classifyStep(2.5, 2.50001)).toBe('repeat');
  });

  it('ordinary playback advances at any frame rate', () => {
    expect(classifyStep(1, 1 + 1 / 60)).toBe('advance');
    expect(classifyStep(1, 1 + 1 / 24)).toBe('advance');
    // 2x playback with a 15 fps cap: 133 ms of media time per processed frame
    expect(classifyStep(1, 1 + 2 / 15)).toBe('advance');
  });

  it('a long forward gap during playback is a jump', () => {
    expect(classifyStep(1, 1 + MAX_CONTINUOUS_GAP)).toBe('advance');
    expect(classifyStep(1, 1 + MAX_CONTINUOUS_GAP + 0.01)).toBe('jump');
  });

  it('any backward step is a rewind: loop, seek back, or step back', () => {
    expect(classifyStep(9.97, 0.0)).toBe('rewind');
    expect(classifyStep(5, 2)).toBe('rewind');
    expect(classifyStep(5, 5 - 1 / 30)).toBe('rewind');
  });

  it('after a seek, a frame step still advances', () => {
    expect(classifyStep(4, 4 + 1 / 30, true)).toBe('advance');
    expect(classifyStep(4, 4 + 1 / 10, true)).toBe('advance');
    expect(classifyStep(4, 4 + MAX_SEEK_STEP, true)).toBe('advance');
  });

  it('after a seek, landing further ahead is a jump', () => {
    expect(classifyStep(4, 4 + MAX_SEEK_STEP + 0.01, true)).toBe('jump');
    // The same distance without a seek is just a slow frame.
    expect(classifyStep(4, 4 + MAX_SEEK_STEP + 0.01, false)).toBe('advance');
  });

  it('a seek that lands on the same frame is a repeat', () => {
    expect(classifyStep(1.043, 1.043, true)).toBe('repeat');
  });
});

describe('frameDeltaMs', () => {
  it('is the media-time delta for a continuous frame', () => {
    expect(frameDeltaMs('advance', 1, 1 + 1 / 30)).toBeCloseTo(33.333, 2);
    expect(frameDeltaMs('advance', 1, 1 + 1 / 60)).toBeCloseTo(16.667, 2);
  });

  it('is zero for a repeated frame', () => {
    expect(frameDeltaMs('repeat', 1, 1)).toBe(0);
  });

  it('falls back to the reference interval when there is no usable predecessor', () => {
    expect(frameDeltaMs('first', NaN, 1)).toBeCloseTo(1000 / 30, 6);
    expect(frameDeltaMs('jump', 1, 60)).toBeCloseTo(1000 / 30, 6);
    expect(frameDeltaMs('rewind', 5, 1)).toBeCloseTo(1000 / 30, 6);
  });

  it('never exceeds one second', () => {
    expect(frameDeltaMs('advance', 0, 5)).toBe(1000);
  });
});

describe('storeInterval / shouldStore', () => {
  it('keeps every frame when the ring easily spans the lookback', () => {
    // 5 frames = 167 ms over 118 slots is far below any real frame interval.
    const interval = storeInterval(5, 0, 120);
    expect(interval).toBeLessThan(1 / 240);
    expect(shouldStore(1, 1 + 1 / 60, interval)).toBe(true);
  });

  it('thins history when the ring is too short for the lookback', () => {
    // 90 frames = 3 s into a 24-frame ring: about 136 ms between kept frames.
    const interval = storeInterval(90, 0, 24);
    expect(interval).toBeCloseTo(3 / 22, 6);
    expect(shouldStore(1, 1 + 1 / 30, interval)).toBe(false);
    expect(shouldStore(1, 1 + 5 / 30, interval)).toBe(true);
  });

  it('never thins by more than a fraction of the shortest gap', () => {
    // A 1-frame gap with a long spread: the spread must not cost the main
    // gap its precision.
    const interval = storeInterval(1, 5, 8);
    expect(interval).toBeCloseTo(framesToSeconds(1) * MAX_GAP_JITTER, 9);
    expect(shouldStore(1, 1 + 1 / 60, interval)).toBe(true);
  });

  it('always stores when nothing has been stored yet', () => {
    expect(shouldStore(NaN, 0, 10)).toBe(true);
  });
});

describe('time-based selection keeps the gap constant', () => {
  const GAP = framesToSeconds(6); // 200 ms

  it('same gap at 24, 25, 30 and 60 fps sources', () => {
    for (const fps of [24, 25, 30, 60]) {
      const [gapR] = simulate({ fps, seconds: 3, frameOffset: 6 });
      // Within half a source frame of the requested gap.
      expect(Math.abs(gapR - GAP)).toBeLessThanOrEqual(0.5 / fps + 1e-9);
    }
  });

  it('same gap when only every other / every fourth frame is processed', () => {
    // fps cap, 2x playback and dropped frames all look like this.
    for (const keepEvery of [2, 4]) {
      const [gapR] = simulate({ fps: 60, seconds: 3, frameOffset: 6, keepEvery });
      expect(Math.abs(gapR - GAP)).toBeLessThanOrEqual((0.5 * keepEvery) / 60 + 1e-9);
    }
  });

  it('counting frames instead would have changed the gap fourfold', () => {
    // What the old index-based selection did: 6 processed frames back.
    expect(6 / 60).toBeCloseTo(GAP / 2, 9);
    expect((6 * 2) / 30).toBeCloseTo(GAP * 2, 9);
  });

  it('RGB spread resolves to three distinct, evenly spaced gaps', () => {
    const [r, g, b] = simulate({ fps: 30, seconds: 3, frameOffset: 6, channelSpread: 3 });
    expect(r).toBeCloseTo(6 / 30, 6);
    expect(g).toBeCloseTo(9 / 30, 6);
    expect(b).toBeCloseTo(12 / 30, 6);
  });

  it('a short ring still reaches a long gap by thinning', () => {
    // 3 s lookback through a 24-frame ring (1920x1080) at 30 fps.
    const [gapR] = simulate({ fps: 30, seconds: 8, frameOffset: 90, capacity: 24 });
    const interval = storeInterval(90, 0, 24);
    expect(Math.abs(gapR - 3)).toBeLessThanOrEqual(interval / 2 + 1 / 30);
  });

  it('while the ring is still filling, the gap is shorter, never longer', () => {
    const [gapR] = simulate({ fps: 30, seconds: 0.5, frameOffset: 60 });
    expect(gapR).toBeGreaterThan(0);
    expect(gapR).toBeLessThan(0.5);
  });
});

describe('rewind handling on the ring', () => {
  it('a backward frame step keeps the older history usable', () => {
    const ring = new FrameRing(120);
    for (let n = 0; n <= 60; n++) ring.push(n / 30);

    // Step back one frame from t = 2.0.
    const time = 59 / 30;
    expect(classifyStep(2, time, true)).toBe('rewind');
    ring.dropFrom(time);

    const age = ring.nearest(lookbackTime(time, 6, 0, 0), time);
    expect(time - ring.timeAt(age)).toBeCloseTo(6 / 30, 6);
  });

  it('a loop back to the start drops everything', () => {
    const ring = new FrameRing(120);
    for (let n = 0; n <= 60; n++) ring.push(n / 30);

    expect(classifyStep(2, 0, false)).toBe('rewind');
    ring.dropFrom(0);

    expect(ring.size).toBe(0);
    expect(ring.nearest(-0.2, 0)).toBe(-1);
  });
});
