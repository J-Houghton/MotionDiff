import { describe, expect, it } from 'vitest';
import { containment, fit, iou, matchBoxes } from '../boxmatch.js';

const box = (x, y, w, h) => ({ x, y, w, h });
/** A detection: a box with the model's label. */
const det = (label, x, y, w, h) => ({ label, x, y, w, h });
/** id → the label its motion box took, for the whole result. */
const namesOf = (out) => Object.fromEntries(out.pairs.map((p) => [p.track.id, p.detection.label]));

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

describe('containment', () => {
  it('is the share of the smaller box inside the larger, whichever is passed first', () => {
    const car = box(0, 0, 100, 60);
    const strip = box(80, 10, 10, 40);
    expect(containment(strip, car)).toBe(1);
    expect(containment(car, strip)).toBe(1);
    // Half the strip hangs out past the car's front.
    expect(containment(box(95, 10, 10, 40), car)).toBeCloseTo(0.5);
    expect(containment(box(200, 0, 10, 10), car)).toBe(0);
  });
});

describe('fit', () => {
  it('a thin strip inside a car matches on containment where IoU alone would not', () => {
    const car = box(0, 0, 100, 60);
    const strip = box(80, 10, 10, 40); // 400 of 6000 px²: IoU 0.07
    expect(iou(strip, car)).toBeLessThan(0.15);
    expect(fit(strip, car)).toBeGreaterThan(1);
  });

  it('a speck inside a bus is not the bus', () => {
    const bus = box(0, 0, 200, 100);
    expect(fit(box(50, 50, 20, 20), bus)).toBe(0); // 2% of it
  });

  it('boxes that merely brush do not match', () => {
    expect(fit(box(0, 0, 10, 10), box(8, 8, 10, 10))).toBe(0);
  });

  it('boxes of like size still match on overlap alone', () => {
    // Offset by a third: nothing is inside anything, IoU 0.5.
    expect(fit(box(0, 0, 30, 30), box(10, 0, 30, 30))).toBeGreaterThan(0);
  });
});

describe('matchBoxes', () => {
  it('a strip inside a car takes the car\'s name', () => {
    // The mask often boxes only a mover's leading edge.
    const out = matchBoxes([{ id: 1, ...box(380, 250, 14, 60) }], [det('car', 300, 240, 100, 80)]);
    expect(namesOf(out)).toEqual({ 1: 'car' });
    expect(out.trackOnly).toEqual([]);
    expect(out.detectionOnly).toEqual([]);
  });

  it('two clumps on one car both take its name', () => {
    // One car, boxed by motion as its bonnet and its boot.
    const car = det('car', 100, 100, 120, 60);
    const out = matchBoxes(
      [{ id: 1, ...box(100, 105, 40, 50) }, { id: 2, ...box(175, 105, 45, 50) }],
      [car],
    );
    expect(namesOf(out)).toEqual({ 1: 'car', 2: 'car' });
    expect(out.detectionOnly).toEqual([]);
    expect(out.covered).toEqual([]);
  });

  it('two cars side by side do not swap, though their boxes overlap', () => {
    // Seen at an angle the model's two boxes share a band (x 190..210);
    // each motion box reaches into it.
    const car = det('car', 100, 100, 110, 60);
    const truck = det('truck', 190, 95, 130, 70);
    const out = matchBoxes(
      [{ id: 1, ...box(110, 105, 95, 50) }, { id: 2, ...box(195, 100, 120, 60) }],
      [car, truck],
    );
    expect(namesOf(out)).toEqual({ 1: 'car', 2: 'truck' });
  });

  it('nor do strips: each lies in its own car, one of them inside the shared band', () => {
    const car = det('car', 100, 100, 110, 60);
    const truck = det('truck', 190, 95, 130, 70);
    const out = matchBoxes(
      [{ id: 1, ...box(150, 110, 50, 40) }, { id: 2, ...box(196, 100, 60, 60) }],
      [car, truck],
    );
    // Box 1 is wholly in the car and a fifth in the truck; box 2 is wholly
    // in the truck and a quarter in the car.
    expect(namesOf(out)).toEqual({ 1: 'car', 2: 'truck' });
  });

  it('of two detections that both hold a strip, the snugger names it', () => {
    // A car in front of a bus: the strip is inside both boxes.
    const out = matchBoxes(
      [{ id: 1, ...box(120, 130, 30, 30) }],
      [det('bus', 0, 0, 300, 200), det('car', 100, 120, 80, 50)],
    );
    expect(namesOf(out)).toEqual({ 1: 'car' });
  });

  it('a clump over two cars takes one name, and the other car is not a model-only find', () => {
    // A queue boxed as one motion clump. The model sees two cars inside
    // it: motion found both, it just did not tell them apart.
    const near = det('truck', 100, 100, 100, 80);
    const far = det('car', 205, 110, 60, 50);
    const out = matchBoxes([{ id: 1, ...box(95, 95, 175, 90) }], [near, far]);
    expect(namesOf(out)).toEqual({ 1: 'truck' });
    expect(out.covered).toEqual([far]);
    expect(out.detectionOnly).toEqual([]);
  });

  it('what fits nothing stays on its own side', () => {
    const tracks = [{ id: 1, ...box(0, 0, 10, 10) }, { id: 2, ...box(100, 100, 10, 10) }];
    const detections = [det('car', 1, 1, 10, 10), det('person', 50, 50, 10, 10)];
    const out = matchBoxes(tracks, detections);
    expect(namesOf(out)).toEqual({ 1: 'car' });
    expect(out.trackOnly).toEqual([tracks[1]]);
    expect(out.detectionOnly).toEqual([detections[1]]);
  });

  it('a false detection the width of the frame names nothing small inside it', () => {
    const out = matchBoxes(
      [{ id: 1, ...box(100, 400, 50, 20) }, { id: 2, ...box(700, 380, 40, 30) }],
      [det('car', 0, 340, 960, 190)],
    );
    expect(out.pairs).toEqual([]);
    expect(out.detectionOnly).toHaveLength(1);
  });

  it('empty sides stay empty', () => {
    expect(matchBoxes([], []).pairs).toEqual([]);
    expect(matchBoxes([box(0, 0, 5, 5)], []).trackOnly).toHaveLength(1);
    expect(matchBoxes([], [box(0, 0, 5, 5)]).detectionOnly).toHaveLength(1);
  });
});
