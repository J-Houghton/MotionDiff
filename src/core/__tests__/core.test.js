import { describe, it, test, expect } from 'vitest';
import { posyBlend, rawDiff } from '../diff.js';
import { accumulate } from '../trails.js';
import { boxBlur } from '../blur.js';
import { CircularBuffer, FrameRing, ringCapacity } from '../buffer.js';
import { analyzeSample } from '../analyze.js';
import { buildSourceProfile, isStreamSource } from '../../app/source-profile.js';

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
    // devR=6, devG=0, devB=0, mag=2
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
//  trails.js — accumulate
// ─────────────────────────────────────

describe('accumulate', () => {
  it('empty frames returns null (raw mode)', () => {
    expect(accumulate([], false)).toBeNull();
  });

  it('empty frames returns null (Posy mode)', () => {
    expect(accumulate([], true)).toBeNull();
  });

  it('raw mode — single frame passes through exactly', () => {
    const frame = makePixels([100, 50, 200, 255]);
    const result = accumulate([frame], false);

    expect(result[0]).toBe(100);
    expect(result[1]).toBe(50);
    expect(result[2]).toBe(200);
    expect(result[3]).toBe(255);
  });

  it('raw mode — max wins per channel', () => {
    const frame1 = makePixels([200, 50, 100, 255]);
    const frame2 = makePixels([100, 180, 80, 255]);
    const result = accumulate([frame1, frame2], false);

    expect(result[0]).toBe(200);
    expect(result[1]).toBe(180);
    expect(result[2]).toBe(100);
    expect(result[3]).toBe(255);
  });

  it('Posy mode — highest deviation from 128 wins', () => {
    // frame1: R=180 (dev 52), G=128 (dev 0)
    // frame2: R=128 (dev 0),  G=60  (dev 68)
    const frame1 = makePixels([180, 128, 128, 255]);
    const frame2 = makePixels([128, 60, 128, 255]);
    const result = accumulate([frame1, frame2], true);

    expect(result[0]).toBe(180); // deviation 52 wins
    expect(result[1]).toBe(60);  // deviation 68 wins (60 < 128 but higher deviation)
    expect(result[2]).toBe(128); // no deviation in either frame
    expect(result[3]).toBe(255);
  });

  it('Posy mode — base frame is gray (128)', () => {
    const frame = makePixels([128, 128, 128, 255]);
    const result = accumulate([frame], true);

    expect(result[0]).toBe(128);
    expect(result[1]).toBe(128);
    expect(result[2]).toBe(128);
    expect(result[3]).toBe(255);
  });

  it('does not mutate input frames', () => {
    const frame1 = makePixels([200, 50, 100, 255]);
    const frame2 = makePixels([100, 180, 80, 255]);
    const copy1 = new Uint8ClampedArray(frame1);
    const copy2 = new Uint8ClampedArray(frame2);

    accumulate([frame1, frame2], false);

    expect(frame1).toEqual(copy1);
    expect(frame2).toEqual(copy2);
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
//  buffer.js — CircularBuffer
// ─────────────────────────────────────

describe('CircularBuffer', () => {
  it('push and get', () => {
    const buf = new CircularBuffer(5);
    buf.push('a');
    expect(buf.get(0)).toBe('a');
  });

  it('size tracks correctly', () => {
    const buf = new CircularBuffer(5);
    expect(buf.size).toBe(0);
    buf.push('a');
    buf.push('b');
    expect(buf.size).toBe(2);
  });

  it('get out of bounds returns null', () => {
    const buf = new CircularBuffer(5);
    buf.push('a');
    expect(buf.get(-1)).toBeNull();
    expect(buf.get(1)).toBeNull(); // size is 1, offset 1 is out of range
  });

  it('wraps correctly at capacity', () => {
    const buf = new CircularBuffer(3);
    buf.push('a');
    buf.push('b');
    buf.push('c');
    buf.push('d'); // overwrites 'a'

    expect(buf.get(0)).toBe('d');
    expect(buf.get(1)).toBe('c');
    expect(buf.get(2)).toBe('b');
    expect(buf.size).toBe(3);

    // 'a' is no longer accessible
    expect(buf.get(3)).toBeNull();
  });

  it('clear resets state', () => {
    const buf = new CircularBuffer(5);
    buf.push('a');
    buf.push('b');
    buf.clear();

    expect(buf.size).toBe(0);
    expect(buf.get(0)).toBeNull();
  });
});

describe('CircularBuffer.replaceNewest', () => {
  it('overwrites the newest entry without growing', () => {
    const buf = new CircularBuffer(3);
    buf.push('a');
    buf.push('b');
    buf.replaceNewest('c');

    expect(buf.size).toBe(2);
    expect(buf.get(0)).toBe('c');
    expect(buf.get(1)).toBe('a');
  });

  it('pushes when the buffer is empty', () => {
    const buf = new CircularBuffer(3);
    buf.replaceNewest('a');

    expect(buf.size).toBe(1);
    expect(buf.get(0)).toBe('a');
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

describe('analyzeSample', () => {
  it('suggests a low threshold and long offset for near-zero motion', () => {
    const frames = [
      makePixels([10, 20, 30, 255], [40, 50, 60, 255]),
      makePixels([10, 20, 30, 255], [40, 50, 60, 255]),
      makePixels([10, 20, 30, 255], [40, 50, 60, 255]),
    ];

    const result = analyzeSample(frames, 30);

    expect(result.threshold).toBe(5);
    expect(result.frameOffset).toBe(15);
  });

  it('suggests a high threshold and short offset for strong motion', () => {
    const frames = [
      makePixels([0, 0, 0, 255], [0, 0, 0, 255]),
      makePixels([255, 255, 255, 255], [255, 255, 255, 255]),
      makePixels([0, 0, 0, 255], [0, 0, 0, 255]),
    ];

    const result = analyzeSample(frames, 30);

    expect(result.threshold).toBe(40);
    expect(result.frameOffset).toBe(2);
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
