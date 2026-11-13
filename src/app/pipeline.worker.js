import { posyBlend, rawDiff } from '../core/diff.js';
import { boxBlur, boxBlurFloat } from '../core/blur.js';
import { TRAIL_HOLD, clearTrailState, createTrailState, trailStep } from '../core/trails.js';
import { addBand, boxPool, emaAlpha, emaStep, pooledSize, seedStatesFloat } from '../core/magnify.js';
import { bandMagnitude, diffMagnitude, poolMagnitude } from '../core/magnitude.js';
import { FrameRing, ringCapacity } from '../core/buffer.js';
import { lookbackTime, shouldStore, storeInterval } from '../core/timebase.js';

// ── Trail feedback state (see core/trails.js) ──
// Two states, ping-ponged: `trailCur` is the state after the last frame,
// `trailPrev` the one that frame was computed from, kept so the same frame
// can be re-rendered (a parameter change while paused) without stacking.
const trailStates = [null, null];
let trailCur = 0;
let trailPrev = 0;
let trailHasFrame = false;

function trailsClear() {
  for (const state of trailStates) if (state) clearTrailState(state);
  trailCur = 0;
  trailPrev = 0;
  trailHasFrame = false;
}

function ensureTrailStates(pixelCount) {
  if (trailStates[0] && trailStates[0].peaks.length === pixelCount * 4) return;
  trailStates[0] = createTrailState(pixelCount);
  trailStates[1] = createTrailState(pixelCount);
  trailCur = 0;
  trailPrev = 0;
  trailHasFrame = false;
}

// ── Frame store ──
// Lives here, not on the main thread: each message carries exactly one
// frame (transferred, not copied) and the lookback never crosses threads.
// `ring` tracks which slot holds which frame; `ringFrames` holds the pixels.
let ring = null;
let ringFrames = [];
let ringWidth = 0;
let ringHeight = 0;
// Stamp of the newest frame kept as history
let lastStoredTime = NaN;

function ensureRing(width, height, budgetBytes) {
  if (ring && ringWidth === width && ringHeight === height) return;
  ring = new FrameRing(ringCapacity(width, height, budgetBytes ? { budgetBytes } : undefined));
  ringFrames = new Array(ring.capacity);
  ringWidth = width;
  ringHeight = height;
  lastStoredTime = NaN;
}

function ringClear() {
  if (ring) ring.clear();
  ringFrames = ring ? new Array(ring.capacity) : [];
  lastStoredTime = NaN;
}

/**
 * Drop whatever history a break in the timeline made unusable. The main
 * thread classifies the step (core/timebase.js classifyStep); the worker
 * owns the state it applies to.
 */
function applyStep(step, time) {
  if (step === 'advance' || step === 'repeat') return;

  if (step === 'rewind' && ring) {
    // Frames stamped at or after the new position are in its future.
    if (ring.dropFrom(time) > 0) {
      // Release the pixel buffers of the dropped frames.
      const live = new Set();
      for (let age = 0; age < ring.size; age++) live.add(ring.slotAt(age));
      for (let slot = 0; slot < ring.capacity; slot++) {
        if (!live.has(slot)) ringFrames[slot] = undefined;
      }
    }
    lastStoredTime = ring.newestTime;
  } else {
    ringClear();
  }
  trailsClear();
  magClear();
}

// ── Magnify EMA state (Float32, normalized 0..1, RGBA layout) ──
// The states live on the pooled grid, which on this CPU path is never wider
// than MAG_MAX_GRID_WIDTH (correctness over speed, but not unboundedly slow).
const MAG_MAX_GRID_WIDTH = 320;
let magFast = null;
let magSlow = null;
let magPooled = new Float32Array(0);

function magClear() {
  magFast = null;
  magSlow = null;
}

// ── Shared motion magnitude (see core/magnitude.js) ──
// Each mode fills this per-pixel buffer; the grid is pooled from it the
// same way whatever the mode. Reused across frames, sized on demand.
let magnitudeScratch = new Float32Array(0);

function magnitudeBuffer(pixelCount) {
  if (magnitudeScratch.length !== pixelCount) magnitudeScratch = new Float32Array(pixelCount);
  return magnitudeScratch;
}

