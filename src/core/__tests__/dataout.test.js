import { describe, it, expect } from 'vitest';
import { createCounter, lineNormal, lineSide, readingsJson, segmentCrossing, stepCounter, tracksCsv } from '../dataout.js';

// A vertical line down the middle of a 640x360 picture, drawn top to bottom.
// Its normal (-dy, dx) points left (negative x), so the LEFT side is positive:
// left→right movers arrive on the negative side.
const LINE = { x1: 320, y1: 0, x2: 320, y2: 360 };

describe('lineSide', () => {
  it('is positive left of a downward line, negative right, zero on it', () => {
    expect(lineSide(LINE, 100, 50)).toBe(1);
    expect(lineSide(LINE, 500, 50)).toBe(-1);
    expect(lineSide(LINE, 320, 123)).toBe(0);
  });
  it('matches the normal', () => {
    const n = lineNormal(LINE);
    expect(lineSide(LINE, 320 + n.x * 10, 180 + n.y * 10)).toBe(1);
  });
});

describe('segmentCrossing', () => {
  it('counts a step across the segment once, with the side arrived on', () => {
    expect(segmentCrossing(LINE, 300, 100, 340, 104)).toBe(-1); // left→right
    expect(segmentCrossing(LINE, 340, 100, 300, 104)).toBe(1); // right→left
  });
  it('counts nothing when the step stays on one side', () => {
    expect(segmentCrossing(LINE, 100, 50, 200, 60)).toBe(0);
    expect(segmentCrossing(LINE, 400, 50, 500, 60)).toBe(0);
  });
  it('counts nothing beyond the segment ends', () => {
    // Crosses the infinite line, but 40 px above the segment's top end.
    expect(segmentCrossing(LINE, 300, -40, 340, -44)).toBe(0);
    expect(segmentCrossing(LINE, 300, 400, 340, 404)).toBe(0);
  });
});

describe('stepCounter', () => {
  it('counts the registered truth-scene pattern: 2 one way, 1 the other', () => {
    const counter = createCounter(LINE);
    // Square and first disc march left→right; the second disc returns.
    stepCounter(counter, [{ id: 1, cx: 250, cy: 110 }, { id: 2, cx: 280, cy: 240 }], 1.0);
    stepCounter(counter, [{ id: 1, cx: 310, cy: 110 }, { id: 2, cx: 310, cy: 250 }], 2.0);
    stepCounter(counter, [{ id: 1, cx: 350, cy: 110 }, { id: 2, cx: 340, cy: 260 }], 2.5);
    stepCounter(counter, [{ id: 3, cx: 360, cy: 300 }], 9.0);
    const events = stepCounter(counter, [{ id: 3, cx: 290, cy: 300 }], 9.5);
    expect(counter.counts).toEqual({ pos: 1, neg: 2 });
    expect(events).toEqual([{ t: 9.5, id: 3, dir: 1 }]);
    expect(counter.events.map((e) => e.id)).toEqual([1, 2, 3]);
  });

  it('a track first seen already past the line counts nothing', () => {
    const counter = createCounter(LINE);
    stepCounter(counter, [{ id: 7, cx: 400, cy: 100 }], 0.5);
    stepCounter(counter, [{ id: 7, cx: 450, cy: 100 }], 1.0);
    expect(counter.counts).toEqual({ pos: 0, neg: 0 });
  });

  it('crossing and returning counts one each way, not twice one way', () => {
    const counter = createCounter(LINE);
    stepCounter(counter, [{ id: 4, cx: 300, cy: 100 }], 1);
    stepCounter(counter, [{ id: 4, cx: 340, cy: 100 }], 2);
    stepCounter(counter, [{ id: 4, cx: 300, cy: 100 }], 3);
    expect(counter.counts).toEqual({ pos: 1, neg: 1 });
  });

  it('landing exactly on the line defers to the next step', () => {
    const counter = createCounter(LINE);
    stepCounter(counter, [{ id: 5, cx: 300, cy: 100 }], 1);
    stepCounter(counter, [{ id: 5, cx: 320, cy: 100 }], 2); // on the line: no count yet
    expect(counter.counts).toEqual({ pos: 0, neg: 0 });
    stepCounter(counter, [{ id: 5, cx: 340, cy: 100 }], 3);
    expect(counter.counts).toEqual({ pos: 0, neg: 1 });
  });
});

describe('tracksCsv', () => {
  const rows = [[1.2345, 3, 100.25, 50.5, 20, 12, 120.04, -0.26, 120.04]];
  it('round-trips its numbers, without m/s when uncalibrated', () => {
    const csv = tracksCsv(rows);
    const [head, row] = csv.trim().split('\n');
    expect(head).toBe('t,id,cx,cy,w,h,vx,vy,speed');
    const cells = row.split(',').map(Number);
    expect(cells[0]).toBeCloseTo(1.234, 3);
    expect(cells[1]).toBe(3);
    expect(cells[8]).toBeCloseTo(120.0, 1);
    expect(row.split(',')).toHaveLength(9);
  });
  it('adds speed_mps exactly when a scale is given', () => {
    const csv = tracksCsv(rows, 0.1);
    const [head, row] = csv.trim().split('\n');
    expect(head.endsWith(',speed_mps')).toBe(true);
    expect(Number(row.split(',')[9])).toBeCloseTo(12.0, 2);
  });
});

describe('readingsJson', () => {
  it('round-trips meta, frames and events', () => {
    const parsed = JSON.parse(readingsJson(
      { width: 640, calibration: 0.1, version: 'abc' },
      [{ t: 0.5, mode: 'mask', counts: { pos: 0, neg: 1 } }],
      [{ t: 0.4, id: 1, dir: -1 }],
    ));
    expect(parsed.meta.calibration).toBe(0.1);
    expect(parsed.frames[0].counts.neg).toBe(1);
    expect(parsed.events[0].dir).toBe(-1);
  });
});
