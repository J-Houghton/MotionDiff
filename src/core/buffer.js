/**
 * Frame ring.
 *
 * `FrameRing` holds no pixels at all: it hands out slot numbers and
 * remembers when each slot's frame was stamped, so the same bookkeeping
 * drives a GPU texture-array ring (slot = layer) and the worker's array of
 * pixel buffers (slot = array index).
 */

export class FrameRing {
  /**
   * @param {number} capacity - Number of slots (at least 1)
   */
  constructor(capacity) {
    const cap = Math.floor(Number(capacity));
    this._cap = Number.isFinite(cap) && cap > 0 ? cap : 1;
    this._times = new Float64Array(this._cap);
    this._head = -1;
    this._size = 0;
  }

  get size() { return this._size; }

  get capacity() { return this._cap; }

  clear() {
    this._head = -1;
    this._size = 0;
  }

  /**
   * Claim the slot for a new newest frame, evicting the oldest when full.
   * Stamps must not decrease: call `dropFrom(time)` first after a rewind.
   *
   * @param {number} time - The frame's timestamp
   * @returns {number} Slot to write the frame's pixels into
   */
  push(time) {
    this._head = (this._head + 1) % this._cap;
    this._times[this._head] = time;
    if (this._size < this._cap) this._size++;
    return this._head;
  }

  /**
   * @param {number} age - 0 is the newest frame
   * @returns {number} Slot index, or -1 when there is no such frame
   */
  slotAt(age) {
    if (!(age >= 0) || age >= this._size) return -1;
    return (this._head - age + this._cap) % this._cap;
  }

  /**
   * @param {number} age - 0 is the newest frame
   * @returns {number} Timestamp, or NaN when there is no such frame
   */
  timeAt(age) {
    const slot = this.slotAt(age);
    return slot < 0 ? NaN : this._times[slot];
  }

  get newestTime() { return this.timeAt(0); }

  get oldestTime() { return this.timeAt(this._size - 1); }

  /**
   * Drop every frame stamped at or after `time`. After playback jumps
   * backwards those frames lie in the future of the new position.
   *
   * @param {number} time
   * @returns {number} How many frames were dropped
   */
  dropFrom(time) {
    let dropped = 0;
    while (this._size > 0 && this._times[this._head] >= time) {
      this._head = (this._head - 1 + this._cap) % this._cap;
      this._size--;
      dropped++;
    }
    if (this._size === 0) this._head = -1;
    return dropped;
  }

  /**
   * Age of the stored frame whose stamp is closest to `target`, looking only
   * at frames stamped strictly before `before`. When two frames are equally
   * close the newer one wins. A target older than everything stored resolves
   * to the oldest frame, so a ring that is still filling yields a shorter gap
   * instead of nothing.
   *
   * @param {number} target
   * @param {number} [before]
   * @returns {number} Age (0 = newest), or -1 when no frame qualifies
   */
  nearest(target, before = Infinity) {
    let best = -1;
    let bestDistance = Infinity;
    for (let age = 0; age < this._size; age++) {
      const time = this._times[(this._head - age + this._cap) % this._cap];
      if (!(time < before)) continue;
      const distance = Math.abs(time - target);
      if (distance < bestDistance) {
        bestDistance = distance;
        best = age;
      } else if (time < target) {
        // Stamps only get older from here on; nothing can be closer.
        break;
      }
    }
    return best;
  }
}

const BYTES_PER_PIXEL = 4;

/** Default memory budget for one frame ring. */
export const RING_BUDGET_BYTES = 192 * 1024 * 1024;
/** Upper bound on ring length whatever the budget allows. */
export const RING_MAX_FRAMES = 120;
/** Below this the ring cannot serve the three RGB-spread lookbacks. */
export const RING_MIN_FRAMES = 4;

/**
 * How many RGBA8 frames of the given size a ring may hold within a memory
 * budget. At the default 640x360 the frame cap applies (120 frames, 105 MiB);
 * at 1280x720 the budget allows 54 and at 1920x1080 only 24.
 *
 * @param {number} width
 * @param {number} height
 * @param {{budgetBytes?: number, maxFrames?: number, minFrames?: number}} [opts]
 * @returns {number}
 */
export function ringCapacity(width, height, opts = {}) {
  const budgetBytes = opts.budgetBytes ?? RING_BUDGET_BYTES;
  const maxFrames = opts.maxFrames ?? RING_MAX_FRAMES;
  const minFrames = opts.minFrames ?? RING_MIN_FRAMES;

  const frameBytes = Math.floor(width) * Math.floor(height) * BYTES_PER_PIXEL;
  if (!(frameBytes > 0)) return minFrames;

  const affordable = Math.floor(budgetBytes / frameBytes);
  return Math.max(minFrames, Math.min(maxFrames, affordable));
}
