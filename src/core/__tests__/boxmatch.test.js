import { describe, expect, it } from 'vitest';
import { iou, matchBoxes } from '../boxmatch.js';

const box = (x, y, w, h) => ({ x, y, w, h });

describe('iou', () => {
  it('is 1 for the same box and 0 for disjoint boxes', () => {
    expect(iou(box(10, 10, 20, 20), box(10, 10, 20, 20))).toBe(1);
    expect(iou(box(0, 0, 10, 10), box(20, 20, 10, 10))).toBe(0);
  });

  it('boxes that only touch do not overlap', () => {
    expect(iou(box(0, 0, 10, 10), box(10, 0, 10, 10))).toBe(0);
  });

  it('a half-offset box overlaps by a third', () => {
    // Shared 50, union 150.
    expect(iou(box(0, 0, 10, 10), box(5, 0, 10, 10))).toBeCloseTo(1 / 3);
  });
});

describe('matchBoxes', () => {
  it('pairs the overlapping, leaves the rest on their own sides', () => {
    const tracks = [box(0, 0, 10, 10), box(100, 100, 10, 10)];
    const detections = [box(1, 1, 10, 10), box(50, 50, 10, 10)];
    const out = matchBoxes(tracks, detections);
    expect(out.pairs).toHaveLength(1);
    expect(out.pairs[0].track).toBe(tracks[0]);
    expect(out.pairs[0].detection).toBe(detections[0]);
    expect(out.trackOnly).toEqual([tracks[1]]);
    expect(out.detectionOnly).toEqual([detections[1]]);
  });

  it('each side pairs at most once, best overlap first', () => {
    // Two detections over one track: the better fit wins, the other is a
    // model-only find (two parked cars under one motion clump stay honest).
    const tracks = [box(0, 0, 20, 10)];
    const detections = [box(0, 0, 10, 10), box(0, 0, 20, 10)];
    const out = matchBoxes(tracks, detections);
    expect(out.pairs).toHaveLength(1);
    expect(out.pairs[0].detection).toBe(detections[1]);
    expect(out.detectionOnly).toEqual([detections[0]]);
  });

  it('overlap under the bar is no match', () => {
    const out = matchBoxes([box(0, 0, 10, 10)], [box(8, 8, 10, 10)]);
    expect(out.pairs).toHaveLength(0);
    expect(out.trackOnly).toHaveLength(1);
    expect(out.detectionOnly).toHaveLength(1);
  });

  it('empty sides stay empty', () => {
    expect(matchBoxes([], []).pairs).toEqual([]);
    expect(matchBoxes([box(0, 0, 5, 5)], []).trackOnly).toHaveLength(1);
    expect(matchBoxes([], [box(0, 0, 5, 5)]).detectionOnly).toHaveLength(1);
  });
});
