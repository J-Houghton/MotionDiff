/**
 * The parameter panel: a Tweakpane built from the active mode's schema.
 *
 * Nothing here knows any mode by name. Controls come from `mode.params`
 * (app/modes/params.js); the folders after it (look, performance,
 * export) are the same for every mode. The pane is rebuilt when the mode
 * changes, which is simpler than diffing it.
 */
import { Pane } from 'tweakpane';
import { MODES } from '../app/modes/index.js';
import { PARAMETER_PRESETS, PRESET_VERSION, migratePresetParams } from '../app/clips.js';

const PRESET_KEY = 'motiondiff:user-presets';
const DISPLAYS = { Diff: 'diff', Overlay: 'overlay', Glow: 'glow', 'Data (what the mode measures)': 'data' };
const WIDTHS = { '320 px': 320, '480 px': 480, '640 px': 640, '1280 px': 1280, '1920 px': 1920 };
const FPS_CAPS = { 'Source rate': 0, '60 fps': 60, '30 fps': 30, '24 fps': 24, '15 fps': 15 };

function loadUserPresets() {
  try {
    const parsed = JSON.parse(localStorage.getItem(PRESET_KEY) || '[]');
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((preset) => preset && typeof preset.name === 'string' && preset.params)
      // Presets saved before the threshold unit changed carry no version.
      .map((preset) => ({ name: preset.name, params: migratePresetParams(preset.params, preset.v) }));
  } catch {
    return [];
  }
}

function saveUserPresets(presets) {
  try {
    localStorage.setItem(PRESET_KEY, JSON.stringify(presets.map(({ name, params }) => ({ name, params, v: PRESET_VERSION }))));
  } catch {
    // Storage may be unavailable (private mode); presets then last for the session.
  }
}

/**
 * Tweakpane 4 has good keyboard support but ships no ARIA: controls have no
 * accessible name and slider tracks are bare divs (records/research.md §5). The
 * labels are known here, so set them after building.
 */
function patchAccessibility(root) {
  for (const row of root.querySelectorAll('.tp-lblv')) {
    const label = row.querySelector('.tp-lblv_l')?.textContent?.trim();
    if (!label) continue;
    for (const control of row.querySelectorAll('input, select, button')) {
      if (!control.getAttribute('aria-label')) control.setAttribute('aria-label', label);
    }
    const track = row.querySelector('.tp-sldv_t');
    const field = row.querySelector('.tp-txtv_i');
    if (track && !track.hasAttribute('role')) {
      track.setAttribute('role', 'slider');
      track.setAttribute('aria-label', label);
      const sync = () => { if (field) track.setAttribute('aria-valuetext', field.value); };
      sync();
      row.addEventListener('input', sync);
      row.addEventListener('change', sync);
      row.addEventListener('keyup', sync);
    }
  }
  for (const button of root.querySelectorAll('button:not([aria-label])')) {
    const text = button.textContent.trim();
    if (text) button.setAttribute('aria-label', text);
  }
}

/**
 * @param {object} options
 * @param {HTMLElement} options.container
 * @param {import('../app/session.js').Session} options.session
 * @returns {{refresh: () => void, rebuild: () => void}}
 */
