// Runs inside the app page (injected by scripts/filmstrip.mjs after scene.js).
// Renders one filmstrip: frames at fixed moments, each pushed through the real
// pipeline one at a time, so the result does not depend on how fast this
// machine is.
//
// Two kinds of source:
//   - a video file: stepped by seeking (Session.stepTo)
//   - a synthetic scene (args.synthetic): each frame is drawn here, sent
//     through a canvas capture stream, and processed with its exact
//     timestamp. Browser-recorded clips cannot be seeked frame-accurately.
//
// `args`: { clipUrl, clipName, synthetic, fps, at, frames, every, warmup,
//           params, display, width, cell, columns,
//           switch: { at, params }   settings applied from that moment on
//           readTarget               name of a mode's render target to save }
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// Builds before the dev API existed (old UI) are driven through their DOM,
// so history can still be rendered as a "before". Files only.
function legacyAdapter() {
  const pipeline = window.__motionDiffPipeline;
  if (!pipeline) throw new Error('No dev API on this page (window.__motionDiff). Is it a dev build?');
  const video = document.getElementById('videoEl');
  const slider = (id, v) => { const s = document.getElementById(id); if (s) { s.value = v; s.dispatchEvent(new Event('input', { bubbles: true })); } };
  const check = (id, on) => { const c = document.getElementById(id); if (c && c.checked !== Boolean(on)) c.click(); };
  return {
    pipeline, video, canvas: document.getElementById('outputCanvas'),
    async load(blob, name) {
      const dt = new DataTransfer(); dt.items.add(new File([blob], name, { type: blob.type || 'video/mp4' }));
      const input = document.getElementById('fileInput'); input.files = dt.files;
      input.dispatchEvent(new Event('change', { bubbles: true }));
      for (let i = 0; i < 80 && !(video.videoWidth > 0 && video.readyState >= 2); i++) await wait(100);
    },
    async pause() {
      if (!video.paused) { document.getElementById('btnPlayPause').click(); await wait(150); }
      // Those builds trusted the frame callback after a paused seek, and it
      // can deliver a stale frame's time. Without it they fall back to their
      // 250 ms timer and currentTime, which is slow but exact.
      video.requestVideoFrameCallback = () => 0;
    },
    setWidth(w) { const s = document.getElementById('selectResolution'); s.value = String(w); s.dispatchEvent(new Event('change', { bubbles: true })); },
    setDisplay(mode) { document.querySelector(`#btnDisplay [data-mode="${mode}"]`)?.click(); },
    setParams(p) {
      if (p.algorithm) document.querySelector(`#btnAlgo [data-algorithm="${p.algorithm}"]`)?.click();
      if (p.frameOffset !== undefined) slider('sliderOffset', p.frameOffset);
      if (p.threshold !== undefined) slider('sliderThreshold', p.threshold);
      if (p.trailLength !== undefined) slider('sliderTrail', p.trailLength);
      if (p.channelSpread !== undefined) slider('sliderSpread', p.channelSpread);
      if (p.blurEnabled !== undefined) check('btnBlur', p.blurEnabled);
      if (p.ageColorEnabled !== undefined) check('btnAgeColor', p.ageColorEnabled);
    },
  };
}

const md = window.__motionDiff || (window.__motionDiffLegacy ||= legacyAdapter());
const { pipeline, video, canvas } = md;

// ── Source ──────────────────────────────────────────────────────
let scene = null;
if (args.synthetic) {
  if (!md.session?.loadStream) throw new Error('Synthetic scenes need a build with Session.loadStream');
  if (md.__clip !== args.clipName) {
    const made = makeScene(args.synthetic);
    const source = Object.assign(document.createElement('canvas'), { width: made.width, height: made.height });
    const ctx = source.getContext('2d', { willReadFrequently: true });
    const stream = source.captureStream(0);
    const track = stream.getVideoTracks()[0];
    made.draw(ctx, 0);
    // The stream has no frames until one is requested; keep offering one
    // while the app attaches to it.
    const nudge = setInterval(() => track.requestFrame(), 60);
    await md.session.loadStream(stream, args.clipName);
    clearInterval(nudge);
    md.__scene = { made, source, ctx, track };
    md.__clip = args.clipName;
  }
  scene = md.__scene;
  md.session.setManual(true);
} else {
  if (md.__clip !== args.clipName) {
    const blob = await (await fetch(args.clipUrl)).blob();
    await md.load(blob, args.clipName);
    md.__clip = args.clipName;
  }
  md.session?.setManual?.(false);
  await md.pause();
}
if (args.width) { md.setWidth(args.width); await wait(200); }
md.setDisplay(args.display || 'diff');
md.setParams(args.params || {});
await wait(100);

