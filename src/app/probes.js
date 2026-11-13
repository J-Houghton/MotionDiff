/**
 * Dev-only parity probes: the same synthetic frames through the core
 * functions and through the WebGL shaders, reporting the largest difference.
 * Only referenced behind `import.meta.env.DEV`, so production builds drop
 * this file. Each probe resizes the renderer and clears the pipeline — run
 * them on an idle page.
 */
import { boxBlur } from '../core/blur.js';
import { posyBlend, rawDiff } from '../core/diff.js';
import { diffMagnitude, poolMagnitude } from '../core/magnitude.js';
import { MASK_VOTES_STRICT, majority3x3, thresholdMask, threeFrameDifference } from '../core/mask.js';
import { HISTORY_MAX_DELTA, historyGradient, historyStep, poolDirection } from '../core/history.js';
import { maskDifference, maskDraw, renderMask } from './modes/mask.js';
import { HISTORY_CELL, HISTORY_SPREAD, renderHistory } from './modes/history.js';
import { TRAIL_HOLD, TRAIL_REFRESH, createTrailState, trailStep } from '../core/trails.js';

/**
 * Dev-only parity probe for the diff and blur shaders against core/diff.js
 * and core/blur.js. Runs Posy and Raw, with and without threshold and blur,
 * on a pair of pseudo-random frames and reports the largest per-channel
 * difference per case. Everything except the tinted case is expected to be
 * exactly 0: the shader does the same whole-number arithmetic as the core.
 *
 * Like debugEnergyParity it resizes the renderer and clears the pipeline —
 * run it on an idle page.
 *
 * @param {Pipeline} pipeline - A pipeline whose init() picked the WebGL path
 * @returns {{cases: {name: string, maxDiff: number}[], pass: boolean}|null}
 */
export function debugDiffParity(pipeline) {
  const gl = pipeline?._glRenderer;
  if (!gl) return null;

  const width = 32;
  const height = 16;
  let seed = 12345;
  const random = () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed / 4294967296;
  };
  const prev = new Uint8ClampedArray(width * height * 4);
  const next = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < prev.length; i += 4) {
    for (let c = 0; c < 3; c++) {
      prev[i + c] = Math.floor(random() * 256);
      // Mostly small differences so the threshold has pixels on both sides.
      next[i + c] = Math.min(255, Math.max(0, prev[i + c] + Math.round((random() - 0.5) * (random() < 0.3 ? 200 : 30))));
    }
    prev[i + 3] = next[i + 3] = 255;
  }

  const restoreWidth = gl.width;
  const restoreHeight = gl.height;
  const restoreFrames = gl.ringFrames;
  gl.setSize(width, height, 2);
  gl.uploadPixels(new ImageData(prev, width, height));
  gl.storeCurrent(0);
  gl.uploadPixels(new ImageData(next, width, height));

  const tint = (hex) => {
    const rgb = [1, 3, 5].map((at) => parseInt(hex.slice(at, at + 2), 16));
    const sum = rgb[0] + rgb[1] + rgb[2];
    return rgb.map((v) => v / sum);
  };

  const CASES = [
    { name: 'posy t=0', algorithm: 'posy', threshold: 0 },
    { name: 'posy t=14', algorithm: 'posy', threshold: 14 },
    { name: 'raw t=0', algorithm: 'raw', threshold: 0 },
    { name: 'raw t=14', algorithm: 'raw', threshold: 14 },
    { name: 'posy t=14 blur', algorithm: 'posy', threshold: 14, blur: true },
    { name: 'raw t=14 blur', algorithm: 'raw', threshold: 14, blur: true },
    { name: 'posy t=14 tinted', algorithm: 'posy', threshold: 14, tints: ['#ff8800', '#00ff40', '#2040ff'], tolerance: 1 },
  ];

  const cases = CASES.map(({ name, algorithm, threshold, blur = false, tints = ['#ff0000', '#00ff00', '#0000ff'], tolerance = 0 }) => {
    // Core reference, built the way the worker builds it.
    const weights = tints.map(tint);
    const old = new Uint8ClampedArray(prev.length);
    for (let i = 0; i < prev.length; i += 4) {
      for (let c = 0; c < 3; c++) {
        old[i + c] = Math.round(prev[i] * weights[c][0] + prev[i + 1] * weights[c][1] + prev[i + 2] * weights[c][2]);
      }
      old[i + 3] = 255;
    }
    const core = new Uint8ClampedArray(prev.length);
    (algorithm === 'posy' ? posyBlend : rawDiff)(next, old, core, threshold);
    if (blur) boxBlur(core, width, height);

    gl.renderDiff({
      threshold,
      algorithm,
      rgbTintR: tints[0],
      rgbTintG: tints[1],
      rgbTintB: tints[2],
      layers: [0, 0, 0],
    });
    if (blur) gl.renderBlur();
    const gpu = gl.readDiffPixels();

    let maxDiff = 0;
    for (let i = 0; i < core.length; i++) {
      if ((i & 3) === 3) continue;
      maxDiff = Math.max(maxDiff, Math.abs(core[i] - gpu[i]));
    }
    return { name, maxDiff, pass: maxDiff <= tolerance };
  });

  if (restoreWidth > 0 && restoreHeight > 0) gl.setSize(restoreWidth, restoreHeight, restoreFrames);
  pipeline.clearState();

  return { cases, pass: cases.every((c) => c.pass) };
}

