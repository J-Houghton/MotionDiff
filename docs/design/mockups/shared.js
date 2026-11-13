// Shared by the three design mockups. Not part of the app.
//
// The pane is built from a schema shaped like the mode registry will be
// (one entry per mode, each with its own params), so the mockups show the real
// Tweakpane with realistic controls rather than a drawing of one.
import { Pane } from 'tweakpane';

export const MODES = [
  { id: 'posy', key: '1', label: 'Posy', blurb: 'current + inverted frame from earlier; grey is stillness',
    params: [
      { key: 'gap', label: 'Gap', min: 33, max: 3000, step: 33, value: 333, unit: 'ms' },
      { key: 'spread', label: 'RGB spread', min: 0, max: 167, step: 33, value: 67, unit: 'ms' },
      { key: 'threshold', label: 'Threshold', min: 0, max: 120, step: 1, value: 24 },
      { key: 'trail', label: 'Trail', min: 0, max: 3000, step: 33, value: 500, unit: 'ms' },
      { key: 'blur', label: 'Blur', value: false },
    ] },
  { id: 'raw', key: '2', label: 'Raw diff', blurb: '|current − earlier|; black is stillness', params: [] },
  { id: 'magnify', key: '3', label: 'Magnify', blurb: 'amplify a band of slow change and add it back', params: [] },
  { id: 'mask', key: '4', label: 'Motion mask', blurb: 'three-frame differencing', planned: true, params: [] },
  { id: 'history', key: '5', label: 'Motion history', blurb: 'time since last motion, direction as hue', planned: true, params: [] },
  { id: 'background', key: '6', label: 'Background', blurb: 'difference from a learned still scene', planned: true, params: [] },
];

export const SHORTCUTS = [
  ['Space', 'play / pause'], ['← →', 'step one frame'], ['J K L', 'shuttle'],
  ['1 – 6', 'mode'], ['[ ]', 'gap'], ['- =', 'threshold'], [', .', 'trail'],
  ['D', 'display: diff / overlay / glow'], ['S', 'split compare'], ['O (hold)', 'show original'],
  ['P', 'parameters'], ['N', 'new source'], ['A', 'auto-configure'], ['R', 'record'],
  ['H', 'hide everything'], ['F', 'fullscreen'], ['?', 'all shortcuts'],
];

/**
 * Build the parameter pane for one mode from the schema.
 * @returns {Pane}
 */
export function buildPane(container, modeId = 'posy') {
  const mode = MODES.find((m) => m.id === modeId);
  const state = { mode: modeId, display: 'glow', ageColor: false, preset: 'ghost', width: 640, cap: 0, fps: 29.97, volume: -12 };
  for (const p of mode.params) state[p.key] = p.value;

  const pane = new Pane({ container, title: 'Parameters' });
  pane.addBinding(state, 'mode', {
    label: 'Mode',
    options: Object.fromEntries(MODES.map((m) => [`${m.key}  ${m.label}${m.planned ? '  (planned)' : ''}`, m.id])),
  });

  const modeFolder = pane.addFolder({ title: mode.label });
  for (const p of mode.params) {
    const opts = { label: p.label };
    if (typeof p.value === 'number') {
      Object.assign(opts, { min: p.min, max: p.max, step: p.step });
      if (p.unit) opts.format = (v) => `${Math.round(v)} ${p.unit}`;
    }
    modeFolder.addBinding(state, p.key, opts);
  }

  const look = pane.addFolder({ title: 'Look' });
  look.addBinding(state, 'display', { label: 'Display', options: { Diff: 'diff', Overlay: 'overlay', Glow: 'glow' } });
  look.addBinding(state, 'ageColor', { label: 'Colour by age' });
  look.addBinding(state, 'preset', { label: 'Preset', options: { 'Subtle wind': 'wind', 'Ghost trails': 'ghost', Atmosphere: 'atmo', 'High contrast': 'contrast' } });
  look.addButton({ title: 'Auto-configure', label: '' });

  const perf = pane.addFolder({ title: 'Performance', expanded: false });
  perf.addBinding(state, 'width', { label: 'Width', options: { 320: 320, 480: 480, 640: 640, 1280: 1280, 1920: 1920 } });
  perf.addBinding(state, 'fps', { label: 'fps', readonly: true });
  pane.addFolder({ title: 'Sound', expanded: false }).addBinding(state, 'volume', { label: 'Volume', min: -60, max: 0, step: 1 });
  pane.addFolder({ title: 'Export', expanded: false }).addButton({ title: 'Record WebM' });

  patchAccessibility(pane.element);
  return pane;
}

/**
 * Tweakpane 4 has good keyboard support but ships no ARIA: controls have no
 * accessible name and slider tracks are bare divs. The pane is generated from
 * a schema, so the names are known — set them after building.
 */
export function patchAccessibility(root) {
  for (const row of root.querySelectorAll('.tp-lblv')) {
    const label = row.querySelector('.tp-lblv_l')?.textContent?.trim();
    if (!label) continue;
    for (const control of row.querySelectorAll('input, select, button')) control.setAttribute('aria-label', label);
    const track = row.querySelector('.tp-sldv_t');
    const field = row.querySelector('.tp-txtv_i');
    if (track) {
      track.setAttribute('role', 'slider');
      track.setAttribute('aria-label', label);
      const sync = () => field && track.setAttribute('aria-valuetext', field.value);
      sync();
      row.addEventListener('input', sync);
      row.addEventListener('change', sync);
    }
  }
}

/** Draggable (and arrow-key operable) split between original and output. */
export function splitCompare(stage, initial = 0.4) {
  const original = stage.querySelector('[data-original]');
  const handle = stage.querySelector('[data-split]');
  let at = initial;
  const apply = () => {
    original.style.clipPath = `inset(0 ${(1 - at) * 100}% 0 0)`;
    handle.style.left = `${at * 100}%`;
    handle.setAttribute('aria-valuenow', String(Math.round(at * 100)));
  };
  const move = (clientX) => { const r = stage.getBoundingClientRect(); at = Math.min(0.98, Math.max(0.02, (clientX - r.left) / r.width)); apply(); };
  handle.addEventListener('pointerdown', (e) => { handle.setPointerCapture(e.pointerId); });
  handle.addEventListener('pointermove', (e) => { if (handle.hasPointerCapture(e.pointerId)) move(e.clientX); });
  handle.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowLeft') at = Math.max(0.02, at - 0.02);
    else if (e.key === 'ArrowRight') at = Math.min(0.98, at + 0.02);
    else return;
    e.preventDefault(); apply();
  });
  apply();
}

/** `?state=idle` etc. lets the screenshots show a mockup in each of its states. */
export const viewState = new URLSearchParams(location.search).get('state') || 'active';
document.documentElement.dataset.state = viewState;