// Call back in the same task the frame was drawn in: the WebGL drawing buffer
// is not preserved, so a later read would see a cleared canvas.
if (!pipeline.__stripHook) {
  pipeline.__stripHook = true;
  if (pipeline._useWebGL) {
    const process = pipeline.process.bind(pipeline);
    pipeline.process = (...a) => { process(...a); window.__stripFrame?.(); };
  } else {
    let inner = pipeline.onResult;
    Object.defineProperty(pipeline, 'onResult', {
      configurable: true,
      get: () => (r) => { inner?.(r); window.__stripFrame?.(); },
      set: (fn) => { inner = fn; },
    });
  }
}

const fps = scene ? scene.made.fps : args.fps;
const dt = 1 / fps;

/** Put frame `index` through the pipeline; `onDrawn` runs as it is drawn. */
function stepFrame(index, onDrawn) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => { window.__stripFrame = null; resolve(false); }, 3000);
    const arm = () => {
      window.__stripFrame = () => {
        window.__stripFrame = null;
        clearTimeout(timer);
        onDrawn?.();
        resolve(true);
      };
    };
    if (scene) {
      scene.made.draw(scene.ctx, index);
      scene.track.requestFrame();
      // Wait for the video element to show that frame, then process it with
      // its exact time.
      let shown = false;
      const go = () => { if (shown) return; shown = true; arm(); md.session.processFrame({ mediaTime: index * dt }); };
      video.requestVideoFrameCallback(go);
      setTimeout(go, 150);
    } else {
      arm();
      // Aim at the middle of the frame so the seek cannot straddle two.
      // Current builds step exactly (Session.stepTo); older ones are left to
      // process the frame from their own seeked handler.
      const time = (index + 0.5) * dt;
      if (md.stepTo) md.stepTo(time);
      else video.currentTime = time;
    }
  });
}

const every = Math.max(1, args.every || 1);
const count = Math.max(1, args.frames || 6);
const warmFrames = Math.max(1, Math.round((args.warmup ?? 1.5) / dt));
const captureFrom = Math.round(args.at / dt);
const firstIndex = Math.max(0, captureFrom - warmFrames);

const columns = Math.min(count, args.columns || 3);
const rows = Math.ceil(count / columns);
const cellW = args.cell || 480;
const cellH = Math.round(cellW * (canvas.height / canvas.width)) || Math.round(cellW * 9 / 16);
const strip = Object.assign(document.createElement('canvas'), { width: cellW * columns, height: cellH * rows });
const original = Object.assign(document.createElement('canvas'), { width: cellW * columns, height: cellH * rows });
const sx = strip.getContext('2d');
const ox = original.getContext('2d');

pipeline.clearState();
const times = [];
const truth = [];
let missed = 0;
let captured = 0;
let switched = false;
for (let index = firstIndex; captured < count; index++) {
  if (args.switch && !switched && index * dt >= args.switch.at) { md.setParams(args.switch.params); switched = true; }
  const isCapture = index >= captureFrom && (index - captureFrom) % every === 0;
  const cell = captured;
  const ok = await stepFrame(index, isCapture ? () => {
    const x = (cell % columns) * cellW;
    const y = Math.floor(cell / columns) * cellH;
    sx.drawImage(canvas, x, y, cellW, cellH);
    ox.drawImage(scene ? scene.source : video, x, y, cellW, cellH);
    times.push(+pipeline._lastTime.toFixed(4));
    if (scene) truth.push(scene.made.truth(index));
  } : null);
  if (!ok) missed++;
  if (isCapture) captured++;
  if (index - firstIndex > 4000) break;
}

// For checks against ground truth: the mode's data output for the last frame.
let data = null;
if (args.readData && pipeline.readData) {
  const field = pipeline.readData();
  if (field) data = { kind: field.kind, width: field.width, height: field.height, values: Array.from(field.values, (v) => +v.toFixed(4)) };
}

// A mode's own float target (for example a velocity field), row 0 at the top.
let target = null;
if (args.readTarget && pipeline._glRenderer) {
  const found = pipeline._glRenderer._modeTargets.get(args.readTarget);
  if (found) {
    const gl = pipeline._glRenderer.gl;
    const raw = new Float32Array(found.width * found.height * 4);
    gl.bindFramebuffer(gl.FRAMEBUFFER, found.fb);
    gl.readPixels(0, 0, found.width, found.height, gl.RGBA, gl.FLOAT, raw);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    const values = [];
    for (let y = found.height - 1; y >= 0; y--) for (let i = 0; i < found.width * 4; i++) values.push(+raw[y * found.width * 4 + i].toFixed(4));
    target = { name: args.readTarget, width: found.width, height: found.height, values };
  }
}

return {
  target,
  strip: strip.toDataURL('image/png'),
  original: original.toDataURL('image/jpeg', 0.9),
  meta: { cellW, cellH, columns, rows, count, times, missed, truth: truth.length ? truth : undefined, renderer: pipeline._useWebGL ? 'webgl' : 'canvas2d', output: [canvas.width, canvas.height] },
  data,
  logs: (window.__logs || []).filter((l) => /error|UNCAUGHT|REJECTION/i.test(l)).slice(-5),
};