/**
 * Dev-only parity probe for the trail shader against core/trails.js
 * trailStep. Runs a short sequence of pseudo-random frames through diff and
 * trail on both sides — Posy, Raw and colour-by-age — including one
 * re-rendered frame, and reports the largest per-channel difference.
 *
 * It resizes the renderer and clears the pipeline — run it on an idle page.
 *
 * @param {Pipeline} pipeline - A pipeline whose init() picked the WebGL path
 * @returns {{cases: {name: string, maxDiff: number}[], floatAges: boolean, pass: boolean}|null}
 */
export function debugTrailParity(pipeline) {
  const gl = pipeline?._glRenderer;
  if (!gl) return null;

  const width = 32;
  const height = 16;
  let seed = 4242;
  const random = () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed / 4294967296;
  };
  // Frames that change in patches, so peaks of different ages overlap.
  const frames = [];
  let last = new Uint8ClampedArray(width * height * 4).fill(120);
  for (let k = 0; k < 7; k++) {
    const frame = new Uint8ClampedArray(last);
    for (let i = 0; i < frame.length; i += 4) {
      const x = (i / 4) % width;
      if (Math.floor(x / 4) % 7 === k % 7 || random() < 0.08) {
        for (let c = 0; c < 3; c++) frame[i + c] = Math.min(255, Math.max(0, frame[i + c] + Math.round((random() - 0.5) * 160)));
      }
      frame[i + 3] = 255;
    }
    frames.push(frame);
    last = frame;
  }
  const AGE_STEPS = [0, 0.22, 0.31, 0.18, 0.4, 0.27];
  const hexToUnit = (hex) => [1, 3, 5].map((at) => parseInt(hex.slice(at, at + 2), 16) / 255);

  const restoreWidth = gl.width;
  const restoreHeight = gl.height;
  const restoreFrames = gl.ringFrames;
  gl.setSize(width, height, 2);

  const CASES = [
    { name: 'posy', algorithm: 'posy' },
    { name: 'raw', algorithm: 'raw' },
    { name: 'posy colour by age (mixed)', algorithm: 'posy', ageColor: true, style: 'mixed' },
    { name: 'posy colour by age (latest)', algorithm: 'posy', ageColor: true, style: 'latest' },
  ];
  const ageNew = '#ff4400';
  const ageOld = '#0044ff';

  const cases = CASES.map(({ name, algorithm, ageColor = false, style = 'mixed' }) => {
    const isPosy = algorithm === 'posy';
    let prev = createTrailState(width * height);
    let next = createTrailState(width * height);
    const shown = new Uint8ClampedArray(width * height * 4);
    gl.clearTrails();
    let maxDiff = 0;

    for (let k = 1; k < frames.length; k++) {
      const ageStep = AGE_STEPS[k - 1];
      const diff = new Uint8ClampedArray(width * height * 4);
      (isPosy ? posyBlend : rawDiff)(frames[k], frames[k - 1], diff, 10);

      gl.uploadPixels(new ImageData(frames[k - 1], width, height));
      gl.storeCurrent(0);
      gl.uploadPixels(new ImageData(frames[k], width, height));
      const drawDiff = () => gl.renderDiff({
        threshold: 10, algorithm, rgbTintR: '#ff0000', rgbTintG: '#00ff00', rgbTintB: '#0000ff', layers: [0, 0, 0],
      });
      const trailOpts = { isPosy, ageStep, hold: TRAIL_HOLD, refresh: TRAIL_REFRESH, ageColorEnabled: ageColor, ageColorStyle: style, ageColorNew: ageNew, ageColorOld: ageOld };
      const coreOpts = { isPosy, ageStep, hold: TRAIL_HOLD };
      if (ageColor) Object.assign(coreOpts, { ageColorNew: hexToUnit(ageNew), ageColorOld: hexToUnit(ageOld), ageColorMixed: style === 'mixed' });

      drawDiff();
      gl.renderTrail({ ...trailOpts, repeat: false });
      trailStep(prev, next, diff, shown, coreOpts);
      if (k === 3) {
        // Render frame 3 a second time, as a parameter change while paused would.
        drawDiff();
        gl.renderTrail({ ...trailOpts, repeat: true });
        trailStep(prev, next, diff, shown, coreOpts);
      }
      [prev, next] = [next, prev];

      const gpu = gl.readTrailPixels();
      for (let i = 0; i < shown.length; i++) {
        if ((i & 3) === 3) continue;
        maxDiff = Math.max(maxDiff, Math.abs(shown[i] - gpu[i]));
      }
    }
    return { name, maxDiff, pass: maxDiff <= 1 };
  });

  if (restoreWidth > 0 && restoreHeight > 0) gl.setSize(restoreWidth, restoreHeight, restoreFrames);
  pipeline.clearState();

  return { cases, floatAges: gl._trailAgesFloat, pass: cases.every((c) => c.pass) };
}

