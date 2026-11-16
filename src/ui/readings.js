/**
 * Readings panel: the numbers the pipeline already measures, shown beside
 * the picture as plate marginalia (docs/readings-panel.md). Desktop Plate
 * only; the I key and a mast button show and hide it.
 *
 * Sources, in order of preference:
 *   pipeline.readings   what the active mode measured this frame (flow and
 *                       schlieren publish; null elsewhere, and on the
 *                       Canvas 2D fallback those modes do not run)
 *   pipeline.getEnergyGrid  the pooled magnitude every mode has: the pen
 *                       line, the centre of motion and the quiet timer
 *   session/pipeline    cheap facts (gap, sizes, frame rate, ring)
 *
 * Everything shown states its unit; anything that is not a measurement says
 * so. Refresh is 4 Hz, not per frame.
 */

/** Samples per second, and how many the pen line keeps (60 s). */
const HZ = 4;
const HISTORY = 60 * HZ;
/** Pooled-grid mean above this counts as "something moved" for the quiet timer. */
const QUIET_FLOOR = 0.01;
/** Compass names in rose order (bin 0 = right, clockwise on screen). */
const SECTOR_NAMES = ['right', 'down-right', 'down', 'down-left', 'left', 'up-left', 'up', 'up-right'];
const SECTOR_ARROWS = ['→', '↘', '↓', '↙', '←', '↖', '↑', '↗'];

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

const fmt = {
  pct: (v) => `${Math.round(v * 100)}%`,
  px: (v) => `${Math.round(v)}`,
  one: (v) => v.toFixed(1),
  two: (v) => v.toFixed(2),
};

/**
 * @param {object} options
 * @param {HTMLElement} options.root
 * @param {HTMLElement} options.plate - The .plate grid the column joins
 * @param {import('../app/session.js').Session} options.session
 * @param {() => void} [options.onCalibrate] - Starts the mark-a-known-length flow
 * @returns {{toggle: () => void, update: () => void}}
 */