export function initPanel({ container, session }) {
  let pane = null;
  let builtFor = null;
  let whenBindings = [];
  let userPresets = loadUserPresets();
  // Tweakpane edits this object; changes are forwarded to the session.
  const values = {};
  const ui = { mode: '', display: '', preset: '', width: 640, fpsCap: 0, fps: 0, info: '' };

  function syncValues() {
    Object.assign(values, session.params);
    ui.mode = session.mode.id;
    ui.display = session.display;
    ui.width = session.width;
    ui.fpsCap = session.params.fpsCap || 0;
    // The Preset select shows the look last applied (a sample's, or a pick).
    const active = session.activePreset;
    ui.preset = active && PARAMETER_PRESETS.some((preset) => preset.name === active) ? `builtin:${active}`
      : active && userPresets.some((preset) => preset.name === active) ? `user:${active}` : '';
  }

  function applyWhen() {
    for (const { binding, when } of whenBindings) binding.hidden = !when(values);
  }

  function addParam(folder, param) {
    const options = { label: param.label };
    if (param.type === 'range') {
      Object.assign(options, { min: param.min, max: param.max, step: param.step });
      if (param.format) options.format = param.format;
    } else if (param.type === 'select') {
      options.options = param.options;
    }
    const binding = folder.addBinding(values, param.key, options);
    binding.on('change', (event) => {
      session.setParams({ [param.key]: event.value });
      applyWhen();
    });
    if (param.when) whenBindings.push({ binding, when: param.when });
  }

  function presetOptions() {
    const options = { '—': '' };
    for (const preset of PARAMETER_PRESETS) options[preset.name] = `builtin:${preset.name}`;
    for (const preset of userPresets) options[`${preset.name} (saved)`] = `user:${preset.name}`;
    return options;
  }

  function findPreset(value) {
    const [source, name] = [value.slice(0, value.indexOf(':')), value.slice(value.indexOf(':') + 1)];
    return (source === 'user' ? userPresets : PARAMETER_PRESETS).find((preset) => preset.name === name) || null;
  }

  function build() {
    pane?.dispose();
    whenBindings = [];
    syncValues();
    const mode = session.mode;
    builtFor = mode.id;

    pane = new Pane({ container, title: 'Parameters' });

    const modeOptions = {};
    MODES.forEach((entry, index) => { modeOptions[`${index + 1}  ${entry.label}`] = entry.id; });
    pane.addBinding(ui, 'mode', { label: 'Mode', options: modeOptions })
      .on('change', (event) => session.setParams({ algorithm: event.value }));

    const modeFolder = pane.addFolder({ title: mode.label });
    for (const param of mode.params) addParam(modeFolder, param);

    const look = pane.addFolder({ title: 'Look' });
    // Camera compensation applies in every mode that differences or
    // measures flow; magnify and schlieren have their own answers.
    if (!['magnify', 'schlieren'].includes(mode.id) && session.webgl) {
      look.addBinding(values, 'cameraComp', { label: 'Steady camera' })
        .on('change', (event) => session.setParams({ cameraComp: event.value }));
    }
    if (mode.composite) {
      const displays = session.webgl ? DISPLAYS : Object.fromEntries(Object.entries(DISPLAYS).filter(([, v]) => v !== 'data'));
      look.addBinding(ui, 'display', { label: 'Display', options: displays })
        .on('change', (event) => session.setDisplay(event.value));
    }
    look.addBinding(ui, 'preset', { label: 'Preset', options: presetOptions() }).on('change', (event) => {
      const preset = event.value && findPreset(event.value);
      if (!preset) return;
      session.applyPreset(preset);
      session.setStatus(`Preset: ${preset.name}`, 'success');
    });
    look.addButton({ title: 'Save current as preset…' }).on('click', () => {
      const name = window.prompt('Save current settings as:', '')?.trim();
      if (!name) return;
      const params = {};
      for (const param of session.mode.params) params[param.key] = session.params[param.key];
      params.algorithm = session.mode.id;
      userPresets = userPresets.filter((preset) => preset.name !== name).concat({ name, params });
      saveUserPresets(userPresets);
      session.setStatus(`Saved preset: ${name}`, 'success');
      scheduleBuild();
    });
    if (userPresets.length) {
      look.addButton({ title: 'Delete a saved preset…' }).on('click', () => {
        const name = window.prompt(`Delete which saved preset?\n${userPresets.map((p) => p.name).join(', ')}`, '')?.trim();
        if (!name || !userPresets.some((preset) => preset.name === name)) return;
        userPresets = userPresets.filter((preset) => preset.name !== name);
        saveUserPresets(userPresets);
        session.setStatus(`Deleted preset: ${name}`, 'info');
        scheduleBuild();
      });
    }
    if (mode.params.some((param) => param.key === 'frameOffset')) {
      look.addButton({ title: 'Auto-configure (A)' }).on('click', () => session.autoConfigure());
    }

    const perf = pane.addFolder({ title: 'Performance', expanded: false });
    perf.addBinding(ui, 'width', { label: 'Width', options: WIDTHS }).on('change', (event) => session.setWidth(event.value));
    perf.addBinding(ui, 'fpsCap', { label: 'Frame cap', options: FPS_CAPS }).on('change', (event) => session.setParams({ fpsCap: event.value || null }));
    perf.addBinding(ui, 'info', { label: 'Renderer', readonly: true });

    const exportFolder = pane.addFolder({ title: 'Export', expanded: false });
    const record = exportFolder.addButton({ title: session.recording ? 'Stop recording (R)' : 'Record WebM (R)' });
    record.disabled = !session.canRecord;
    record.on('click', () => session.toggleRecord());
    // Data out (records/design/data-out.md): collect per-frame rows, export them.
    const collect = exportFolder.addButton({ title: session.collecting ? 'Stop collecting data' : 'Collect data' });
    collect.on('click', () => { collect.title = session.toggleCollect() ? 'Stop collecting data' : 'Collect data'; });
    const tracksButton = exportFolder.addButton({ title: 'Export tracks (CSV)' });
    tracksButton.on('click', () => {
      if (session.dataRowCount === 0) session.setStatus('Nothing collected yet: press "Collect data", then play', 'info');
      else session.exportTracksCsv();
    });
    const readingsButton = exportFolder.addButton({ title: 'Export readings (JSON)' });
    readingsButton.on('click', () => {
      if (session.dataRowCount === 0) session.setStatus('Nothing collected yet: press "Collect data", then play', 'info');
      else session.exportReadingsJson();
    });

    updateInfo();
    applyWhen();
    patchAccessibility(pane.element);
  }

  // Rebuilding disposes the pane, which must not happen inside one of its
  // own event handlers.
  let buildQueued = false;
  function scheduleBuild() {
    if (buildQueued) return;
    buildQueued = true;
    setTimeout(() => { buildQueued = false; build(); }, 0);
  }

  function updateInfo() {
    const { frames } = session.pipeline.getHistoryInfo();
    ui.info = `${session.webgl ? 'WebGL2' : 'Canvas 2D'} · ${session.pipeline.width}×${session.pipeline.height} · ring ${frames}`;
  }

  /** Bring the controls in line after a change made elsewhere (keys, ruler, preset). */
  function refresh() {
    if (session.mode.id !== builtFor) {
      scheduleBuild();
      return;
    }
    syncValues();
    updateInfo();
    applyWhen();
    pane.refresh();
  }

  build();
  return { refresh, rebuild: scheduleBuild };
}
