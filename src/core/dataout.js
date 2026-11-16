// @ts-check
/**
 * Data out (docs/data-out.md): the count-line crossing test and counter,
 * and the serialisers for collected rows. Pure functions and plain state —
 * this module imports nothing (core layer rule).
 *
 * A count line is a segment {x1, y1, x2, y2} in picture pixels, y down.
 * "Side" of a point is the sign of the cross product against the line's
 * direction: +1 on the side the normal (-dy, dx) points to, -1 opposite,
 * 0 exactly on the infinite line.
 */

/**
 * @typedef {{x1: number, y1: number, x2: number, y2: number}} CountLine
 * @typedef {{t: number, id: number, dir: 1|-1}} CrossingEvent
 */

/** @param {CountLine} line @param {number} x @param {number} y @returns {number} */
export function lineSide(line, x, y) {
  return Math.sign((line.x2 - line.x1) * (y - line.y1) - (line.y2 - line.y1) * (x - line.x1));
}

/**
 * Does the step from (x0, y0) to (x1, y1) cross the drawn SEGMENT?
 * Proper segment–segment test: the step's ends must lie on opposite sides
 * of the line, and the line's ends on opposite sides of the step — so a
 * mover passing beyond either end of the drawn line counts nothing.
 *
 * @returns {0|1|-1} 0 when it does not cross; otherwise the side arrived on.
 */
export function segmentCrossing(line, x0, y0, x1, y1) {
  const s0 = lineSide(line, x0, y0);
  const s1 = lineSide(line, x1, y1);
  if (s0 === 0 || s1 === 0 || s0 === s1) return 0;
  const step = { x1: x0, y1: y0, x2: x1, y2: y1 };
  const t0 = lineSide(step, line.x1, line.y1);
  const t1 = lineSide(step, line.x2, line.y2);
  if (t0 === t1) return 0; // the crossing point lies beyond the segment's ends
  return /** @type {1|-1} */ (s1);
}

/**
 * A counter follows tracked boxes over one line. Per id it keeps the last
 * centre and the last definite (non-zero) side, so a box first seen already
 * past the line counts nothing, and landing exactly on the line defers the
 * decision to the next step.
 *
 * @param {CountLine} line
 */
export function createCounter(line) {
  return {
    line,
    /** @type {Map<number, {x: number, y: number, side: number}>} */
    last: new Map(),
    counts: { pos: 0, neg: 0 },
    /** @type {CrossingEvent[]} */
    events: [],
  };
}

/**
 * Step the counter with this frame's tracked boxes.
 * @param {ReturnType<typeof createCounter>} counter
 * @param {{id: number, cx: number, cy: number}[]} objects
 * @param {number} t - Media time, seconds
 * @returns {CrossingEvent[]} The crossings this step produced
 */
export function stepCounter(counter, objects, t) {
  /** @type {CrossingEvent[]} */
  const fresh = [];
  const { line } = counter;
  for (const o of objects) {
    const seen = counter.last.get(o.id);
    const side = lineSide(line, o.cx, o.cy);
    // A crossing is a change of definite side (a frame exactly on the line
    // defers the decision), whose step also passes between the segment's
    // ends — the ends must lie on opposite sides of the step.
    if (seen && seen.side !== 0 && side !== 0 && side !== seen.side) {
      const step = { x1: seen.x, y1: seen.y, x2: o.cx, y2: o.cy };
      if (lineSide(step, line.x1, line.y1) !== lineSide(step, line.x2, line.y2)) {
        const event = /** @type {CrossingEvent} */ ({ t, id: o.id, dir: /** @type {1|-1} */ (side) });
        counter.events.push(event);
        fresh.push(event);
        if (side > 0) counter.counts.pos++; else counter.counts.neg++;
      }
    }
    counter.last.set(o.id, { x: o.cx, y: o.cy, side: side !== 0 ? side : (seen ? seen.side : 0) });
  }
  return fresh;
}

/** The unit normal of the line, pointing to the positive side. */
export function lineNormal(line) {
  const dx = line.x2 - line.x1;
  const dy = line.y2 - line.y1;
  const length = Math.hypot(dx, dy) || 1;
  return { x: -dy / length, y: dx / length };
}

const num = (v, places) => (Number.isFinite(v) ? v.toFixed(places) : '');

/**
 * Track rows as CSV. A row is [t, id, cx, cy, w, h, vx, vy, speed],
 * picture pixels; with a scale the speed also appears in m/s.
 *
 * @param {number[][]} rows
 * @param {number|null} [metresPerPixel]
 */
export function tracksCsv(rows, metresPerPixel = null) {
  const head = 't,id,cx,cy,w,h,vx,vy,speed' + (metresPerPixel ? ',speed_mps' : '');
  const lines = rows.map((r) => {
    const base = [num(r[0], 3), String(r[1]), num(r[2], 1), num(r[3], 1), num(r[4], 1), num(r[5], 1), num(r[6], 1), num(r[7], 1), num(r[8], 1)];
    if (metresPerPixel) base.push(num(r[8] * metresPerPixel, 2));
    return base.join(',');
  });
  return [head, ...lines].join('\n') + '\n';
}

/**
 * The readings log as JSON: a meta header, one row per frame, and the
 * crossing events.
 *
 * @param {object} meta - Clip size, params snapshot, calibration, version
 * @param {object[]} frames
 * @param {CrossingEvent[]} [events]
 */
export function readingsJson(meta, frames, events = []) {
  return JSON.stringify({ meta, frames, events }, null, 1) + '\n';
}
