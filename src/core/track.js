// @ts-check
/**
 * Grouping and tracking (docs/tracking.md): connected components over a
 * coarse decision grid, and the track step that gives shapes an identity —
 * an ID that stays with a mover, a velocity from its own displacement, and
 * a short coast across frames the mask loses.
 *
 * Pure functions; app/stages.js feeds them and publishes the results.
 */

/**
 * @typedef {object} Component
 * @property {number} area - Cells
 * @property {number} x0 @property {number} y0 - Bounding box, inclusive, cells
 * @property {number} x1 @property {number} y1
 * @property {number} cx @property {number} cy - Centroid, cells
 *
 * @typedef {object} Track
 * @property {number} id
 * @property {number} cx @property {number} cy - Centre, picture px
 * @property {number} w @property {number} h - Box, picture px
 * @property {number} vx @property {number} vy - Picture px/s, smoothed
 * @property {number} age - Seconds since birth
 * @property {number} hits - Frames matched in a row at the start of life
 * @property {number} miss - Frames coasted since last match
 */

/**
 * 4-neighbour connected components over a 0/1 grid.
 *
 * @param {Uint8Array|number[]} mask - cols*rows cells, nonzero = set
 * @param {number} cols
 * @param {number} rows
 * @param {number} [minArea] - Components smaller than this are noise
 * @returns {Component[]}
 */
export function labelComponents(mask, cols, rows, minArea = 4) {
  const seen = new Uint8Array(cols * rows);
  const out = [];
  const stack = new Int32Array(cols * rows);
  for (let start = 0; start < cols * rows; start++) {
    if (!mask[start] || seen[start]) continue;
    let top = 0;
    stack[top++] = start;
    seen[start] = 1;
    let area = 0;
    let sx = 0;
    let sy = 0;
    let x0 = cols;
    let y0 = rows;
    let x1 = 0;
    let y1 = 0;
    while (top > 0) {
      const at = stack[--top];
      const x = at % cols;
      const y = (at - x) / cols;
      area++;
      sx += x;
      sy += y;
      if (x < x0) x0 = x;
      if (y < y0) y0 = y;
      if (x > x1) x1 = x;
      if (y > y1) y1 = y;
      if (x > 0 && mask[at - 1] && !seen[at - 1]) { seen[at - 1] = 1; stack[top++] = at - 1; }
      if (x < cols - 1 && mask[at + 1] && !seen[at + 1]) { seen[at + 1] = 1; stack[top++] = at + 1; }
      if (y > 0 && mask[at - cols] && !seen[at - cols]) { seen[at - cols] = 1; stack[top++] = at - cols; }
      if (y < rows - 1 && mask[at + cols] && !seen[at + cols]) { seen[at + cols] = 1; stack[top++] = at + cols; }
    }
    if (area >= minArea) out.push({ area, x0, y0, x1, y1, cx: sx / area, cy: sy / area });
  }
  return out;
}

/** How many frames a new shape must persist before it is a mover. */
export const TRACK_BIRTH = 5;
/** How many frames a lost mover coasts on its prediction before it dies —
 * long enough to live through a merge with a neighbour and come back out. */
export const TRACK_COAST = 15;
/** EMA weight of the newest displacement in a track's velocity. */
export const TRACK_SMOOTH = 0.35;

/**
 * One tracking step: match detections to live tracks, update, birth, coast.
 *
 * Matching is greedy nearest-first between each track's predicted centre
 * (its own velocity, one dt ahead) and the detections, gated by the
 * detection's size — cheap, readable, and enough for movers that do not
 * swap places within a frame.
 *
 * @param {Track[]} tracks - Live tracks (mutated copies are returned; the
 *   input array is not changed)
 * @param {{cx: number, cy: number, w: number, h: number}[]} detections -
 *   Picture px
 * @param {object} options
 * @param {number} options.dt - Seconds since the previous step
 * @param {number} options.nextId - First unused ID
 * @param {number} [options.gate] - Match reach as a multiple of the
 *   detection's larger side (2)
 * @param {number} [options.coast] @param {number} [options.birth]
 * @param {number} [options.smooth]
 * @returns {{tracks: Track[], nextId: number}}
 */
export function stepTracks(tracks, detections, options) {
  const dt = Math.max(options.dt, 1e-3);
  const gate = options.gate ?? 2;
  const coast = options.coast ?? TRACK_COAST;
  const birth = options.birth ?? TRACK_BIRTH;
  const smooth = options.smooth ?? TRACK_SMOOTH;
  let nextId = options.nextId;

  const predicted = tracks.map((t) => ({ ...t, px: t.cx + t.vx * dt, py: t.cy + t.vy * dt }));
  const pairs = [];
  predicted.forEach((t, ti) => {
    detections.forEach((d, di) => {
      const reach = gate * Math.max(d.w, d.h, 24);
      const dist = Math.hypot(t.px - d.cx, t.py - d.cy);
      if (dist > reach) return;
      // A shape several times the track's size is a different thing (a
      // queue merging into one blob must not steal a car's ID)…
      const sizeRatio = Math.max(d.w * d.h, 64) / Math.max(t.w * t.h, 64);
      if (sizeRatio > 6 || sizeRatio < 1 / 6) return;
      // …and so is a match that implies the mover teleported.
      const impliedSpeed = dist / dt;
      const known = Math.hypot(t.vx, t.vy);
      if (t.hits > 3 && impliedSpeed > known * 3 + 120) return;
      pairs.push({ ti, di, dist });
    });
  });
  pairs.sort((a, b) => a.dist - b.dist);

  const trackTaken = new Set();
  const detTaken = new Set();
  const out = [];
  for (const { ti, di } of pairs) {
    if (trackTaken.has(ti) || detTaken.has(di)) continue;
    trackTaken.add(ti);
    detTaken.add(di);
    const t = predicted[ti];
    const d = detections[di];
    const vx = (d.cx - t.cx) / dt;
    const vy = (d.cy - t.cy) / dt;
    out.push({
      id: t.id,
      cx: d.cx,
      cy: d.cy,
      w: d.w,
      h: d.h,
      vx: t.vx + (vx - t.vx) * smooth,
      vy: t.vy + (vy - t.vy) * smooth,
      age: t.age + dt,
      hits: t.hits + 1,
      miss: 0,
    });
  }
  // Lost tracks coast on their prediction; candidates (not yet born) die at once.
  predicted.forEach((t, ti) => {
    if (trackTaken.has(ti)) return;
    if (t.hits < birth || t.miss + 1 > coast) return;
    out.push({
      id: t.id, cx: t.px, cy: t.py, w: t.w, h: t.h, vx: t.vx, vy: t.vy,
      age: t.age + dt, hits: t.hits, miss: t.miss + 1,
    });
  });
  // New shapes become candidate tracks.
  detections.forEach((d, di) => {
    if (detTaken.has(di)) return;
    out.push({ id: nextId++, cx: d.cx, cy: d.cy, w: d.w, h: d.h, vx: 0, vy: 0, age: dt, hits: 1, miss: 0 });
  });
  return { tracks: out, nextId };
}

/** The tracks worth showing: persisted past birth. */
export function bornTracks(tracks, birth = TRACK_BIRTH) {
  return tracks.filter((t) => t.hits >= birth);
}