/**
 * Synthetic frame pairs for the magnitude parity probe.
 *
 * - `wedge`: only the second frame carries a brightness wedge, so every cell
 *   lands on a different magnitude and every deviation has the same sign.
 * - `signed`: a bright square moves 6 px inside one cell (a positive band
 *   where it arrives, a negative band where it left) and a checkerboard
 *   inverts (alternate pixels deviate up and down). Averaging the signed
 *   Posy values over a cell cancels both to ~0; only a per-pixel unsigned
 *   magnitude sees them.
 */
function buildParityPatterns(width, height) {
  const base = 96;
  const make = (fn) => {
    const data = new Uint8ClampedArray(width * height * 4);
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const i = (y * width + x) * 4;
        data[i] = data[i + 1] = data[i + 2] = fn(x, y);
        data[i + 3] = 255;
      }
    }
    return data;
  };
  const square = (x0) => (x, y) => {
    if (x >= 64 && y >= 32) return 0; // checkerboard region, filled below
    return x >= x0 && x < x0 + 6 && y >= 20 && y < 28 ? 216 : base;
  };
  const checker = (phase) => (x, y) => ((x + y + phase) % 2 === 0 ? 136 : 56);
  const signed = (x0, phase) => (x, y) => (x >= 64 && y >= 32 ? checker(phase)(x, y) : square(x0)(x, y));

  return {
    wedge: {
      prev: make(() => base),
      // Motion grows to the right and is strongest at the top.
      next: make((x, y) => base + Math.round((x / (width - 1)) * 120 * (1 - y / (height - 1)))),
    },
    signed: {
      prev: make(signed(34, 0)),
      next: make(signed(40, 1)),
    },
  };
}

/**
 * Dev-only parity probe for the shared motion magnitude (originally
 * SPEC-sonification A6).
 *
 * Feeds synthetic frame pairs through the CPU core math
 * (posyBlend → diffMagnitude → poolMagnitude) and through the WebGL diff,
 * magnitude and pooling programs, and returns both grids per pattern. Only
 * ever called behind `import.meta.env.DEV`, so production builds tree-shake
 * it away.
 *
 * For the signed pattern it also reports `signedMean`: what pooling the
 * signed diff first would have measured, to show the cancellation the
 * unsigned magnitude avoids.
 *
 * It resizes the renderer to the synthetic frame size and clears the pipeline
 * afterwards — run it on an idle page, not mid-playback.
 *
 * @param {Pipeline} pipeline - A pipeline whose init() picked the WebGL path
 * @param {number} [cols]
 * @param {number} [rows]
 * @returns {object|null} { cols, rows, core, webgl, maxDiff } for the wedge
 *   pattern, the same fields plus signedMean under `signed`, and `pass`
 *   (every cell of both patterns within 0.05)
 */
