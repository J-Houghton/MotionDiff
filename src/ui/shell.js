/**
 * The interface shell, in plain DOM: stage with split compare, mode caption,
 * time ruler, transport, source picker, help sheet, status line.
 *
 * Two layouts share one DOM and differ only in CSS (styles/main.css):
 *   plate       the default: the frame printed on a page with a caption strip
 *   viewfinder  full-bleed frame with overlays that hide when idle; used in
 *               fullscreen and always on phones
 *
 * State lives in the Session; this module calls its methods and redraws when
 * it reports a change.
 */
import { MODES } from '../app/modes/index.js';
import { TEST_CLIPS } from '../app/clips.js';
import { initPanel } from './panel.js';
import { initRuler } from './ruler.js';
import { initKeys, SHORTCUTS } from './keys.js';

const RATES = [0.25, 0.5, 1, 1.5, 2];
const DISPLAYS = ['diff', 'overlay', 'glow', 'data'];
const IDLE_MS = 2500;
// Narrow screens and anything driven by touch get the viewfinder: its controls
// are sized for fingers and the picture fills the screen.
const PHONE_QUERY = '(max-width: 720px), (pointer: coarse)';

const TEMPLATE = `
<header class="mast chrome">
  <strong class="brand">MotionDiff</strong>
  <span class="mast-info" id="sourceInfo"></span>
  <span class="status" id="status" role="status" aria-live="polite"></span>
  <nav class="mast-actions" aria-label="Application">
    <button type="button" id="btnSource"><kbd>N</kbd><span>Source</span></button>
    <button type="button" id="btnPanel" aria-expanded="true"><kbd>P</kbd><span>Parameters</span></button>
    <button type="button" id="btnFull"><kbd>F</kbd><span>Fullscreen</span></button>
    <button type="button" id="btnTheme"><kbd>T</kbd><span id="themeLabel">Dark</span></button>
    <button type="button" id="btnKeys"><kbd>?</kbd><span>Keys</span></button>
  </nav>
</header>

<main class="plate">
  <div class="frame" id="stage">
    <video id="videoEl" playsinline muted></video>
    <canvas id="outputCanvas" aria-label="Motion output"></canvas>
    <span class="tag tag-l chrome" id="tagOriginal" hidden>ORIGINAL</span>
    <span class="tag tag-r chrome" id="tagMode" hidden></span>
    <div class="split" id="split" role="slider" tabindex="0" aria-label="Split between original and output" aria-valuemin="0" aria-valuemax="100" hidden></div>

    <i class="bracket tl chrome"></i><i class="bracket tr chrome"></i><i class="bracket bl chrome"></i><i class="bracket br chrome"></i>
    <div class="vf vf-mode chrome">
      <span class="vf-num" id="vfNum"></span>
      <div class="vf-name">
        <button type="button" class="vf-step" id="vfPrev" aria-label="Previous mode">◂</button>
        <b id="vfName"></b>
        <button type="button" class="vf-step" id="vfNext" aria-label="Next mode">▸</button>
      </div>
    </div>
    <div class="vf vf-meta chrome" id="vfMeta"></div>
    <div class="vf vf-readout chrome" id="vfReadout" aria-hidden="true"></div>
    <button type="button" class="vf vf-exit chrome" id="vfExit" aria-label="Leave fullscreen">✕</button>

    <div class="empty" id="empty">
      <h2>See what moves.</h2>
      <p>MotionDiff compares each frame of a video with an earlier one and shows only the change.</p>
      <div class="sources" id="emptySources"></div>
      <p class="empty-hint">or drop a video file anywhere</p>
    </div>
  </div>
  <aside class="panel chrome" id="panel" aria-label="Parameters">
    <button type="button" class="panel-done phone-only" id="panelDone">Done</button>
    <div id="paneHost"></div>
  </aside>
</main>

<footer class="cap chrome">
  <div class="cap-mode">
    <h1><span id="modeName"></span><small id="modeIndex"></small></h1>
    <p id="modeBlurb"></p>
  </div>
  <div class="ruler" id="ruler" aria-label="Where each channel looks back to, and how long trails last"></div>
  <div class="play" role="group" aria-label="Transport">
    <button type="button" id="btnBack" aria-label="Step back one frame">◂</button>
    <button type="button" id="btnPlay" class="go" aria-label="Play">▶</button>
    <button type="button" id="btnForward" aria-label="Step forward one frame">▸</button>
    <span class="clock"><time id="timeNow">0:00.00</time><span id="timeTotal"></span></span>
    <button type="button" id="btnRate" aria-label="Playback speed">1×</button>
    <button type="button" id="btnFlip" aria-label="Flip camera" hidden>⟲ Flip</button>
    <button type="button" id="btnRec" aria-pressed="false">● Rec</button>
    <button type="button" id="btnParams" class="phone-only">Params</button>
    <button type="button" id="btnSource2" class="phone-only">Source</button>
  </div>
  <input class="scrub" id="scrub" type="range" min="0" max="1000" step="1" value="0" aria-label="Seek" disabled>
</footer>

<div class="sheet" id="sourceSheet" role="dialog" aria-modal="true" aria-labelledby="sourceTitle" hidden>
  <div class="sheet-body">
    <h2 id="sourceTitle">Choose a source</h2>
    <div class="sources" id="sheetSources"></div>
    <button type="button" class="sheet-close" data-close>Close <kbd>Esc</kbd></button>
  </div>
</div>

<div class="sheet" id="keysSheet" role="dialog" aria-modal="true" aria-labelledby="keysTitle" hidden>
  <div class="sheet-body sheet-wide">
    <h2 id="keysTitle">Keys</h2>
    <dl class="keys" id="keysList"></dl>
    <h2 id="helpTitle"></h2>
    <p id="helpBlurb"></p>
    <ul class="help" id="helpList"></ul>
    <p class="help-data" id="helpData"></p>
    <button type="button" class="sheet-close" data-close>Close <kbd>Esc</kbd></button>
  </div>
</div>
`;

