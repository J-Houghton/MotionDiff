import Pickr from '@simonwep/pickr';

const PICKR_SWATCHES = [
  '#ff0000', '#ff4400', '#ffaa00',
  '#00ff00', '#00ffaa', '#0044ff',
  '#0000ff', '#aa00ff', '#ffffff',
];
const popTimers = new WeakMap();

function normalizeHex(value, fallback) {
  return typeof value === 'string' && /^#[0-9a-f]{6}$/i.test(value) ? value.toLowerCase() : fallback;
}

function parseNullableInt(value) {
  if (value === null || value === undefined || value === '' || value === 'max') {
    return null;
  }

  const parsed = parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : null;
}

function pickrColorToHex(color, fallback) {
  if (!color) return fallback;
  const raw = color.toHEXA().toString().toLowerCase();
  const match = raw.match(/^#([0-9a-f]{6})/i);
  return match ? `#${match[1]}` : fallback;
}

function setRangeFill(slider) {
  if (!slider) return;
  const min = Number.parseFloat(slider.min || '0');
  const max = Number.parseFloat(slider.max || '100');
  const value = Number.parseFloat(slider.value || '0');
  const percent = max > min ? ((value - min) / (max - min)) * 100 : 0;
  slider.style.backgroundSize = `${percent}% 100%, 100% 100%`;
}

function triggerValuePop(labelEl) {
  if (!labelEl) return;
  const existingTimer = popTimers.get(labelEl);
  if (existingTimer) {
    clearTimeout(existingTimer);
  }
  labelEl.classList.remove('popping');
  void labelEl.offsetWidth;
  labelEl.classList.add('popping');
  const timerId = window.setTimeout(() => {
    labelEl.classList.remove('popping');
    popTimers.delete(labelEl);
  }, 300);
  popTimers.set(labelEl, timerId);
}

export function initControls({
  onParams,
  onParamChange,
  onFileLoad,
  onUrlLoad,
  onDisplayModeChange,
  onAutoConfigure,
  onCameraLoad,
  onCameraFlip,
  onScreenLoad,
  onToggleTheater,
  onProcessingWidthChange,
}) {
  const fileInput = document.getElementById('fileInput');
  const urlInput = document.getElementById('urlInput');
  const loadUrlBtn = document.getElementById('loadUrlBtn');
  const autoConfigBtn = document.getElementById('autoConfigBtn');
  const btnCamera = document.getElementById('btnCamera');
  const cameraFlipBtn = document.getElementById('cameraFlipBtn');
  const btnScreen = document.getElementById('btnScreen');
  const theaterToggleBtn = document.getElementById('theaterToggleBtn');
  const themeToggle = document.getElementById('themeToggle');
  const statusEl = document.getElementById('statusMsg');

  const sliderOffset = document.getElementById('sliderOffset');
  const sliderThreshold = document.getElementById('sliderThreshold');
  const sliderTrail = document.getElementById('sliderTrail');
  const sliderSpread = document.getElementById('sliderSpread');

  const valOffset = document.getElementById('valOffset');
  const valThreshold = document.getElementById('valThreshold');
  const valTrail = document.getElementById('valTrail');
  const valSpread = document.getElementById('valSpread');

  const selectResolution = document.getElementById('selectResolution');
  const selectFpsCap = document.getElementById('selectFpsCap');
  const performanceStatus = document.getElementById('performanceStatus');
  const rgbTintGroup = document.getElementById('rgbTintGroup');
  const ageGradientGroup = document.getElementById('ageGradientGroup');
  const inputTintR = document.getElementById('rgbTintR');
  const inputTintG = document.getElementById('rgbTintG');
  const inputTintB = document.getElementById('rgbTintB');
  const inputAgeColorNew = document.getElementById('ageColorNew');
  const inputAgeColorOld = document.getElementById('ageColorOld');

  const btnAlgo = document.getElementById('btnAlgo');
  const btnBlur = document.getElementById('btnBlur');
  const btnAgeColor = document.getElementById('btnAgeColor');
  const btnDisplay = document.getElementById('btnDisplay');
  const playbackRateControl = document.getElementById('playbackRateControl');
  const playbackRateSelect = document.getElementById('playbackRateSelect');
  const btnRecord = document.getElementById('btnRecord');

  const dotOriginal = document.getElementById('dotOriginal');
  const dotDiff = document.getElementById('dotDiff');
  const placeholderOriginal = document.getElementById('placeholderOriginal');
  const placeholderDiff = document.getElementById('placeholderDiff');

  // Build the magnify params section inside its index.html container
  // (index.html stays a one-container-per-feature shell). This runs
  // before the range-input query below so the generic slider wiring
  // picks these up too.
  const magnifyControls = document.getElementById('magnifyControls');
  if (magnifyControls) {
    magnifyControls.innerHTML = `
      <span class="subsection-label">Magnify</span>
      <div class="slider-grid">
        <div class="slider-cell">
          <span class="ctrl-label">Amplify</span>
          <input type="range" id="sliderMagAmp" min="1" max="60" step="1" value="15">
          <span class="ctrl-val" id="valMagAmp">15x</span>
        </div>
        <div class="slider-cell">
          <span class="ctrl-label">Band Low Hz</span>
          <input type="range" id="sliderMagFreqLow" min="0.05" max="5" step="0.05" value="0.7">
          <span class="ctrl-val" id="valMagFreqLow">0.70</span>
        </div>
        <div class="slider-cell">
          <span class="ctrl-label">Band High Hz</span>
          <input type="range" id="sliderMagFreqHigh" min="0.1" max="10" step="0.1" value="2">
          <span class="ctrl-val" id="valMagFreqHigh">2.00</span>
        </div>
        <div class="slider-cell">
          <span class="ctrl-label">Chroma</span>
          <input type="range" id="sliderMagChroma" min="0" max="1" step="0.05" value="1">
          <span class="ctrl-val" id="valMagChroma">1.00</span>
        </div>
      </div>
      <div class="slider-cell">
        <span class="ctrl-label">Downsample</span>
        <select id="selectMagDownsample" class="control-select" aria-label="Magnify downsample">
          <option value="1">1&times; (full res)</option>
          <option value="2" selected>2&times;</option>
          <option value="4">4&times;</option>
        </select>
      </div>`;
  }
  const sliderMagAmp = document.getElementById('sliderMagAmp');
  const sliderMagFreqLow = document.getElementById('sliderMagFreqLow');
  const sliderMagFreqHigh = document.getElementById('sliderMagFreqHigh');
  const sliderMagChroma = document.getElementById('sliderMagChroma');
  const selectMagDownsample = document.getElementById('selectMagDownsample');
  const valMagAmp = document.getElementById('valMagAmp');
  const valMagFreqLow = document.getElementById('valMagFreqLow');
  const valMagFreqHigh = document.getElementById('valMagFreqHigh');
  const valMagChroma = document.getElementById('valMagChroma');

  const rangeInputs = Array.from(document.querySelectorAll('input[type="range"]'));
  const algorithmButtons = Array.from(btnAlgo?.querySelectorAll('[data-algorithm]') || []);
  const displayButtons = Array.from(btnDisplay?.querySelectorAll('[data-mode]') || []);
  const playbackRateButtons = Array.from(playbackRateControl?.querySelectorAll('[data-rate]') || []);
  const ageToggleWrap = btnAgeColor?.closest('.toggle-switch');

  function syncToggleTrack(input) {
    const track = input?.nextElementSibling;
    if (track?.classList?.contains('toggle-track')) {
      track.classList.toggle('checked', Boolean(input.checked));
    }
  }

  const state = {
    frameOffset: 5,
    threshold: 20,
    trailLength: 5,
    channelSpread: 0,
    algorithm: 'posy',
    blurEnabled: false,
    ageColorEnabled: false,
    displayMode: 'overlay',
    playing: false,
    rgbTintR: '#ff0000',
    rgbTintG: '#00ff00',
    rgbTintB: '#0000ff',
    ageColorNew: '#ff4400',
    ageColorOld: '#0044ff',
    processingWidth: 640,
    fpsCap: null,
    magAmp: 15,
    magFreqLow: 0.7,
    magFreqHigh: 2.0,
    magChroma: 1.0,
    magDownsample: 2,
  };
  const pickrs = {};
  let activePresetButton = null;
  let magnifyAvailable = true;

  function emitParamChange(params) {
    if (onParamChange) onParamChange(params);
  }

  function getTheme() {
    return document.documentElement.getAttribute('data-theme') === 'light' ? 'light' : 'dark';
  }

  function updateThemeButton() {
    if (!themeToggle) return;
    const theme = getTheme();
    themeToggle.innerHTML = theme === 'light' ? '&#9728;' : '&#9790;';
    themeToggle.setAttribute('aria-label', theme === 'light' ? 'Switch to dark mode' : 'Switch to light mode');
    themeToggle.title = themeToggle.getAttribute('aria-label');
  }

  function applyTheme(theme) {
    document.documentElement.setAttribute('data-theme', theme);
    try {
      localStorage.setItem('motiondiff-theme', theme);
    } catch {
      // Ignore storage failures; the toggle should still work for the session.
    }
    updateThemeButton();
  }

  function updatePerformanceStatus() {
    if (!performanceStatus) return;
    const capLabel = state.fpsCap ? `cap ${state.fpsCap}fps` : 'uncapped';
    performanceStatus.innerHTML = `Processing at ${state.processingWidth}px &middot; ${capLabel}`;
  }

  function updatePresetLoadingState() {
    const isLoading = Boolean(activePresetButton && statusEl?.classList.contains('loading'));
    const presetButtons = document.querySelectorAll('#presetClips .preset-btn');
    presetButtons.forEach((button) => {
      button.classList.toggle('loading', isLoading && button === activePresetButton);
    });
  }

  function setActivePresetButton(button) {
    const presetButtons = document.querySelectorAll('#presetClips .preset-btn');
    activePresetButton = button;
    presetButtons.forEach((item) => {
      const isActive = item === button;
      item.classList.toggle('is-active', isActive);
      if (isActive) item.setAttribute('data-active', 'true');
      else item.removeAttribute('data-active');
    });
    updatePresetLoadingState();
  }

  function clearActivePresetButton() {
    setActivePresetButton(null);
  }

  function setOffset(value, notify = true) {
    const v = parseInt(value, 10);
    sliderOffset.value = String(v);
    setRangeFill(sliderOffset);
    state.frameOffset = v;
    valOffset.textContent = `${v}f`;
    if (notify) triggerValuePop(valOffset);
    if (notify) emitParamChange({ frameOffset: v });
  }

  function setThreshold(value, notify = true) {
    const v = parseInt(value, 10);
    sliderThreshold.value = String(v);
    setRangeFill(sliderThreshold);
    state.threshold = v;
    valThreshold.textContent = String(v);
    if (notify) triggerValuePop(valThreshold);
    if (notify) emitParamChange({ threshold: v });
  }

  function setTrailLength(value, notify = true) {
    const v = parseInt(value, 10);
    sliderTrail.value = String(v);
    setRangeFill(sliderTrail);
    state.trailLength = v;
    valTrail.textContent = `${v}f`;
    if (notify) triggerValuePop(valTrail);
    if (notify) emitParamChange({ trailLength: v });
  }

  function updateRgbTintVisibility() {
    if (!rgbTintGroup) return;
    const visible = state.channelSpread > 0;
    rgbTintGroup.hidden = !visible;
    ['rgbTintR', 'rgbTintG', 'rgbTintB'].forEach((key) => {
      if (!pickrs[key]) return;
      if (visible) {
        pickrs[key].enable();
      } else {
        pickrs[key].disable();
      }
    });
  }

  function setChannelSpread(value, notify = true) {
    const v = parseInt(value, 10);
    sliderSpread.value = String(v);
    setRangeFill(sliderSpread);
    state.channelSpread = v;
    valSpread.textContent = `${v}f`;
    updateRgbTintVisibility();
    if (notify) triggerValuePop(valSpread);
    if (notify) emitParamChange({ channelSpread: v });
  }

  function updateMagnifyVisibility() {
    const isMagnify = state.algorithm === 'magnify';
    if (magnifyControls) magnifyControls.hidden = !isMagnify;

    // Frame offset, channel spread, and trails have no effect in magnify
    // mode — gray them out rather than hiding them.
    [sliderOffset, sliderSpread, sliderTrail].forEach((slider) => {
      if (!slider) return;
      slider.disabled = isMagnify;
      const cell = slider.closest('.slider-cell');
      if (cell) {
        cell.style.opacity = isMagnify ? '0.45' : '';
        cell.title = isMagnify ? 'No effect in Magnify mode' : '';
      }
    });
  }

  function setMagAmp(value, notify = true) {
    const v = Math.min(60, Math.max(1, Math.round(Number.parseFloat(value)) || 1));
    if (sliderMagAmp) sliderMagAmp.value = String(v);
    setRangeFill(sliderMagAmp);
    state.magAmp = v;
    if (valMagAmp) valMagAmp.textContent = `${v}x`;
    if (notify) triggerValuePop(valMagAmp);
    if (notify) emitParamChange({ magAmp: v });
  }

  function setMagFreqLow(value, notify = true) {
    let v = Number.parseFloat(value);
    if (!Number.isFinite(v)) return;
    // Keep the band valid: high must stay above low
    v = Math.min(Math.max(v, 0.05), 5, state.magFreqHigh - 0.05);
    v = Math.round(v * 100) / 100;
    if (sliderMagFreqLow) sliderMagFreqLow.value = String(v);
    setRangeFill(sliderMagFreqLow);
    state.magFreqLow = v;
    if (valMagFreqLow) valMagFreqLow.textContent = v.toFixed(2);
    if (notify) triggerValuePop(valMagFreqLow);
    if (notify) emitParamChange({ magFreqLow: v });
  }

  function setMagFreqHigh(value, notify = true) {
    let v = Number.parseFloat(value);
    if (!Number.isFinite(v)) return;
    v = Math.max(Math.min(v, 10), 0.1, state.magFreqLow + 0.05);
    v = Math.round(v * 100) / 100;
    if (sliderMagFreqHigh) sliderMagFreqHigh.value = String(v);
    setRangeFill(sliderMagFreqHigh);
    state.magFreqHigh = v;
    if (valMagFreqHigh) valMagFreqHigh.textContent = v.toFixed(2);
    if (notify) triggerValuePop(valMagFreqHigh);
    if (notify) emitParamChange({ magFreqHigh: v });
  }

  function setMagChroma(value, notify = true) {
    let v = Number.parseFloat(value);
    if (!Number.isFinite(v)) return;
    v = Math.round(Math.min(Math.max(v, 0), 1) * 100) / 100;
    if (sliderMagChroma) sliderMagChroma.value = String(v);
    setRangeFill(sliderMagChroma);
    state.magChroma = v;
    if (valMagChroma) valMagChroma.textContent = v.toFixed(2);
    if (notify) triggerValuePop(valMagChroma);
    if (notify) emitParamChange({ magChroma: v });
  }

  function setMagDownsample(value, notify = true) {
    const parsed = Number.parseInt(value, 10);
    const v = [1, 2, 4].includes(parsed) ? parsed : 2;
    if (selectMagDownsample) selectMagDownsample.value = String(v);
    state.magDownsample = v;
    if (notify) emitParamChange({ magDownsample: v });
  }

  function setMagnifyAvailable(available) {
    magnifyAvailable = Boolean(available);
    const magBtn = algorithmButtons.find((button) => button.dataset.algorithm === 'magnify');
    if (magBtn) {
      magBtn.disabled = !magnifyAvailable;
      magBtn.style.opacity = magnifyAvailable ? '' : '0.45';
      magBtn.title = magnifyAvailable
        ? ''
        : 'Unavailable: this GPU lacks float render targets (EXT_color_buffer_float)';
    }
    if (!magnifyAvailable && state.algorithm === 'magnify') {
      setAlgorithm('posy');
    }
  }

  function updateAgeColorVisibility() {
    const algorithmAllowsAgeColor = state.algorithm === 'posy';
    if (btnAgeColor) {
      btnAgeColor.disabled = !algorithmAllowsAgeColor;
    }
    if (ageToggleWrap) {
      ageToggleWrap.hidden = !algorithmAllowsAgeColor;
    }

    const showGradient = algorithmAllowsAgeColor && state.ageColorEnabled;
    if (ageGradientGroup) {
      ageGradientGroup.hidden = !showGradient;
      ['ageColorNew', 'ageColorOld'].forEach((key) => {
        if (!pickrs[key]) return;
        if (showGradient) {
          pickrs[key].enable();
        } else {
          pickrs[key].disable();
        }
      });
    }
  }

  function setAlgorithm(algorithm, notify = true) {
    if (algorithm === 'magnify' && !magnifyAvailable) {
      algorithm = 'posy';
    }
    state.algorithm = algorithm;
    algorithmButtons.forEach((button) => {
      const isActive = button.dataset.algorithm === algorithm;
      button.classList.toggle('active', isActive);
      button.classList.toggle('seg-active', isActive);
      if (isActive) button.setAttribute('data-active', 'true');
      else button.removeAttribute('data-active');
    });
    updateAgeColorVisibility();
    updateMagnifyVisibility();
    if (notify) emitParamChange({ algorithm });
  }

  function setBlurEnabled(enabled, notify = true) {
    state.blurEnabled = Boolean(enabled);
    if (btnBlur) btnBlur.checked = state.blurEnabled;
    syncToggleTrack(btnBlur);
    if (notify) emitParamChange({ blurEnabled: state.blurEnabled });
  }

  function setAgeColorEnabled(enabled, notify = true) {
    state.ageColorEnabled = Boolean(enabled);
    if (btnAgeColor) btnAgeColor.checked = state.ageColorEnabled;
    syncToggleTrack(btnAgeColor);
    updateAgeColorVisibility();
    if (notify) emitParamChange({ ageColorEnabled: state.ageColorEnabled });
  }

  function setRgbTint(key, value, notify = true) {
    const nextValue = normalizeHex(value, state[key]);
    state[key] = nextValue;
    if (pickrs[key]) pickrs[key].setColor(nextValue, true);
    if (notify) emitParamChange({ [key]: nextValue });
  }

  function setAgeGradient(key, value, notify = true) {
    const fallback = key === 'ageColorNew' ? '#ff4400' : '#0044ff';
    const nextValue = normalizeHex(value, fallback);
    state[key] = nextValue;
    if (pickrs[key]) pickrs[key].setColor(nextValue, true);
    if (notify) emitParamChange({ [key]: nextValue });
  }

  function createColorPickr(elementId, defaultColor, onSave) {
    const element = document.getElementById(elementId);
    if (!element) return null;

    const pickr = Pickr.create({
      el: `#${elementId}`,
      theme: 'nano',
      inline: false,
      defaultRepresentation: 'HEX',
      default: defaultColor,
      components: {
        preview: true,
        opacity: false,
        hue: true,
        interaction: {
          hex: true,
          input: true,
          save: true,
        },
      },
      swatches: PICKR_SWATCHES,
    });

    pickr.on('save', (color) => {
      const hex = pickrColorToHex(color, defaultColor);
      onSave(hex);
      pickr.hide();
    });

    return pickr;
  }

  function setProcessingWidth(value, notify = true) {
    const nextWidth = parseInt(value, 10);
    if (!Number.isFinite(nextWidth)) return;
    state.processingWidth = nextWidth;
    if (selectResolution) selectResolution.value = String(nextWidth);
    updatePerformanceStatus();
    if (notify && onProcessingWidthChange) onProcessingWidthChange(nextWidth);
  }

  function setFpsCap(value, notify = true) {
    const nextCap = parseNullableInt(value);
    state.fpsCap = nextCap;
    if (selectFpsCap) {
      selectFpsCap.value = nextCap === null ? 'max' : String(nextCap);
    }
    updatePerformanceStatus();
    if (notify) emitParamChange({ fpsCap: nextCap });
  }

  function setDisplayMode(mode) {
    state.displayMode = mode.toLowerCase();
    displayButtons.forEach((button) => {
      const isActive = button.dataset.mode === state.displayMode;
      button.classList.toggle('active', isActive);
      button.classList.toggle('seg-active', isActive);
      if (isActive) button.setAttribute('data-active', 'true');
      else button.removeAttribute('data-active');
    });
  }

  function setPlaybackRate(rate, notify = true) {
    const nextRate = String(rate);
    if (playbackRateSelect) playbackRateSelect.value = nextRate;
    playbackRateButtons.forEach((button) => {
      const isActive = button.dataset.rate === nextRate;
      button.classList.toggle('active', isActive);
      button.classList.toggle('seg-active', isActive);
      if (isActive) button.setAttribute('data-active', 'true');
      else button.removeAttribute('data-active');
    });
    if (notify && playbackRateSelect) {
      playbackRateSelect.dispatchEvent(new Event('change', { bubbles: true }));
    }
  }

  function applyParams(params) {
    if (params.frameOffset !== undefined) setOffset(params.frameOffset, false);
    if (params.threshold !== undefined) setThreshold(params.threshold, false);
    if (params.trailLength !== undefined) setTrailLength(params.trailLength, false);
    if (params.channelSpread !== undefined) setChannelSpread(params.channelSpread, false);
    if (params.algorithm !== undefined) setAlgorithm(params.algorithm, false);
    if (params.blurEnabled !== undefined) setBlurEnabled(params.blurEnabled, false);
    if (params.ageColorEnabled !== undefined) setAgeColorEnabled(params.ageColorEnabled, false);
    if (params.rgbTintR !== undefined) setRgbTint('rgbTintR', params.rgbTintR, false);
    if (params.rgbTintG !== undefined) setRgbTint('rgbTintG', params.rgbTintG, false);
    if (params.rgbTintB !== undefined) setRgbTint('rgbTintB', params.rgbTintB, false);
    if (params.ageColorNew !== undefined) setAgeGradient('ageColorNew', params.ageColorNew, false);
    if (params.ageColorOld !== undefined) setAgeGradient('ageColorOld', params.ageColorOld, false);
    if (params.processingWidth !== undefined) setProcessingWidth(params.processingWidth, false);
    if (params.fpsCap !== undefined) setFpsCap(params.fpsCap, false);
    if (params.magAmp !== undefined) setMagAmp(params.magAmp, false);
    if (params.magFreqLow !== undefined) setMagFreqLow(params.magFreqLow, false);
    if (params.magFreqHigh !== undefined) setMagFreqHigh(params.magFreqHigh, false);
    if (params.magChroma !== undefined) setMagChroma(params.magChroma, false);
    if (params.magDownsample !== undefined) setMagDownsample(params.magDownsample, false);
  }

  if (btnCamera) {
    btnCamera.hidden = !navigator.mediaDevices?.getUserMedia;
    btnCamera.addEventListener('click', () => {
      clearActivePresetButton();
      if (onCameraLoad) onCameraLoad();
    });
  }

  if (cameraFlipBtn) {
    cameraFlipBtn.hidden = true;
    cameraFlipBtn.addEventListener('click', () => {
      if (onCameraFlip) onCameraFlip();
    });
  }

  if (btnScreen) {
    btnScreen.hidden = !navigator.mediaDevices?.getDisplayMedia;
    btnScreen.addEventListener('click', () => {
      clearActivePresetButton();
      if (onScreenLoad) onScreenLoad();
    });
  }

  if (theaterToggleBtn) {
    theaterToggleBtn.hidden = true;
    theaterToggleBtn.addEventListener('click', () => {
      if (onToggleTheater) onToggleTheater();
    });
  }

  fileInput.addEventListener('change', (e) => {
    clearActivePresetButton();
    const file = e.target.files?.[0];
    if (file) onFileLoad(file);
  });

  loadUrlBtn.addEventListener('click', () => {
    clearActivePresetButton();
    const url = urlInput.value.trim();
    if (url) onUrlLoad(url);
  });

  urlInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      clearActivePresetButton();
      const url = urlInput.value.trim();
      if (url) onUrlLoad(url);
    }
  });

  sliderOffset.addEventListener('input', () => {
    setOffset(sliderOffset.value);
  });

  sliderThreshold.addEventListener('input', () => {
    setThreshold(sliderThreshold.value);
  });

  sliderTrail.addEventListener('input', () => {
    setTrailLength(sliderTrail.value);
  });

  sliderSpread.addEventListener('input', () => {
    setChannelSpread(sliderSpread.value);
  });

  sliderMagAmp?.addEventListener('input', () => {
    setMagAmp(sliderMagAmp.value);
  });

  sliderMagFreqLow?.addEventListener('input', () => {
    setMagFreqLow(sliderMagFreqLow.value);
  });

  sliderMagFreqHigh?.addEventListener('input', () => {
    setMagFreqHigh(sliderMagFreqHigh.value);
  });

  sliderMagChroma?.addEventListener('input', () => {
    setMagChroma(sliderMagChroma.value);
  });

  selectMagDownsample?.addEventListener('change', () => {
    setMagDownsample(selectMagDownsample.value);
  });

  selectResolution?.addEventListener('change', () => {
    setProcessingWidth(selectResolution.value);
  });
  selectFpsCap?.addEventListener('change', () => {
    setFpsCap(selectFpsCap.value);
  });

  themeToggle?.addEventListener('click', () => {
    applyTheme(getTheme() === 'light' ? 'dark' : 'light');
  });

  btnAlgo?.addEventListener('click', (event) => {
    const target = event.target.closest('[data-algorithm]');
    if (!target) return;
    setAlgorithm(target.dataset.algorithm);
  });

  btnBlur?.addEventListener('change', () => {
    setBlurEnabled(btnBlur.checked);
  });

  btnAgeColor?.addEventListener('change', () => {
    if (state.algorithm !== 'posy') return;
    setAgeColorEnabled(btnAgeColor.checked);
  });

  btnDisplay?.addEventListener('click', (event) => {
    const target = event.target.closest('[data-mode]');
    if (!target) return;
    const mode = target.dataset.mode;
    setDisplayMode(mode);
    if (onDisplayModeChange) onDisplayModeChange(mode);
  });

  playbackRateControl?.addEventListener('click', (event) => {
    const target = event.target.closest('[data-rate]');
    if (!target) return;
    setPlaybackRate(target.dataset.rate);
  });

  btnRecord?.addEventListener('click', () => {
    if (onParams?.onRecordToggle) onParams.onRecordToggle();
  });

  autoConfigBtn?.addEventListener('click', () => {
    if (onAutoConfigure) onAutoConfigure();
  });

  const container = document.getElementById('presetClips');
  if (container) {
    const buttons = container.querySelectorAll('.preset-btn');
    buttons.forEach((btn) => {
      const url = btn.getAttribute('data-url');
      if (url) {
        btn.addEventListener('click', () => {
          setActivePresetButton(btn);
          urlInput.value = url;
          onUrlLoad(url);
        });
      }
    });
  }

  if (statusEl) {
    const observer = new MutationObserver(() => {
      updatePresetLoadingState();
    });
    observer.observe(statusEl, {
      attributes: true,
      attributeFilter: ['class'],
      childList: true,
      characterData: true,
      subtree: true,
    });
  }

  function setPlaying() {
    state.playing = true;
    if (dotOriginal) dotOriginal.classList.add('active');
    if (dotDiff) dotDiff.classList.add('active');
    if (placeholderOriginal) placeholderOriginal.style.display = 'none';
    if (placeholderDiff) placeholderDiff.style.display = 'none';
  }

  function setPaused() {
    state.playing = false;
    if (dotOriginal) dotOriginal.classList.remove('active');
    if (dotDiff) dotDiff.classList.remove('active');
  }

  function showPlaceholders() {
    if (placeholderOriginal) placeholderOriginal.style.display = 'flex';
    if (placeholderDiff) placeholderDiff.style.display = 'flex';
    if (dotOriginal) dotOriginal.classList.remove('active');
    if (dotDiff) dotDiff.classList.remove('active');
  }

  pickrs.rgbTintR = createColorPickr('rgbTintR', state.rgbTintR, (hex) => {
    setRgbTint('rgbTintR', hex);
  });
  pickrs.rgbTintG = createColorPickr('rgbTintG', state.rgbTintG, (hex) => {
    setRgbTint('rgbTintG', hex);
  });
  pickrs.rgbTintB = createColorPickr('rgbTintB', state.rgbTintB, (hex) => {
    setRgbTint('rgbTintB', hex);
  });
  pickrs.ageColorNew = createColorPickr('ageColorNew', state.ageColorNew, (hex) => {
    setAgeGradient('ageColorNew', hex);
  });
  pickrs.ageColorOld = createColorPickr('ageColorOld', state.ageColorOld, (hex) => {
    setAgeGradient('ageColorOld', hex);
  });

  setRgbTint('rgbTintR', state.rgbTintR, false);
  setRgbTint('rgbTintG', state.rgbTintG, false);
  setRgbTint('rgbTintB', state.rgbTintB, false);
  setAgeGradient('ageColorNew', state.ageColorNew, false);
  setAgeGradient('ageColorOld', state.ageColorOld, false);
  setAlgorithm(state.algorithm, false);
  setBlurEnabled(state.blurEnabled, false);
  setAgeColorEnabled(state.ageColorEnabled, false);
  setMagAmp(state.magAmp, false);
  setMagFreqLow(state.magFreqLow, false);
  setMagFreqHigh(state.magFreqHigh, false);
  setMagChroma(state.magChroma, false);
  setMagDownsample(state.magDownsample, false);
  setDisplayMode(state.displayMode);
  setPlaybackRate(playbackRateSelect?.value || '1', false);
  rangeInputs.forEach((input) => {
    setRangeFill(input);
    input.addEventListener('input', () => {
      setRangeFill(input);
    });
    input.addEventListener('change', () => {
      setRangeFill(input);
    });
  });
  updateThemeButton();
  updateRgbTintVisibility();
  updateAgeColorVisibility();
  updatePerformanceStatus();
  setFpsCap(state.fpsCap, false);
  if (selectResolution) selectResolution.value = String(state.processingWidth);

  return {
    state,
    setOffset,
    setThreshold,
    setTrailLength,
    setChannelSpread,
    setAlgorithm,
    setBlurEnabled,
    setAgeColorEnabled,
    setDisplayMode,
    setRgbTint,
    setAgeGradient,
    setProcessingWidth,
    setFpsCap,
    setMagAmp,
    setMagFreqLow,
    setMagFreqHigh,
    setMagChroma,
    setMagDownsample,
    setMagnifyAvailable,
    applyParams,
    setAutoBusy(isBusy) {
      if (!autoConfigBtn) return;
      autoConfigBtn.disabled = isBusy;
      autoConfigBtn.textContent = isBusy ? 'Auto...' : 'Auto';
    },
    setRecordEnabled(enabled) {
      if (!btnRecord) return;
      btnRecord.disabled = !enabled;
    },
    setRecording(isRecording) {
      if (!btnRecord) return;
      btnRecord.textContent = isRecording ? 'Stop' : 'Record';
      btnRecord.classList.toggle('recording', isRecording);
    },
    setCameraFlipVisible(visible) {
      if (!cameraFlipBtn) return;
      cameraFlipBtn.hidden = !visible;
    },
    setTheaterToggleVisible(visible) {
      if (!theaterToggleBtn) return;
      theaterToggleBtn.hidden = !visible;
    },
    setTheaterActive(isActive) {
      if (!theaterToggleBtn) return;
      theaterToggleBtn.setAttribute('aria-pressed', isActive ? 'true' : 'false');
      theaterToggleBtn.title = isActive ? 'Collapse motion diff' : 'Expand motion diff';
    },
    setPlaying,
    setPaused,
    showPlaceholders,
    get placeholderOriginal() { return placeholderOriginal; },
    get placeholderDiff() { return placeholderDiff; },
  };
}