export function debugEnergyParity(pipeline, cols = 8, rows = 4) {
  const gl = pipeline?._glRenderer;
  if (!gl) return null;

  const width = 128;
  const height = 64;
  const patterns = buildParityPatterns(width, height);

  const restoreWidth = gl.width;
  const restoreHeight = gl.height;
  const restoreFrames = gl.ringFrames;
  gl.setSize(width, height, 2);

  const run = ({ prev, next }) => {
    const diff = new Uint8ClampedArray(width * height * 4);
    posyBlend(next, prev, diff, 0);
    const magnitude = diffMagnitude(diff, true, new Float32Array(width * height));
    const core = Array.from(poolMagnitude(magnitude, width, height, cols, rows));

    // Previous frame into ring layer 0, then the frame under test as current.
    gl.uploadPixels(new ImageData(prev, width, height));
    gl.storeCurrent(0);
    gl.uploadPixels(new ImageData(next, width, height));
    gl.renderDiff({
      threshold: 0,
      algorithm: 'posy',
      rgbTintR: '#ff0000',
      rgbTintG: '#00ff00',
      rgbTintB: '#0000ff',
      layers: [0, 0, 0],
    });
    const grid = gl.readEnergyGrid(cols, rows);
    const webgl = grid ? Array.from(grid) : [];

    // Pool the signed values first, then take the deviation (the wrong order).
    const signedValues = new Float32Array(width * height);
    for (let p = 0; p < signedValues.length; p++) signedValues[p] = diff[p * 4] / 255;
    const signedMean = Array.from(poolMagnitude(signedValues, width, height, cols, rows))
      .map((mean) => Math.abs(mean * 255 - 128) / 127);

    let maxDiff = webgl.length === core.length ? 0 : Infinity;
    for (let i = 0; i < core.length && i < webgl.length; i++) {
      maxDiff = Math.max(maxDiff, Math.abs(core[i] - webgl[i]));
    }
    return { core, webgl, signedMean, maxDiff };
  };

  const wedge = run(patterns.wedge);
  const signed = run(patterns.signed);

  if (restoreWidth > 0 && restoreHeight > 0) gl.setSize(restoreWidth, restoreHeight, restoreFrames);
  pipeline.clearState();

  return {
    cols,
    rows,
    core: wedge.core,
    webgl: wedge.webgl,
    maxDiff: wedge.maxDiff,
    signed,
    pass: wedge.maxDiff < 0.05 && signed.maxDiff < 0.05,
  };
}

/**
 * Dev-only parity probe for the motion mask shaders (app/modes/mask.js)
 * against core/mask.js and core/blur.js: three pseudo-random frames, with
 * and without the pre-blur and the clean-up vote. The mask and the cut-out
 * picture are expected to match exactly; the strength is stored at the data
 * target's precision.
 *
 * It resizes the renderer and clears the pipeline — run it on an idle page.
 *
 * @param {Pipeline} pipeline - A pipeline whose init() picked the WebGL path
 * @returns {{cases: {name: string, maskMismatches: number, pictureDiff: number, strengthDiff: number, moving: number}[], pass: boolean}|null}
 */