/** Pool a filled magnitude buffer into a transferable grid, or null when nobody is listening. */
function pooledEnergy(magnitude, width, height, cols, rows) {
  return poolMagnitude(magnitude, width, height, cols, rows).buffer;
}

function hexToRgb(hex, fallback) {
  const value = typeof hex === 'string' && /^#[0-9a-f]{6}$/i.test(hex) ? hex : fallback;
  return [
    parseInt(value.slice(1, 3), 16),
    parseInt(value.slice(3, 5), 16),
    parseInt(value.slice(5, 7), 16),
  ];
}

function normalizeTint([r, g, b]) {
  const sum = r + g + b;
  if (sum <= 0) return [0, 0, 0];
  return [r / sum, g / sum, b / sum];
}

function tintChannel(frame, index, tint) {
  return Math.round(
    frame[index] * tint[0] +
    frame[index + 1] * tint[1] +
    frame[index + 2] * tint[2]
  );
}

self.onmessage = function (e) {
  const msg = e.data;

  if (msg.type === 'clear') {
    trailsClear();
    ringClear();
    magClear();
    return;
  }

  if (msg.type === 'clearTrails') {
    trailsClear();
    return;
  }

  if (msg.type === 'magReset') {
    magClear();
    return;
  }

  if (msg.type !== 'process') return;

  const {
    currentFrameBuffer,
    time,
    step,
    params,
    width,
    height,
    energyCols,
    energyRows,
  } = msg;

  const {
    frameOffset,
    threshold,
    channelSpread,
    algorithm,
    blurEnabled,
    ageColorEnabled,
    rgbTintR,
    rgbTintG,
    rgbTintB,
    ageColorNew,
    ageColorOld,
  } = params;

  const curData = new Uint8ClampedArray(currentFrameBuffer);

  applyStep(step, time);

  if (params.algorithm === 'magnify') {
    // Pool the frame with a true box average into floats. Rounding the
    // pooled means to 8 bits (as a small 2D canvas would) discards exactly
    // the precision the pooling is for.
    const factor = Math.max(params.magDownsample || 1, Math.ceil(width / MAG_MAX_GRID_WIDTH));
    const grid = pooledSize(width, height, factor);
    const gridLength = grid.width * grid.height * 4;
    if (magPooled.length !== gridLength) magPooled = new Float32Array(gridLength);
    boxPool(curData, width, height, factor, magPooled);

    // Blur applies pre-EMA only; the band is added onto the unblurred frame.
    if (params.blurEnabled) boxBlurFloat(magPooled, grid.width, grid.height);

    // Re-seed on first frame or size change so the first magnified
    // frame equals the input (no flash). Seed from the EMA input (the
    // blurred grid when blur is on) so the band starts at exactly zero.
    if (!magFast || magFast.length !== gridLength) {
      magFast = new Float32Array(gridLength);
      magSlow = new Float32Array(gridLength);
      seedStatesFloat(magPooled, magFast, magSlow);
    }

    emaStep(
      magPooled,
      magFast,
      magSlow,
      emaAlpha(params.magFreqHigh, msg.dtMs),
      emaAlpha(params.magFreqLow, msg.dtMs),
    );

    // Full-resolution output: the frame plus the upsampled, amplified band.
    const magnified = new Uint8ClampedArray(curData.length);
    addBand(curData, width, height, magFast, magSlow, factor, params.magAmp, params.magChroma, magnified);

    // Magnify's motion magnitude is the strength of the amplified band.
    let energyBuffer = null;
    if (energyCols > 0 && energyRows > 0) {
      const magnitude = bandMagnitude(magFast, magSlow, params.magAmp, magnitudeBuffer(grid.width * grid.height));
      energyBuffer = pooledEnergy(magnitude, grid.width, grid.height, energyCols, energyRows);
    }

    const magnifiedBuffer = magnified.buffer;
    self.postMessage(
      {
        type: 'result',
        magnifiedBuffer,
        magnifiedWidth: width,
        magnifiedHeight: height,
        energyBuffer,
        energyCols,
        energyRows,
      },
      energyBuffer ? [magnifiedBuffer, energyBuffer] : [magnifiedBuffer]
    );
    return;
  }

  ensureRing(width, height, msg.ringBudgetBytes);

  const k = frameOffset;
  const spread = channelSpread;
  const tintR = normalizeTint(hexToRgb(rgbTintR, '#ff0000'));
  const tintG = normalizeTint(hexToRgb(rgbTintG, '#00ff00'));
  const tintB = normalizeTint(hexToRgb(rgbTintB, '#0000ff'));
  const ageNewest = hexToRgb(ageColorNew, '#ff4400').map((channel) => channel / 255);
  const ageOldest = hexToRgb(ageColorOld, '#0044ff').map((channel) => channel / 255);

  // The ring holds frames older than this one; each channel's gap clamps to
  // the oldest frame while the ring is still filling.
  const ageR = ring.nearest(lookbackTime(time, k, spread, 0), time);
  const ageG = ring.nearest(lookbackTime(time, k, spread, 1), time);
  const ageB = ring.nearest(lookbackTime(time, k, spread, 2), time);
  const oldR = ageR < 0 ? null : ringFrames[ring.slotAt(ageR)];
  const oldG = ageG < 0 ? null : ringFrames[ring.slotAt(ageG)];
  const oldB = ageB < 0 ? null : ringFrames[ring.slotAt(ageB)];

  // Keep this frame as history (the buffer was transferred in, so storing
  // it copies nothing) unless it is a re-render of the frame before, or
  // history is being thinned to fit a long lookback into the ring.
  if (step !== 'repeat' && shouldStore(lastStoredTime, time, storeInterval(k, spread, ring.capacity))) {
    ringFrames[ring.push(time)] = curData;
    lastStoredTime = time;
  }

  if (!oldR || !oldG || !oldB) {
    self.postMessage({ type: 'result', accumulatedBuffer: null });
    return;
  }

  const len = curData.length;
  const compositeOld = new Uint8ClampedArray(len);
  for (let i = 0; i < len; i += 4) {
    compositeOld[i]     = tintChannel(oldR, i, tintR);
    compositeOld[i + 1] = tintChannel(oldG, i, tintG);
    compositeOld[i + 2] = tintChannel(oldB, i, tintB);
    compositeOld[i + 3] = 255;
  }

  const diffData = new Uint8ClampedArray(len);

  if (algorithm === 'posy') {
    posyBlend(curData, compositeOld, diffData, threshold);
  } else {
    rawDiff(curData, compositeOld, diffData, threshold);
  }

  if (blurEnabled) {
    boxBlur(diffData, width, height);
  }

  // Motion magnitude: post threshold and blur, pre composite — the same
  // stage the WebGL path measures. Skipped entirely when no grid is requested.
  let energyBuffer = null;
  if (energyCols > 0 && energyRows > 0) {
    const magnitude = diffMagnitude(diffData, algorithm === 'posy', magnitudeBuffer(width * height));
    energyBuffer = pooledEnergy(magnitude, width, height, energyCols, energyRows);
  }

  // Advance the trail by this diff. The same frame rendered again starts
  // from the state the first attempt started from.
  ensureTrailStates(width * height);
  const isPosy = algorithm === 'posy';
  if (!(step === 'repeat' && trailHasFrame)) {
    trailPrev = trailCur;
    trailCur = 1 - trailCur;
  }
  const accResult = new Uint8ClampedArray(len);
  const trailOpts = { isPosy, ageStep: msg.trailAgeStep || 0, hold: TRAIL_HOLD };
  if (ageColorEnabled && isPosy) {
    trailOpts.ageColorNew = ageNewest;
    trailOpts.ageColorOld = ageOldest;
  }
  trailStep(trailStates[trailPrev], trailStates[trailCur], diffData, accResult, trailOpts);
  trailHasFrame = true;

  const accBuffer = accResult.buffer;
  const transfers = [accBuffer];
  if (energyBuffer) transfers.push(energyBuffer);

  self.postMessage(
    { type: 'result', accumulatedBuffer: accBuffer, energyBuffer, energyCols, energyRows },
    transfers
  );
};