/** Build the DOM. Call before creating the Session: it needs these elements. */
export function buildShell(root) {
  root.innerHTML = TEMPLATE;
  return { video: root.querySelector('#videoEl'), canvas: root.querySelector('#outputCanvas') };
}

function formatTime(seconds, withFraction = true) {
  const s = Math.max(0, seconds || 0);
  const whole = Math.floor(s);
  const text = `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, '0')}`;
  return withFraction ? `${text}.${String(Math.floor((s - whole) * 100)).padStart(2, '0')}` : text;
}

/**
 * @param {object} options
 * @param {HTMLElement} options.root
 * @param {import('../app/session.js').Session} options.session
 */
export function initShell({ root, session }) {
  const $ = (id) => root.querySelector(`#${id}`);
  const stage = $('stage');
  const canvas = $('outputCanvas');
  const split = $('split');
  const scrub = $('scrub');
  const phone = window.matchMedia(PHONE_QUERY);

  const view = {
    split: false,
    splitAt: 0.5,
    original: false,
    immersive: false,   // fullscreen viewfinder on a desktop
    hidden: false,      // H: picture only
    panel: !phone.matches,
    scrubbing: false,
  };

  // ── Layout, theme, idle ─────────────────────────────────────
  function applyLayout() {
    const viewfinder = phone.matches || view.immersive;
    root.dataset.layout = viewfinder ? 'viewfinder' : 'plate';
    root.dataset.phone = String(phone.matches);
    root.dataset.panel = view.panel ? 'open' : 'closed';
    root.dataset.hidden = String(view.hidden);
    root.dataset.source = session.loaded ? 'ready' : 'empty';
    measureChrome();
    $('btnPanel').setAttribute('aria-expanded', String(view.panel));
    $('panel').inert = !view.panel;
  }

  // The frame takes whatever height the mast and caption leave (see .frame
  // in main.css), so tell the stylesheet how tall they are.
  function measureChrome() {
    const chrome = view.hidden ? 0 : root.querySelector('.mast').offsetHeight + root.querySelector('.cap').offsetHeight + 52;
    root.style.setProperty('--chrome-h', `${chrome}px`);
  }
  new ResizeObserver(measureChrome).observe(root.querySelector('.cap'));
  window.addEventListener('resize', measureChrome);

  function setTheme(theme) {
    document.documentElement.dataset.theme = theme;
    $('themeLabel').textContent = theme === 'dark' ? 'Light' : 'Dark';
    $('btnTheme').setAttribute('aria-label', `Switch to the ${theme === 'dark' ? 'light' : 'dark'} theme`);
    try { localStorage.setItem('motiondiff-theme', theme); } catch { /* session only */ }
  }

  let idleTimer = 0;
  function wake() {
    root.dataset.idle = 'false';
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      // Overlays only get out of the way of a moving picture, and never
      // while a dialog or the panel is being used.
      const busy = !session.playing || !$('sourceSheet').hidden || !$('keysSheet').hidden
        || $('panel').contains(document.activeElement);
      if (!busy) root.dataset.idle = 'true';
    }, IDLE_MS);
  }
  for (const type of ['pointermove', 'pointerdown', 'keydown', 'touchstart', 'focusin']) {
    window.addEventListener(type, wake, { passive: true });
  }

  // ── Stage: split compare and hold-original ──────────────────
  function applySplit() {
    const { mode } = session;
    const on = view.split && session.loaded;
    split.hidden = !on;
    $('tagOriginal').hidden = $('tagMode').hidden = !on;
    // The video lies over the canvas, transparent (see .frame video in
    // main.css). Showing the original is making it opaque, clipped to the
    // left of the split or not at all.
    const video = session.video;
    video.style.opacity = on || view.original ? '1' : '';
    video.style.clipPath = on && !view.original ? `inset(0 ${(1 - view.splitAt) * 100}% 0 0)` : '';
    split.style.left = `${view.splitAt * 100}%`;
    split.setAttribute('aria-valuenow', String(Math.round(view.splitAt * 100)));
    $('tagMode').textContent = `${mode.label}${mode.composite ? ` · ${session.display}` : ''}`.toUpperCase();
  }
  const moveSplit = (clientX) => {
    const rect = stage.getBoundingClientRect();
    view.splitAt = Math.min(0.97, Math.max(0.03, (clientX - rect.left) / rect.width));
    applySplit();
  };
  split.addEventListener('pointerdown', (event) => { split.setPointerCapture(event.pointerId); event.preventDefault(); split.focus(); });
  split.addEventListener('pointermove', (event) => { if (split.hasPointerCapture(event.pointerId)) moveSplit(event.clientX); });
  split.addEventListener('keydown', (event) => {
    const step = event.key === 'ArrowLeft' ? -0.02 : event.key === 'ArrowRight' ? 0.02 : 0;
    if (!step) return;
    event.preventDefault();
    view.splitAt = Math.min(0.97, Math.max(0.03, view.splitAt + step));
    applySplit();
  });

  // ── Mode caption ────────────────────────────────────────────
  function applyMode() {
    const { mode, params } = session;
    const index = MODES.indexOf(mode);
    $('modeName').textContent = mode.label;
    $('modeIndex').textContent = `${index + 1} of ${MODES.length}`;
    $('modeBlurb').textContent = session.modeProblem() || mode.blurb;
    $('vfNum').textContent = `MODE ${index + 1} / ${MODES.length}`;
    $('vfName').textContent = mode.label;
    $('vfReadout').replaceChildren(...mode.params
      .filter((p) => p.type === 'range' && (!p.when || p.when(params)))
      .slice(0, 4)
      .map((p) => {
        const cell = document.createElement('div');
        const value = document.createElement('b');
        value.textContent = p.format ? p.format(params[p.key]) : String(params[p.key]);
        cell.append(p.label.toUpperCase(), value);
        return cell;
      }));
    $('helpTitle').textContent = mode.label;
    $('helpBlurb').textContent = mode.blurb;
    $('helpList').replaceChildren(...mode.help.map((line) => Object.assign(document.createElement('li'), { textContent: line })));
    $('helpData').textContent = `As data: ${mode.data.kind} field, ${mode.data.what}.`;
    applySplit();
  }

  // ── Source info, transport ──────────────────────────────────
  function applySource() {
    const { source, pipeline } = session;
    if (pipeline.width && pipeline.height) {
      stage.style.setProperty('--aspect', `${pipeline.width} / ${pipeline.height}`);
      stage.style.setProperty('--ar', String(pipeline.width / pipeline.height));
    }
    const size = session.loaded ? `${session.video.videoWidth} × ${session.video.videoHeight} at ${pipeline.width}` : '';
    const rate = session.loaded ? `${session.fps.toFixed(session.fps % 1 > 0.05 ? 2 : 0)} fps` : '';
    $('sourceInfo').textContent = source ? [source.label, size, rate].filter(Boolean).join(' · ') : 'No source';
    $('vfMeta').replaceChildren(...[size, `${rate} · ${session.webgl ? 'WebGL2' : 'Canvas 2D'}`, source ? `● ${source.label}` : '']
      .filter(Boolean).map((line) => Object.assign(document.createElement('div'), { textContent: line })));
    $('btnFlip').hidden = source?.kind !== 'camera';
    scrub.disabled = !session.loaded || session.isLive;
    $('timeTotal').textContent = !session.loaded ? '' : session.isLive ? ' · live' : ` / ${formatTime(session.duration, false)}`;
    for (const id of ['btnBack', 'btnForward']) $(id).disabled = !session.loaded || session.isLive;
    $('btnPlay').disabled = $('btnRec').disabled = !session.loaded;
    applyLayout();
    applySplit();
  }

  function applyPlay() {
    $('btnPlay').textContent = session.playing ? '❚❚' : '▶';
    $('btnPlay').setAttribute('aria-label', session.playing ? 'Pause' : 'Play');
    $('btnRate').textContent = `${session.rate}×`;
    $('btnRec').textContent = session.recording ? '■ Stop' : '● Rec';
    $('btnRec').setAttribute('aria-pressed', String(session.recording));
    root.dataset.recording = String(session.recording);
    wake();
  }

  function applyTime() {
    $('timeNow').textContent = formatTime(session.currentTime);
    if (!view.scrubbing && session.duration > 0) {
      scrub.value = String(Math.round((session.currentTime / session.duration) * 1000));
      scrub.style.setProperty('--at', `${(session.currentTime / session.duration) * 100}%`);
      scrub.setAttribute('aria-valuetext', `${formatTime(session.currentTime)} of ${formatTime(session.duration, false)}`);
    }
  }
  (function clock() { if (session.loaded) applyTime(); requestAnimationFrame(clock); })();

  scrub.addEventListener('input', () => {
    view.scrubbing = true;
    session.seek((Number(scrub.value) / 1000) * session.duration);
    scrub.style.setProperty('--at', `${Number(scrub.value) / 10}%`);
  });
  scrub.addEventListener('change', () => { view.scrubbing = false; });

  function showStatus() {
    const { message, type } = session.status;
    const node = $('status');
    node.textContent = message;
    node.dataset.type = type;
    node.dataset.fresh = 'true';
    clearTimeout(showStatus.timer);
    showStatus.timer = setTimeout(() => { node.dataset.fresh = 'false'; }, 4000);
  }

  // ── Sources ─────────────────────────────────────────────────
  const fileInput = Object.assign(document.createElement('input'), { type: 'file', accept: 'video/*', hidden: true });
  root.append(fileInput);
  fileInput.addEventListener('change', () => {
    const file = fileInput.files?.[0];
    if (file) { closeSheets(); session.loadFile(file); }
    fileInput.value = '';
  });

  function buildSources(container) {
    const button = (label, onClick, className = '') => {
      const node = Object.assign(document.createElement('button'), { type: 'button', textContent: label, className });
      node.addEventListener('click', onClick);
      return node;
    };
    const run = (fn) => () => { closeSheets(); fn(); };
    const primary = phone.matches ? 'camera' : 'file';
    const row = document.createElement('div');
    row.className = 'sources-row';
    row.append(button('Open a file…', () => fileInput.click(), primary === 'file' ? 'primary' : ''));
    if (navigator.mediaDevices?.getUserMedia) row.append(button('Camera', run(() => session.loadCamera()), primary === 'camera' ? 'primary' : ''));
    if (navigator.mediaDevices?.getDisplayMedia && !phone.matches) row.append(button('Screen', run(() => session.loadScreen())));

    const url = document.createElement('form');
    url.className = 'sources-url';
    const field = Object.assign(document.createElement('input'), { type: 'url', placeholder: 'Paste a video or HLS URL', autocomplete: 'off' });
    field.setAttribute('aria-label', 'Video URL');
    url.append(field, Object.assign(document.createElement('button'), { type: 'submit', textContent: 'Load' }));
    url.addEventListener('submit', (event) => {
      event.preventDefault();
      const value = field.value.trim();
      if (value) { closeSheets(); session.loadUrl(value); }
    });

    const samples = document.createElement('div');
    samples.className = 'sources-row sources-samples';
    samples.append(Object.assign(document.createElement('span'), { textContent: 'Samples' }));
    for (const clip of TEST_CLIPS) samples.append(button(clip.label, run(() => session.loadUrl(clip.url))));

    container.replaceChildren(row, url, samples);
  }
  buildSources($('emptySources'));
  buildSources($('sheetSources'));

  window.addEventListener('dragover', (event) => { event.preventDefault(); });
  window.addEventListener('drop', (event) => {
    event.preventDefault();
    const file = [...(event.dataTransfer?.files || [])].find((f) => f.type.startsWith('video/'));
    if (file) { closeSheets(); session.loadFile(file); }
  });

  // ── Sheets ──────────────────────────────────────────────────
  let returnFocus = null;
  function openSheet(id) {
    closeSheets();
    returnFocus = document.activeElement;
    const sheet = $(id);
    sheet.hidden = false;
    sheet.querySelector('button, input')?.focus();
    wake();
  }
  function closeSheets() {
    let closed = false;
    for (const id of ['sourceSheet', 'keysSheet']) {
      if (!$(id).hidden) closed = true;
      $(id).hidden = true;
    }
    if (closed && returnFocus?.isConnected) returnFocus.focus();
    returnFocus = null;
    return closed;
  }
  for (const sheet of root.querySelectorAll('.sheet')) {
    sheet.addEventListener('click', (event) => { if (event.target === sheet || event.target.closest('[data-close]')) closeSheets(); });
  }
  const keysList = $('keysList');
  for (const [keys, what] of SHORTCUTS) {
    keysList.append(Object.assign(document.createElement('dt'), { textContent: keys }), Object.assign(document.createElement('dd'), { textContent: what }));
  }

  // ── Actions (buttons and keys share them) ───────────────────
  const panel = initPanel({ container: $('paneHost'), session });
  const ruler = initRuler({ container: $('ruler'), session });

  const actions = {
    toggle: () => session.toggle(),
    step: (frames) => session.step(frames),
    rate: (direction) => {
      const index = RATES.indexOf(session.rate);
      session.setRate(RATES[Math.min(RATES.length - 1, Math.max(0, (index < 0 ? 2 : index) + direction))]);
    },
    mode: (index) => { if (MODES[index]) session.setParams({ algorithm: MODES[index].id }); },
    nudge: (param, direction) => {
      const def = session.mode.params.find((p) => p.key === param);
      if (!def) return;
      const next = Math.min(def.max, Math.max(def.min, session.params[param] + direction * (def.step || 1)));
      session.setParams({ [param]: next });
      session.setStatus(`${def.label} ${def.format ? def.format(next) : next}`, 'info');
    },
    display: () => {
      if (!session.mode.composite) return;
      const options = session.webgl ? DISPLAYS : DISPLAYS.slice(0, 3);
      const next = options[(options.indexOf(session.display) + 1) % options.length];
      session.setDisplay(next);
      session.setStatus(`Display: ${next}`, 'info');
    },
    split: () => { view.split = !view.split; applySplit(); },
    original: (held) => { view.original = held; applySplit(); },
    panel: () => { view.panel = !view.panel; applyLayout(); if (view.panel) $('panel').querySelector('button, select, input')?.focus(); },
    source: () => openSheet('sourceSheet'),
    keys: () => ($('keysSheet').hidden ? openSheet('keysSheet') : closeSheets()),
    auto: () => session.autoConfigure(),
    record: () => session.toggleRecord(),
    hide: () => { view.hidden = !view.hidden; applyLayout(); },
    theme: () => setTheme(document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark'),
    fullscreen: async () => {
      view.immersive = !view.immersive;
      applyLayout();
      try {
        if (view.immersive) await root.requestFullscreen?.();
        else if (document.fullscreenElement) await document.exitFullscreen();
      } catch { /* the viewfinder layout works without true fullscreen */ }
    },
    escape: () => {
      if (closeSheets()) return;
      if (view.hidden) { view.hidden = false; applyLayout(); return; }
      if (view.immersive) actions.fullscreen();
    },
  };
  initKeys(actions);
  document.addEventListener('fullscreenchange', () => {
    if (!document.fullscreenElement && view.immersive) { view.immersive = false; applyLayout(); }
  });

  const click = (id, fn) => $(id).addEventListener('click', fn);
  click('btnSource', actions.source);
  click('btnSource2', actions.source);
  click('btnPanel', actions.panel);
  click('btnParams', actions.panel);
  click('panelDone', actions.panel);
  click('btnFull', actions.fullscreen);
  click('vfExit', actions.fullscreen);
  click('btnTheme', actions.theme);
  click('btnKeys', actions.keys);
  click('btnPlay', actions.toggle);
  click('btnBack', () => actions.step(-1));
  click('btnForward', () => actions.step(1));
  click('btnRate', () => session.setRate(RATES[(RATES.indexOf(session.rate) + 1) % RATES.length] || 1));
  click('btnRec', actions.record);
  click('btnFlip', () => session.flipCamera());
  const cycleMode = (direction) => actions.mode((MODES.indexOf(session.mode) + direction + MODES.length) % MODES.length);
  click('vfPrev', () => cycleMode(-1));
  click('vfNext', () => cycleMode(1));
  // Tapping the picture on a phone brings the overlays back (or hides them).
  canvas.addEventListener('click', () => {
    if (root.dataset.layout !== 'viewfinder') return;
    if (root.dataset.idle === 'true') wake();
    else if (session.playing) root.dataset.idle = 'true';
  });

  // ── React to the session ────────────────────────────────────
  session.on((event) => {
    if (event === 'status') showStatus();
    else if (event === 'source') { applySource(); applyMode(); panel.refresh(); }
    else if (event === 'play' || event === 'recording') { applyPlay(); if (event === 'recording') panel.rebuild(); }
    else if (event === 'params' || event === 'display') { applyMode(); ruler.update(); panel.refresh(); applySource(); }
    else if (event === 'time') applyTime();
    else if (event === 'busy') root.dataset.busy = String(session.busy);
  });

  phone.addEventListener('change', () => {
    view.panel = !phone.matches;
    buildSources($('emptySources'));
    buildSources($('sheetSources'));
    applyLayout();
  });

  setTheme(document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light');
  applySource();
  applyMode();
  applyPlay();
  ruler.update();
  wake();
}