export function debugMaskParity(pipeline) {
  const gl = pipeline?._glRenderer;
  if (!gl) return null;

  const width = 32;
  const height = 16;
  let seed = 777;
  const random = () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed / 4294967296;
  };
  // Smooth-ish frames with patches of change, so the blur and the vote have
  // structure to act on and the threshold has pixels on both sides.
  const base = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < base.length; i += 4) {
    const x = (i / 4) % width;
    const y = Math.floor(i / 4 / width);
    for (let c = 0; c < 3; c++) base[i + c] = 60 + ((x * 5 + y * 9 + c * 30) % 120);
    base[i + 3] = 255;
  }
  const vary = (from, patchAt) => {
    const frame = new Uint8ClampedArray(from);
    for (let i = 0; i < frame.length; i += 4) {
      const x = (i / 4) % width;
      const y = Math.floor(i / 4 / width);
      const inPatch = x >= patchAt && x < patchAt + 7 && y >= 3 && y < 12;
      for (let c = 0; c < 3; c++) {
        const change = inPatch ? 90 : Math.round((random() - 0.5) * (random() < 0.15 ? 120 : 24));
        frame[i + c] = Math.min(255, Math.max(0, frame[i + c] + change));
      }
    }
    return frame;
  };
  const old2 = vary(base, 2);
  const old1 = vary(base, 9);
  const cur = vary(base, 16);

  const restoreWidth = gl.width;
  const restoreHeight = gl.height;
  const restoreFrames = gl.ringFrames;
  gl.setSize(width, height, 3);
  gl.uploadPixels(new ImageData(old2, width, height));
  gl.storeCurrent(0);
  gl.uploadPixels(new ImageData(old1, width, height));
  gl.storeCurrent(1);
  gl.uploadPixels(new ImageData(cur, width, height));

  const THRESHOLD = 12;
  const CASES = [
    { name: 'plain', blur: false, clean: false },
    { name: 'blur', blur: true, clean: false },
    { name: 'clean', blur: false, clean: true },
    { name: 'blur + clean', blur: true, clean: true },
  ];

  const cases = CASES.map(({ name, blur, clean }) => {
    const blurred = [cur, old1, old2].map((frame) => {
      if (!blur) return frame;
      const copy = new Uint8ClampedArray(frame);
      boxBlur(copy, width, height);
      return copy;
    });
    const difference = threeFrameDifference(blurred[0], blurred[1], blurred[2], new Uint16Array(width * height));
    let mask = thresholdMask(difference, THRESHOLD, new Uint8Array(width * height));
    if (clean) mask = majority3x3(mask, width, height, new Uint8Array(width * height));

    renderMask(gl, { layers: [1, 0], threshold: THRESHOLD, blur, clean, show: 'cutout' });
    const picture = gl.readDiffPixels();
    const data = gl.readDataField();

    let maskMismatches = 0;
    let pictureDiff = 0;
    let strengthDiff = 0;
    let moving = 0;
    for (let p = 0; p < mask.length; p++) {
      moving += mask[p];
      if (Math.round(data.values[p * 4]) !== mask[p]) maskMismatches++;
      strengthDiff = Math.max(strengthDiff, Math.abs(data.values[p * 4 + 1] - difference[p] / 765) * 255);
      for (let c = 0; c < 3; c++) pictureDiff = Math.max(pictureDiff, Math.abs(picture[p * 4 + c] - cur[p * 4 + c] * mask[p]));
    }
    return {
      name, maskMismatches, pictureDiff, strengthDiff: +strengthDiff.toFixed(2), moving,
      pass: maskMismatches === 0 && pictureDiff === 0 && strengthDiff <= 2,
    };
  });

  if (restoreWidth > 0 && restoreHeight > 0) gl.setSize(restoreWidth, restoreHeight, restoreFrames);
  pipeline.clearState();

  return { cases, pass: cases.every((c) => c.pass) };
}

/**
 * Dev-only parity probe for the motion history shaders (app/modes/history.js)
 * against core/history.js: a block moving across a textured frame for several
 * steps, one of them rendered twice, through mask → age → slope → pooled
 * direction on both sides. Compares the data output: how recent (R) and the
 * pooled heading (G, B).
 *
 * It resizes the renderer and clears the pipeline — run it on an idle page.
 *
 * @param {Pipeline} pipeline - A pipeline whose init() picked the WebGL path
 * @returns {{recencyDiff: number, directionDiff: number, live: number, withDirection: number, pass: boolean}|null}
 */
