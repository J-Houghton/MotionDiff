import { posyBlend, rawDiff } from '../core/diff.js';
import { boxBlur } from '../core/blur.js';
import { accumulate } from '../core/trails.js';
import { emaAlpha, seedStates, magnifyFrame } from '../core/magnify.js';
import { cellEnergies } from '../core/energy.js';
import { CircularBuffer, FrameRing, ringCapacity } from '../core/buffer.js';

const TRAIL_CAP = 20;
const trails = new CircularBuffer(TRAIL_CAP);

// ── Frame store ──
// Lives here, not on the main thread: each message carries exactly one
// frame (transferred, not copied) and the lookback never crosses threads.
// `ring` tracks which slot holds which frame; `ringFrames` holds the pixels.
let ring = null;
let ringFrames = [];
let ringWidth = 0;
let ringHeight = 0;

function ensureRing(width, height) {
  if (ring && ringWidth === width && ringHeight === height) return;
  ring = new FrameRing(ringCapacity(width, height));
  ringFrames = new Array(ring.capacity);
  ringWidth = width;
  ringHeight = height;
}

function ringClear() {
  if (ring) ring.clear();
  ringFrames = ring ? new Array(ring.capacity) : [];
}

// ── Magnify EMA state (Float32, normalized 0..1, RGBA layout) ──
let magFast = null;
let magSlow = null;

function magClear() {
  magFast = null;
  magSlow = null;
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

function tintAgeFrame(frame, age, threshold, newestColor, oldestColor) {
  const out = new Uint8ClampedArray(frame.length);
  const thresholdNorm = threshold / 255;
  const rFactor = newestColor[0] + ((oldestColor[0] - newestColor[0]) * age);
  const gFactor = newestColor[1] + ((oldestColor[1] - newestColor[1]) * age);
  const bFactor = newestColor[2] + ((oldestColor[2] - newestColor[2]) * age);

  for (let i = 0; i < frame.length; i += 4) {
    const motion = (
      Math.abs(frame[i] - 128) +
      Math.abs(frame[i + 1] - 128) +
      Math.abs(frame[i + 2] - 128)
    ) / (3 * 127);

    if (motion > thresholdNorm) {
      out[i] = Math.round(rFactor * motion * 255);
      out[i + 1] = Math.round(gFactor * motion * 255);
      out[i + 2] = Math.round(bFactor * motion * 255);
    }

    out[i + 3] = 255;
  }

  return out;
}

self.onmessage = function (e) {
  const msg = e.data;

  if (msg.type === 'clear') {
    trails.clear();
    ringClear();
    magClear();
    return;
  }

  if (msg.type === 'clearTrails') {
    trails.clear();
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
    params,
    width,
    height,
    energyCols,
    energyRows,
  } = msg;

  const {
    frameOffset,
    threshold,
    trailLength,
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

  if (params.algorithm === 'magnify') {
    // Blur applies pre-EMA only; the band is added onto the unblurred frame.
    let emaInput = curData;
    if (params.blurEnabled) {
      emaInput = new Uint8ClampedArray(curData);
      boxBlur(emaInput, width, height);
    }

    // Re-seed on first frame or size change so the first magnified
    // frame equals the input (no flash). Seed from the EMA input (the
    // blurred frame when blur is on) so the band starts at exactly zero.
    if (!magFast || magFast.length !== curData.length) {
      magFast = new Float32Array(curData.length);
      magSlow = new Float32Array(curData.length);
      seedStates(emaInput, magFast, magSlow);
    }

    const magnified = new Uint8ClampedArray(curData.length);
    magnifyFrame(
      emaInput,
      magFast,
      magSlow,
      magnified,
      emaAlpha(params.magFreqHigh, msg.dtMs),
      emaAlpha(params.magFreqLow, msg.dtMs),
      params.magAmp,
      params.magChroma,
      curData
    );

    const magnifiedBuffer = magnified.buffer;
    self.postMessage(
      {
        type: 'result',
        magnifiedBuffer,
        magnifiedWidth: width,
        magnifiedHeight: height,
      },
      [magnifiedBuffer]
    );
    return;
  }

  ensureRing(width, height);

  const k = frameOffset;
  const spread = channelSpread;
  const tintR = normalizeTint(hexToRgb(rgbTintR, '#ff0000'));
  const tintG = normalizeTint(hexToRgb(rgbTintG, '#00ff00'));
  const tintB = normalizeTint(hexToRgb(rgbTintB, '#0000ff'));
  const ageNewest = hexToRgb(ageColorNew, '#ff4400').map((channel) => channel / 255);
  const ageOldest = hexToRgb(ageColorOld, '#0044ff').map((channel) => channel / 255);

  // The ring holds frames older than this one; each channel's gap clamps to
  // the oldest frame while the ring is still filling.
  const ageR = ring.nearest(time - k, time);
  const ageG = ring.nearest(time - (k + spread), time);
  const ageB = ring.nearest(time - (k + spread * 2), time);
  const oldR = ageR < 0 ? null : ringFrames[ring.slotAt(ageR)];
  const oldG = ageG < 0 ? null : ringFrames[ring.slotAt(ageG)];
  const oldB = ageB < 0 ? null : ringFrames[ring.slotAt(ageB)];

  // Keep this frame as history. The buffer was transferred in, so storing
  // it copies nothing.
  ringFrames[ring.push(time)] = curData;

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

  // Sonification energies: post-threshold, pre-composite — the same stage the
  // WebGL path reads back from. Skipped entirely when no grid is requested.
  let energyBuffer = null;
  if (energyCols > 0 && energyRows > 0) {
    energyBuffer = cellEnergies(
      diffData, width, height, energyCols, energyRows, algorithm === 'posy'
    ).buffer;
  }

  trails.push(diffData);

  const T = Math.min(trailLength, trails.size);
  const frames = [];
  for (let t = 0; t < T; t++) {
    const frame = trails.get(t);
    if (!frame) continue;

    if (ageColorEnabled && algorithm === 'posy') {
      const age = T <= 1 ? 0 : t / (T - 1);
      frames.push(tintAgeFrame(frame, age, threshold, ageNewest, ageOldest));
    } else {
      frames.push(frame);
    }
  }

  const isPosy = algorithm === 'posy' && !ageColorEnabled;
  const accResult = accumulate(frames, isPosy);

  if (!accResult) {
    self.postMessage(
      { type: 'result', accumulatedBuffer: null, energyBuffer, energyCols, energyRows },
      energyBuffer ? [energyBuffer] : []
    );
    return;
  }

  const accBuffer = accResult.buffer;
  const transfers = [accBuffer];
  if (energyBuffer) transfers.push(energyBuffer);

  self.postMessage(
    { type: 'result', accumulatedBuffer: accBuffer, energyBuffer, energyCols, energyRows },
    transfers
  );
};
