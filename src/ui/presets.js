import { PARAMETER_PRESETS, PRESET_VERSION, migratePresetParams } from '../app/clips.js';

const STORAGE_KEY = 'motiondiff:user-presets';

function encodePresetValue(source, name) {
  return `${source}:${encodeURIComponent(name)}`;
}

function decodePresetValue(value) {
  const [source, encodedName] = value.split(':');
  if (!source || !encodedName) return null;
  return { source, name: decodeURIComponent(encodedName) };
}

function normalizeParams(params) {
  return {
    frameOffset: params.frameOffset,
    threshold: params.threshold,
    trailLength: params.trailLength,
    channelSpread: params.channelSpread,
    algorithm: params.algorithm,
    blurEnabled: params.blurEnabled,
    ageColorEnabled: params.ageColorEnabled ?? false,
  };
}

function loadUserPresets() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
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
  const stamped = presets.map(({ name, params }) => ({ name, params, v: PRESET_VERSION }));
  localStorage.setItem(STORAGE_KEY, JSON.stringify(stamped));
}

export function initPresets({ getCurrentParams, onPresetLoad, onStatus }) {
  const select = document.getElementById('presetConfigSelect');
  const saveButton = document.getElementById('savePresetBtn');
  const deleteButton = document.getElementById('deletePresetBtn');

  const builtInPresets = PARAMETER_PRESETS.map((preset) => ({
    ...preset,
    source: 'builtin',
  }));

  let userPresets = loadUserPresets().map((preset) => ({
    ...preset,
    source: 'user',
  }));

  function findPreset(value) {
    const parsed = decodePresetValue(value);
    if (!parsed) return null;

    const list = parsed.source === 'builtin' ? builtInPresets : userPresets;
    return list.find((preset) => preset.name === parsed.name) || null;
  }

  function renderOptions(selectedValue = '') {
    select.innerHTML = '';

    const placeholder = document.createElement('option');
    placeholder.value = '';
    placeholder.textContent = 'Select parameter preset...';
    select.appendChild(placeholder);

    const builtInGroup = document.createElement('optgroup');
    builtInGroup.label = 'Built-in';
    builtInPresets.forEach((preset) => {
      const option = document.createElement('option');
      option.value = encodePresetValue('builtin', preset.name);
      option.textContent = preset.name;
      builtInGroup.appendChild(option);
    });
    select.appendChild(builtInGroup);

    if (userPresets.length) {
      const userGroup = document.createElement('optgroup');
      userGroup.label = 'Saved';
      userPresets.forEach((preset) => {
        const option = document.createElement('option');
        option.value = encodePresetValue('user', preset.name);
        option.textContent = preset.name;
        userGroup.appendChild(option);
      });
      select.appendChild(userGroup);
    }

    select.value = selectedValue;
    updateDeleteButton();
  }

  function updateDeleteButton() {
    const preset = findPreset(select.value);
    deleteButton.disabled = !preset || preset.source !== 'user';
  }

  select.addEventListener('change', () => {
    updateDeleteButton();
    const preset = findPreset(select.value);
    if (!preset) return;
    onPresetLoad(normalizeParams(preset.params), preset.name, preset.source);
  });

  saveButton.addEventListener('click', () => {
    const name = window.prompt('Save current preset as:', '');
    const trimmed = name?.trim();
    if (!trimmed) return;

    const params = normalizeParams(getCurrentParams());
    const nextPreset = { name: trimmed, params, source: 'user' };
    const existingIndex = userPresets.findIndex((preset) => preset.name === trimmed);

    if (existingIndex >= 0) {
      userPresets[existingIndex] = nextPreset;
    } else {
      userPresets.push(nextPreset);
    }

    saveUserPresets(userPresets.map(({ name: presetName, params: presetParams }) => ({
      name: presetName,
      params: presetParams,
    })));
    const selectedValue = encodePresetValue('user', trimmed);
    renderOptions(selectedValue);
    onStatus(`Saved preset: ${trimmed}`, 'success');
  });

  deleteButton.addEventListener('click', () => {
    const preset = findPreset(select.value);
    if (!preset || preset.source !== 'user') return;

    userPresets = userPresets.filter((item) => item.name !== preset.name);
    saveUserPresets(userPresets.map(({ name, params }) => ({ name, params })));
    renderOptions('');
    onStatus(`Deleted preset: ${preset.name}`, 'info');
  });

  renderOptions();

  return {
    refresh() {
      userPresets = loadUserPresets().map((preset) => ({
        ...preset,
        source: 'user',
      }));
      renderOptions(select.value);
    },
  };
}