export function debugHistoryParity(pipeline) {
  const gl = pipeline?._glRenderer;
  if (!gl) return null;
  if (!gl.floatTargets) return { skipped: 'no float render targets', pass: true };

  const width = 64;
  const height = 40;
  const THRESHOLD = 12;
  // Steps that half floats hold exactly, so both sides age identically.
  const AGE_STEP = 1 / 16;
  const frameAt = (k) => {
    const frame = new Uint8ClampedArray(width * height * 4);
    for (let i = 0; i < frame.length; i += 4) {
      const x = (i / 4) % width;
      const y = Math.floor(i / 4 / width);
      // A textured block heading down-right, 3 px across and 1 px down per frame.
      const inBlock = x >= 4 + k * 3 && x < 16 + k * 3 && y >= 6 + k && y < 20 + k;
      for (let c = 0; c < 3; c++) frame[i + c] = inBlock ? 150 + ((x * 7 + y * 13 + c * 40) % 100) : 40 + ((x + y * 3 + c * 9) % 24);
      frame[i + 3] = 255;
    }
    return frame;
  };
  const frames = Array.from({ length: 11 }, (_, k) => frameAt(k));

  const restoreWidth = gl.width;
  const restoreHeight = gl.height;
  const restoreFrames = gl.ringFrames;
  gl.setSize(width, height, 3);
  gl.clearTrails();
  const maskTarget = gl.target('history:mask', width, height);

  let age = new Float32Array(width * height).fill(1);
  const cols = Math.ceil(width / HISTORY_CELL);
  const rows = Math.ceil(height / HISTORY_CELL);
  let data = null;
  for (let k = 2; k < frames.length; k++) {
    const blurred = [frames[k], frames[k - 1], frames[k - 2]].map((frame) => {
      const copy = new Uint8ClampedArray(frame);
      boxBlur(copy, width, height);
      return copy;
    });
    const difference = threeFrameDifference(blurred[0], blurred[1], blurred[2], new Uint16Array(width * height));
    const mask = majority3x3(thresholdMask(difference, THRESHOLD, new Uint8Array(width * height)), width, height, new Uint8Array(width * height), MASK_VOTES_STRICT);
    age = historyStep(age, mask, AGE_STEP, new Float32Array(width * height));

    gl.uploadPixels(new ImageData(frames[k - 2], width, height));
    gl.storeCurrent(0);
    gl.uploadPixels(new ImageData(frames[k - 1], width, height));
    gl.storeCurrent(1);
    gl.uploadPixels(new ImageData(frames[k], width, height));
    const draw = (repeat) => {
      const raw = maskDifference(gl, { layers: [1, 0], threshold: THRESHOLD, blur: true });
      maskDraw(gl, raw.tex, maskTarget.fb, { clean: MASK_VOTES_STRICT, output: 'data' });
      renderHistory(gl, { mask: maskTarget.tex, ageStep: AGE_STEP, repeat, view: 'direction' });
    };
    draw(false);
    if (k === 5) draw(true); // a parameter change while paused must not age it twice
    data = gl.readDataField();
  }

  const gradient = historyGradient(age, width, height, HISTORY_MAX_DELTA, new Float32Array(width * height * 3));
  const pooled = poolDirection(gradient, width, height, HISTORY_CELL, HISTORY_SPREAD, new Float32Array(cols * rows * 3));

  let recencyDiff = 0;
  let directionDiff = 0;
  let live = 0;
  let withDirection = 0;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const p = y * width + x;
      const isLive = age[p] < 1;
      const cell = (Math.floor(y / HISTORY_CELL) * cols + Math.floor(x / HISTORY_CELL)) * 3;
      const expected = [isLive ? 1 - age[p] : 0, isLive ? pooled[cell] : 0, isLive ? pooled[cell + 1] : 0];
      if (isLive) live++;
      if (isLive && Math.hypot(pooled[cell], pooled[cell + 1]) > 0.2) withDirection++;
      recencyDiff = Math.max(recencyDiff, Math.abs(data.values[p * 4] - expected[0]));
      directionDiff = Math.max(directionDiff, Math.abs(data.values[p * 4 + 1] - expected[1]), Math.abs(data.values[p * 4 + 2] - expected[2]));
    }
  }

  if (restoreWidth > 0 && restoreHeight > 0) gl.setSize(restoreWidth, restoreHeight, restoreFrames);
  pipeline.clearState();

  return {
    recencyDiff: +recencyDiff.toFixed(4),
    directionDiff: +directionDiff.toFixed(4),
    live,
    withDirection,
    // The probe proves nothing unless there is a trail with headings in it.
    pass: recencyDiff <= 0.002 && directionDiff <= 0.02 && live > 200 && withDirection > 100,
  };
}
