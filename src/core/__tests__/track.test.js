import { describe, it, expect } from 'vitest';
import { TRACK_BIRTH, bornTracks, labelComponents, stepTracks } from '../track.js';

const grid = (cols, rows, boxes) => {
  const mask = new Uint8Array(cols * rows);
  for (const [x0, y0, w, h] of boxes) {
    for (let y = y0; y < y0 + h; y++) for (let x = x0; x < x0 + w; x++) mask[y * cols + x] = 1;
  }
  return mask;
};

describe('labelComponents', () => {
  it('finds separate shapes with boxes and centroids', () => {
    const mask = grid(20, 12, [[2, 2, 4, 3], [10, 6, 5, 4]]);
    const parts = labelComponents(mask, 20, 12);
    expect(parts).toHaveLength(2);
    const a = parts.find((p) => p.x0 === 2);
    expect(a).toMatchObject({ x0: 2, y0: 2, x1: 5, y1: 4, area: 12 });
    expect(a.cx).toBeCloseTo(3.5, 5);
    expect(a.cy).toBeCloseTo(3, 5);
  });

  it('joins touching cells and drops specks below the minimum area', () => {
    const mask = grid(20, 12, [[2, 2, 2, 2], [4, 3, 2, 2]]); // touching => one shape
    mask[11 * 20 + 19] = 1; // a lone speck
    const parts = labelComponents(mask, 20, 12, 4);
    expect(parts).toHaveLength(1);
    expect(parts[0].area).toBe(8);
  });

  it('does not join diagonal neighbours', () => {
    const mask = grid(10, 10, [[1, 1, 2, 2], [3, 3, 2, 2]]);
    expect(labelComponents(mask, 10, 10, 1)).toHaveLength(2);
  });
});

describe('stepTracks', () => {
  const dt = 1 / 30;
  const det = (cx, cy) => ({ cx, cy, w: 40, h: 30 });

  const run = (frames) => {
    let state = { tracks: [], nextId: 1 };
    for (const detections of frames) state = stepTracks(state.tracks, detections, { dt, nextId: state.nextId });
    return state;
  };

  it('keeps one ID on a steadily moving shape and measures its speed', () => {
    const frames = Array.from({ length: 10 }, (_, k) => [det(100 + 4 * k, 50)]); // 4 px/frame = 120 px/s
    const { tracks } = run(frames);
    expect(tracks).toHaveLength(1);
    expect(tracks[0].id).toBe(1);
    expect(tracks[0].hits).toBe(10);
    expect(Math.hypot(tracks[0].vx, tracks[0].vy)).toBeGreaterThan(96); // within 20% of 120
    expect(Math.hypot(tracks[0].vx, tracks[0].vy)).toBeLessThan(144);
  });

  it('births only after persistence, so a one-frame flicker never shows', () => {
    const flicker = run([[det(10, 10)], [], []]);
    expect(flicker.tracks).toHaveLength(0);
    const persisted = run(Array.from({ length: TRACK_BIRTH }, (_, k) => [det(10 + k, 10)]));
    expect(bornTracks(persisted.tracks)).toHaveLength(1);
  });

  it('keeps two crossing movers apart by prediction', () => {
    // Two shapes far apart, converging but never overlapping.
    const frames = Array.from({ length: 8 }, (_, k) => [det(50 + 10 * k, 50), det(400 - 10 * k, 300)]);
    const { tracks } = run(frames);
    expect(tracks).toHaveLength(2);
    const ids = tracks.map((t) => t.id).sort();
    expect(ids).toEqual([1, 2]);
    // The one born at the left still moves right, and the other still moves left.
    const left = tracks.find((t) => t.vx > 0);
    const right = tracks.find((t) => t.vx < 0);
    expect(left).toBeTruthy();
    expect(right).toBeTruthy();
  });

  it('coasts a lost mover briefly, then lets it die', () => {
    let state = run(Array.from({ length: 5 }, (_, k) => [det(100 + 4 * k, 50)]));
    // Lost for three frames: coasts, same ID on return.
    for (let k = 0; k < 3; k++) state = stepTracks(state.tracks, [], { dt, nextId: state.nextId });
    expect(state.tracks).toHaveLength(1);
    expect(state.tracks[0].miss).toBe(3);
    state = stepTracks(state.tracks, [det(100 + 4 * 8, 50)], { dt, nextId: state.nextId });
    expect(state.tracks[0].id).toBe(1);
    expect(state.tracks[0].miss).toBe(0);
    // Lost for longer than the coast: gone.
    for (let k = 0; k < 6; k++) state = stepTracks(state.tracks, [], { dt, nextId: state.nextId });
    expect(state.tracks).toHaveLength(0);
  });

  it('never reuses an ID', () => {
    let state = run(Array.from({ length: TRACK_BIRTH + 1 }, () => [det(10, 10)]));
    for (let k = 0; k < 7; k++) state = stepTracks(state.tracks, [], { dt, nextId: state.nextId });
    expect(state.tracks).toHaveLength(0);
    state = stepTracks(state.tracks, [det(10, 10)], { dt, nextId: state.nextId });
    expect(state.tracks[0].id).toBe(2);
  });
});