export function initReadings({ root, plate, session, onCalibrate, onCountLine }) {
  const aside = el('aside', 'readings chrome');
  aside.setAttribute('aria-label', 'Readings');
  const head = el('div', 'rd-head');
  const close = el('button', 'rd-close', '✕');
  close.type = 'button';
  close.setAttribute('aria-label', 'Close the readings');
  head.append(el('b', '', 'Readings'), close);

  const instruments = el('div', 'rd-instruments');
  const all = document.createElement('details');
  all.className = 'rd-all';
  all.append(el('summary', '', 'All readings'));
  const list = el('dl', 'rd-list');
  all.append(list);
  const note = el('p', 'rd-note');
  const calibrateLink = el('button', 'rd-calibrate', 'Calibrate: mark a known length ');
  calibrateLink.type = 'button';
  calibrateLink.append(Object.assign(document.createElement('kbd'), { textContent: 'C' }));
  if (onCalibrate) calibrateLink.addEventListener('click', onCalibrate);
  const countLink = el('button', 'rd-calibrate', 'Count line: movers over a drawn line ');
  countLink.type = 'button';
  countLink.append(Object.assign(document.createElement('kbd'), { textContent: 'X' }));
  if (onCountLine) countLink.addEventListener('click', onCountLine);
  // The naming model's numbers as pasteable text (docs/naming-poc.md): the
  // owner tests on another machine and reports what it read.
  const copyModel = el('button', 'rd-calibrate', 'Copy model readings');
  copyModel.type = 'button';
  copyModel.hidden = true;
  copyModel.addEventListener('click', async () => {
    const s = session.modelStatus?.();
    if (!s) return;
    const text = [
      `model rtdetr_v2_r18vd · backend ${s.backend}/${s.dtype}`,
      `load ${s.loadMs} ms · infer last ${s.lastInferMs} ms, median ${s.medianInferMs} ms · ${s.looksPerSecond} looks/s`,
      `frame rate ${session.fps.toFixed(1)} fps · processing ${session.pipeline.width}×${session.pipeline.height} · names on`,
    ].join('\n');
    try {
      await navigator.clipboard.writeText(text);
      session.setStatus('Model readings copied — paste them into your report', 'success');
    } catch {
      session.setStatus(text, 'info');
    }
  });
  aside.append(head, instruments, all, calibrateLink, countLink, copyModel, note);
  // Before the parameter panel: picture, readings, parameters.
  plate.insertBefore(aside, plate.querySelector('.panel'));

  // ── State ───────────────────────────────────────────────────
  let open = false;
  let timer = 0;
  const history = new Float32Array(HISTORY).fill(NaN);
  let historyAt = 0;
  let quietSince = 0; // performance.now() of the last movement, 0 = never

  // ── Raw list rows ───────────────────────────────────────────
  // [label, unit, value(ctx) -> string | null]; null hides the row.
  const flowOnly = (fn) => (ctx) => (ctx.r?.mode === 'flow' ? fn(ctx.r, ctx) : null);
  const ROWS = [
    ['peak speed', 'px/s · 95th pct of moving cells', flowOnly((r) => fmt.px(r.peak))],
    ['dominant heading', 'compass · mean of moving cells', flowOnly((r) => {
      const i = Math.round(((r.heading + Math.PI * 2) % (Math.PI * 2)) / (Math.PI / 4)) % 8;
      return `${SECTOR_ARROWS[i]} ${SECTOR_NAMES[i]} (${Math.round((r.heading * 180) / Math.PI)}°)`;
    })],
    ['coherence', '1 = one stream, 0 = opposed', flowOnly((r) => fmt.two(r.coherence))],
    ['moving', 'share of frame', flowOnly((r) => fmt.pct(r.moving))],
    ['measurable', 'share of frame', flowOnly((r) => fmt.pct(r.measured))],
    // The median shift speaks for the camera only when at least half the
    // frame is measured (the same rule as the status line): otherwise the
    // biggest mover drags it, and the number is not about the camera.
    ['camera motion', 'px/s, x right y down · median of measured', flowOnly((r) => (
      r.camera.share >= 0.5 ? `${fmt.one(r.camera.dx)}, ${fmt.one(r.camera.dy)}` : `— (${fmt.pct(r.camera.share)} measured: not a camera reading)`
    ))],
    ['beyond reach', 'share moving too fast', flowOnly((r) => fmt.pct(r.saturated))],
    ['speed ceiling', 'px/s this gap can measure', flowOnly((r) => (r.ceiling ? fmt.px(r.ceiling) : '—'))],
    ['speed spread', 'slow · medium · fast, of moving', flowOnly((r) => r.speeds.map(fmt.pct).join(' · '))],
    ['heading spread', '→↘↓↙←↖↑↗, of moving', flowOnly((r) => r.rose.map((v) => Math.round(v * 100)).join(' '))],
    ['setup', 'schlieren', (ctx) => {
      const s = ctx.r?.mode === 'schlieren' ? ctx.r.setup : null;
      if (!s) return null;
      return s.problem ? s.problem : `ok · ${fmt.pct(s.usable)} usable · floor ${s.floor?.toFixed?.(2) ?? '—'} px`;
    }],
    ['tracked movers', 'boxes with IDs now', (ctx) => (ctx.r?.objects ? String(ctx.r.objects.length) : null)],
    ['naming model', 'backend · ms per look · looks/s — estimates', () => {
      const s = session.modelStatus?.();
      return s ? `${s.backend}/${s.dtype} · ${s.lastInferMs} ms · ${s.looksPerSecond}/s` : null;
    }],
    ['scale', 'cm per pixel · true at the marked depth (C resets)', () => {
      const m = session.calibration?.metresPerPixel;
      return m ? (m * 100).toFixed(1) : null;
    }],
    ['overall motion', 'pooled grid, 0..1 of mode scale', (ctx) => (ctx.gridMean === null ? null : fmt.two(ctx.gridMean))],
    ['centre of motion', 'share of frame, from pooled grid', (ctx) => (ctx.centre ? `${fmt.pct(ctx.centre.x)}, ${fmt.pct(ctx.centre.y)}` : null)],
    ['quiet for', 's since motion in the grid', (ctx) => (ctx.quiet === null ? null : `${ctx.quiet.toFixed(1)} s`)],
    ['noise floor', 'levels, from Auto-configure', () => (Number.isFinite(session.noiseFloor) ? fmt.one(session.noiseFloor) : 'press A to measure')],
    ['gap', 'ms', () => {
      const back = session.mode.lookback?.(session.params);
      const units = back ? back[0] : session.params.frameOffset;
      return Number.isFinite(units) ? `${Math.round((units * 1000) / 30)}` : null;
    }],
    ['processing size', 'px', () => `${session.pipeline.width} × ${session.pipeline.height}`],
    ['frame rate', 'fps, measured', () => session.fps.toFixed(session.fps % 1 > 0.05 ? 2 : 0)],
    ['frame ring', 'frames held · MiB', () => {
      const info = session.pipeline.ringInfo();
      return info ? `${info.frames} · ${(info.bytes / (1024 * 1024)).toFixed(0)}` : null;
    }],
  ];
  // One row per reading: name and value share a line (a long value wraps
  // under the name), the unit sits beneath in small type. The old two-column
  // grid broke down when a value was wide: it crushed the name column to a
  // word a line and pushed the value out of the margin.
  const rowNodes = ROWS.map(([label, unit]) => {
    const dt = el('dt');
    const dd = el('dd', '', '');
    const top = el('div', 'rd-row');
    top.append(el('span', 'rd-name', label), dd);
    dt.append(top, el('i', '', unit));
    list.append(dt);
    return { dt, dd };
  });

  // ── Sampling ────────────────────────────────────────────────
  function sample() {
    const r = session.pipeline.readings;
    let gridMean = null;
    let centre = null;
    if (session.webgl && session.loaded) {
      const grid = session.pipeline.getEnergyGrid(8, 5);
      if (grid) {
        let sum = 0;
        let sx = 0;
        let sy = 0;
        for (let row = 0; row < 5; row++) {
          for (let col = 0; col < 8; col++) {
            const v = grid[row * 8 + col];
            sum += v;
            sx += v * (col + 0.5);
            sy += v * (row + 0.5);
          }
        }
        gridMean = sum / 40;
        if (sum > 0.001) centre = { x: sx / sum / 8, y: sy / sum / 5 };
      }
    }
    if (gridMean !== null && gridMean > QUIET_FLOOR) quietSince = performance.now();
    const quiet = gridMean === null ? null : quietSince === 0 ? null : (performance.now() - quietSince) / 1000;

    // The pen line prefers the mode's own moving share; the grid mean stands
    // in everywhere else, so the line works in every mode.
    const lineValue = r?.mode === 'flow' ? r.moving : gridMean;
    history[historyAt % HISTORY] = session.playing && lineValue !== null ? lineValue : NaN;
    historyAt++;

    return { r, gridMean, centre, quiet };
  }

  function refresh() {
    const ctx = sample();
    for (let i = 0; i < ROWS.length; i++) {
      const value = session.loaded ? ROWS[i][2](ctx) : null;
      rowNodes[i].dt.hidden = value === null;
      if (value !== null) rowNodes[i].dd.textContent = value;
    }
    copyModel.hidden = !session.modelStatus?.();
    const mode = session.mode;
    note.textContent = !session.loaded ? 'No source.'
      : ctx.r ? ''
        : `${mode.label} measures no flow readings; the motion line and the facts below come from the pooled grid.`;
    drawInstruments(ctx);
  }

  // ── Instruments (promoted readings; docs/readings-panel.md) ─
  const peak = el('div', 'rd-peak');
  const peakValue = el('b', '', '—');
  const peakUnit = el('span', '', 'peak px/s · fastest moving cells');
  peak.append(peakValue, peakUnit);
  const lineBox = el('div', 'rd-line');
  const lineCanvas = el('canvas');
  lineCanvas.width = 220;
  lineCanvas.height = 44;
  lineBox.append(lineCanvas, el('span', '', 'moving share · last 60 s'));
  const roseBox = el('div', 'rd-rose');
  const roseCanvas = el('canvas');
  roseCanvas.width = 96;
  roseCanvas.height = 96;
  roseBox.append(roseCanvas, el('span', '', 'heading of moving cells'));
  // The camera, as a lamp: green and still, or amber with the drift it reads.
  const cameraBox = el('div', 'rd-camera');
  const cameraLamp = el('i', 'rd-lamp');
  const cameraText = el('b', '', '—');
  cameraBox.append(cameraLamp, cameraText, el('span', '', 'camera · median of measured'));
  // Crossing counts over the drawn line (docs/data-out.md); the arrows are
  // the line's own normal, so they point the ways movers actually crossed.
  const countsBox = el('div', 'rd-camera');
  const countsText = el('b', '', '—');
  countsBox.append(countsText, el('span', '', 'movers over the count line'));
  instruments.append(peak, lineBox, roseBox, cameraBox, countsBox);

  function drawInstruments(ctx) {
    const r = ctx.r?.mode === 'flow' ? ctx.r : null;
    const scale = session.calibration?.metresPerPixel;
    peakValue.textContent = r ? (scale ? (r.peak * scale).toFixed(1) : fmt.px(r.peak)) : '—';
    peakUnit.textContent = scale ? 'peak m/s · fastest moving cells' : 'peak px/s · fastest moving cells';
    // Instruments that measure nothing in this mode are not shown at all: a
    // dimmed dash is still an empty box. The pen line stays in every mode.
    peak.hidden = !r;
    roseBox.hidden = !r;
    cameraBox.hidden = !r || r.camera.share < 0.5;
    // Only where boxes are being tracked: a line with no tracker is idle.
    const counts = ctx.r?.objects ? session.counts : null;
    countsBox.hidden = !counts;
    if (counts) {
      const set = session.countLine;
      const nx = -(set.y2 - set.y1);
      const ny = set.x2 - set.x1;
      const positive = SECTOR_ARROWS[Math.round(((Math.atan2(ny, nx) + Math.PI * 2) % (Math.PI * 2)) / (Math.PI / 4)) % 8];
      const negative = SECTOR_ARROWS[Math.round(((Math.atan2(-ny, -nx) + Math.PI * 2) % (Math.PI * 2)) / (Math.PI / 4)) % 8];
      countsText.textContent = `${positive} ${counts.pos} · ${negative} ${counts.neg}`;
    }
    if (!cameraBox.hidden) {
      const speed = Math.hypot(r.camera.dx, r.camera.dy);
      const still = speed < (r.width || 640) * 0.025;
      cameraLamp.dataset.state = still ? 'ok' : 'warn';
      cameraText.textContent = still ? 'still' : `${SECTOR_ARROWS[Math.round(((Math.atan2(r.camera.dy, r.camera.dx) + Math.PI * 2) % (Math.PI * 2)) / (Math.PI / 4)) % 8]} ${fmt.px(speed)} px/s`;
    }

    const ink = getComputedStyle(aside).color;
    const accent = getComputedStyle(aside).getPropertyValue('--accent') || '#c2301a';

    // The pen line on ruled chart paper.
    const g = lineCanvas.getContext('2d');
    const { width: lw, height: lh } = lineCanvas;
    g.clearRect(0, 0, lw, lh);
    g.strokeStyle = ink;
    g.globalAlpha = 0.18;
    g.lineWidth = 1;
    for (let x = 0; x <= lw; x += lw / 12) {
      g.beginPath(); g.moveTo(x + 0.5, 0); g.lineTo(x + 0.5, lh); g.stroke();
    }
    for (let y = 0; y <= lh; y += lh / 4) {
      g.beginPath(); g.moveTo(0, y + 0.5); g.lineTo(lw, y + 0.5); g.stroke();
    }
    g.globalAlpha = 1;
    g.strokeStyle = accent.trim() || ink;
    g.lineWidth = 1.25;
    g.beginPath();
    let pen = false;
    for (let i = 0; i < HISTORY; i++) {
      const v = history[(historyAt + i) % HISTORY];
      if (Number.isNaN(v)) { pen = false; continue; }
      const x = (i / (HISTORY - 1)) * lw;
      const y = lh - 2 - Math.min(1, v) * (lh - 4);
      if (pen) g.lineTo(x, y); else g.moveTo(x, y);
      pen = true;
    }
    g.stroke();

    // The rose: eight sectors, bar length = share, in the legend's hues.
    const rg = roseCanvas.getContext('2d');
    const { width: rw } = roseCanvas;
    const c = rw / 2;
    rg.clearRect(0, 0, rw, rw);
    // A compass card: the ring, faint cross hairs, then a petal per sector.
    rg.strokeStyle = ink;
    rg.globalAlpha = 0.3;
    rg.beginPath(); rg.arc(c, c, c - 1, 0, Math.PI * 2); rg.stroke();
    rg.globalAlpha = 0.12;
    for (let i = 0; i < 4; i++) {
      const a = (i * Math.PI) / 4;
      rg.beginPath();
      rg.moveTo(c - Math.cos(a) * (c - 1), c - Math.sin(a) * (c - 1));
      rg.lineTo(c + Math.cos(a) * (c - 1), c + Math.sin(a) * (c - 1));
      rg.stroke();
    }
    rg.globalAlpha = 1;
    if (r) {
      const most = Math.max(...r.rose, 0.0001);
      for (let i = 0; i < 8; i++) {
        const share = r.rose[i];
        if (share <= 0) continue;
        const angle = (i * Math.PI) / 4; // bin 0 = right, y down = clockwise
        const len = (c - 3) * (share / most);
        // A filled petal in the legend's hue for that heading.
        const spread = Math.PI / 10;
        rg.fillStyle = `hsl(${(i * 45) % 360} 80% 45%)`;
        rg.globalAlpha = 0.9;
        rg.beginPath();
        rg.moveTo(c, c);
        rg.lineTo(c + Math.cos(angle - spread) * len * 0.82, c + Math.sin(angle - spread) * len * 0.82);
        rg.lineTo(c + Math.cos(angle) * len, c + Math.sin(angle) * len);
        rg.lineTo(c + Math.cos(angle + spread) * len * 0.82, c + Math.sin(angle + spread) * len * 0.82);
        rg.closePath();
        rg.fill();
      }
      rg.globalAlpha = 1;
    }
  }

  // ── Open and close ──────────────────────────────────────────
  function apply() {
    root.dataset.readings = String(open);
    aside.hidden = !open;
    clearInterval(timer);
    timer = 0;
    if (open) {
      refresh();
      timer = setInterval(refresh, 1000 / HZ);
    }
  }
  close.addEventListener('click', () => { open = false; apply(); });

  apply();
  return {
    toggle() { open = !open; apply(); return open; },
    close() { if (open) { open = false; apply(); } },
    isOpen: () => open,
    update() { if (open) refresh(); },
  };
}
