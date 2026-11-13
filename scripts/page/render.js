// Runs inside the page (injected by scripts/filmstrip.mjs). Renders one
// filmstrip: steps the video frame by frame through the real pipeline and
// captures the output at fixed media times. Stepping, not playing, so the
// result does not depend on how fast this machine is.
//
// `args`: { clipUrl, clipName, fps, at, frames, every, warmup, params,
//           display, width, cell, columns }
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// Builds before the dev API existed (old UI) are driven through their DOM,
// so history can still be rendered as a "before".
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
    async pause() { if (!video.paused) { document.getElementById('btnPlayPause').click(); await wait(150); } },
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

if (md.__clip !== args.clipName) {
  const blob = await (await fetch(args.clipUrl)).blob();
  await md.load(blob, args.clipName);
  md.__clip = args.clipName;
}
await md.pause();
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

function seekAndDraw(time, onDrawn) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => { window.__stripFrame = null; resolve(false); }, 3000);
    window.__stripFrame = () => {
      window.__stripFrame = null;
      clearTimeout(timer);
      onDrawn?.();
      resolve(true);
    };
    // Current builds step exactly (Session.stepTo); older ones are left to
    // process the frame from their own seeked handler.
    if (md.stepTo) md.stepTo(time);
    else video.currentTime = time;
  });
}

const dt = 1 / args.fps;
const every = Math.max(1, args.every || 1);
const count = Math.max(1, args.frames || 6);
const warmFrames = Math.max(1, Math.round((args.warmup ?? 1.5) / dt));
const firstIndex = Math.max(0, Math.round(args.at / dt) - warmFrames);
const captureFrom = Math.round(args.at / dt);

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
let missed = 0;
let captured = 0;
for (let index = firstIndex; captured < count; index++) {
  const isCapture = index >= captureFrom && (index - captureFrom) % every === 0;
  const cell = captured;
  // Aim at the middle of the frame so the seek cannot straddle two.
  const ok = await seekAndDraw((index + 0.5) * dt, isCapture ? () => {
    const x = (cell % columns) * cellW;
    const y = Math.floor(cell / columns) * cellH;
    sx.drawImage(canvas, x, y, cellW, cellH);
    ox.drawImage(video, x, y, cellW, cellH);
    times.push(+pipeline._lastTime.toFixed(4));
  } : null);
  if (!ok) missed++;
  if (isCapture) captured++;
  if (index - firstIndex > 4000) break;
}

return {
  strip: strip.toDataURL('image/png'),
  original: original.toDataURL('image/jpeg', 0.9),
  meta: { cellW, cellH, columns, rows, count, times, missed, renderer: pipeline._useWebGL ? 'webgl' : 'canvas2d', output: [canvas.width, canvas.height] },
  logs: (window.__logs || []).filter((l) => /error|UNCAUGHT|REJECTION/i.test(l)).slice(-5),
};
