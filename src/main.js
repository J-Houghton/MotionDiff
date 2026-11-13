import { Pipeline, debugEnergyParity } from './app/pipeline.js';
import { AudioEngine } from './app/audio.js';
import { attachHlsSource, isDashUrl, isHlsUrl, isYouTubeUrl } from './app/loader.js';
import { CanvasRecorder } from './app/exporter.js';
import { render, renderBlank, renderMagnify } from './app/renderer.js';
import { buildSourceProfile } from './app/source-profile.js';
import { analyzeSample } from './core/analyze.js';
import { initAudioPanel } from './ui/audio-panel.js';
import { initControls } from './ui/controls.js';
import { initHelp } from './ui/help.js';
import { initPresets } from './ui/presets.js';
import { initColorThemes } from './ui/theme.js';
import { initTimeline } from './ui/timeline.js';
import { setStatus } from './ui/status.js';

const HAS_RVFC = 'requestVideoFrameCallback' in HTMLVideoElement.prototype;

const pipeline = new Pipeline();
const audioEngine = new AudioEngine();
const videoEl = document.getElementById('videoEl');
const canvas = document.getElementById('outputCanvas');

/**
 * In WebGL mode the pipeline owns the canvas context (WebGL2).
 * In Canvas2D fallback mode, we get a 2D context for renderer.js.
 * We defer context creation until after pipeline.init() decides the path.
 */
let outputCtx = null;

let loopRunning = false;
let animFrameId = null;
let rvfcId = null;
let videoLoaded = false;
let currentMode = 'overlay';
let activeStream = null;
let activeObjectUrl = null;
let processedFrameCount = 0;
let fpsWindowStart = 0;
let skippedFrameCount = 0;
let cameraFacingMode = 'environment';
let theaterActive = false;
const recorder = new CanvasRecorder(canvas);
const outputCanvasShell = document.getElementById('outputCanvasShell');
const theaterBackdrop = document.getElementById('theaterBackdrop');
const theaterCloseBtn = document.getElementById('theaterCloseBtn');
initHelp();
initColorThemes();
initAudioPanel({ engine: audioEngine, container: document.getElementById('audioPanel') });

function setDisplayMode(mode) {
  currentMode = mode;
  pipeline.setMode(currentMode);
}

const controls = initControls({
  onParams: { onRecordToggle: handleRecordToggle },
  onParamChange: handleParamChange,
  onFileLoad: handleFileLoad,
  onUrlLoad: handleUrlLoad,
  onDisplayModeChange: setDisplayMode,
  onAutoConfigure: handleAutoConfigure,
  onCameraLoad: handleCameraLoad,
  onCameraFlip: handleCameraFlip,
  onScreenLoad: handleScreenLoad,
  onToggleTheater: toggleTheater,
  onProcessingWidthChange: handleProcessingWidthChange,
});
const timeline = initTimeline({
  videoEl,
  onPlayPause: handlePlayPause,
  onStep: handleStepFrame,
  getFpsCap: () => controls.state.fpsCap,
  getProcessingWidth: () => controls.state.processingWidth,
});
initPresets({
  getCurrentParams: () => ({
    frameOffset: controls.state.frameOffset,
    threshold: controls.state.threshold,
    trailLength: controls.state.trailLength,
    channelSpread: controls.state.channelSpread,
    algorithm: controls.state.algorithm,
    blurEnabled: controls.state.blurEnabled,
    ageColorEnabled: controls.state.ageColorEnabled,
    rgbTintR: controls.state.rgbTintR,
    rgbTintG: controls.state.rgbTintG,
    rgbTintB: controls.state.rgbTintB,
    ageColorNew: controls.state.ageColorNew,
    ageColorOld: controls.state.ageColorOld,
    processingWidth: controls.state.processingWidth,
    fpsCap: controls.state.fpsCap,
  }),
  onPresetLoad: applyParameterPreset,
  onStatus: setStatus,
});

// ?renderer=canvas2d runs the worker fallback even where WebGL2 is available.
const forceCanvas2D = new URLSearchParams(window.location.search).get('renderer') === 'canvas2d';
pipeline.init(videoEl, canvas, { forceCanvas2D });
pipeline.setParams({
  rgbTintR: controls.state.rgbTintR,
  rgbTintG: controls.state.rgbTintG,
  rgbTintB: controls.state.rgbTintB,
  ageColorNew: controls.state.ageColorNew,
  ageColorOld: controls.state.ageColorOld,
  fpsCap: controls.state.fpsCap,
});
controls.setRecordEnabled(CanvasRecorder.isSupported(canvas));
controls.setRecording(false);

// Magnify needs render-to-float on the WebGL path; the worker fallback
// always supports it. When unavailable, disable the option (with a
// tooltip) instead of silently rendering garbage.
if (pipeline._useWebGL && pipeline._glRenderer && !pipeline._glRenderer.magnifySupported) {
  controls.setMagnifyAvailable(false);
  setStatus('Magnify mode unavailable: this GPU lacks float render support', 'info');
}

// Set initial mode on pipeline
pipeline.setMode(currentMode);

// Log frame source
console.log(`Frame source: ${HAS_RVFC ? 'requestVideoFrameCallback + VideoFrame' : 'requestAnimationFrame (fallback)'}`);

// In Canvas2D fallback mode, get the 2D context
if (!pipeline._useWebGL) {
  outputCtx = canvas.getContext('2d', { willReadFrequently: true });
}

function syncCanvasSize() {
  if (!pipeline._useWebGL) {
    canvas.width = pipeline.width;
    canvas.height = pipeline.height;
  }
}

function handleParamChange(params) {
  pipeline.setParams(params);
  if (params.fpsCap !== undefined) {
    timeline.syncNow();
  }
  if (videoLoaded && videoEl.paused) {
    processCurrentFrame();
  }
}

function handleProcessingWidthChange(width) {
  pipeline.setProcessingWidth(width);
  syncCanvasSize();
  timeline.syncNow();
  if (videoLoaded && videoEl.paused) {
    processCurrentFrame();
  }
}

function clearDiffOutput() {
  if (pipeline._useWebGL && pipeline._glRenderer) {
    pipeline._glRenderer.renderBlank(controls.state.algorithm, controls.state.ageColorEnabled);
    return;
  }
  if (!outputCtx) {
    outputCtx = canvas.getContext('2d', { willReadFrequently: true });
  }
  const width = canvas.width || pipeline.width || 1;
  const height = canvas.height || pipeline.height || 1;
  renderBlank(outputCtx, width, height, controls.state.algorithm, controls.state.ageColorEnabled);
}

function setCameraFlipVisible(visible) {
  controls.setCameraFlipVisible(visible);
}

function setTheaterActive(nextActive) {
  if (!outputCanvasShell || !theaterBackdrop || !theaterCloseBtn) return;

  theaterActive = Boolean(nextActive);
  outputCanvasShell.classList.toggle('theater-active', theaterActive);
  theaterBackdrop.hidden = !theaterActive;
  theaterCloseBtn.hidden = !theaterActive;
  controls.setTheaterActive(theaterActive);
}

function toggleTheater() {
  if (!videoLoaded || !controls.state.playing) return;
  setTheaterActive(!theaterActive);
}

function setTheaterAvailability(visible) {
  if (!visible && theaterActive) {
    setTheaterActive(false);
  }
  controls.setTheaterToggleVisible(visible);
}

function handleLoadFailure(message) {
  stopLoop();
  pipeline.stop();
  pipeline.clearState();
  clearActiveSource();
  setCameraFlipVisible(false);
  setTheaterAvailability(false);
  clearDiffOutput();
  videoLoaded = false;
  timeline.setEnabled(false);
  timeline.setPaused();
  timeline.syncNow();
  controls.setPaused();
  controls.showPlaceholders();
  videoEl.removeAttribute('src');
  videoEl.srcObject = null;
  videoEl.load();
  setStatus(message, 'error');
}

function handleFileLoad(file) {
  setCameraFlipVisible(false);
  beginSourceLoad();
  const url = URL.createObjectURL(file);
  activeObjectUrl = url;
  setStatus('Loading...', 'info');
  pipeline.setSourceProfile(buildSourceProfile('file', HAS_RVFC));
  loadVideo(url, true);
}

function handleUrlLoad(url) {
  setCameraFlipVisible(false);
  beginSourceLoad();
  setStatus('Loading...', 'info');
  pipeline.setSourceProfile(buildSourceProfile('url', HAS_RVFC));
  loadVideo(url, false);
}

async function handleCameraLoad() {
  if (!navigator.mediaDevices?.getUserMedia) return;

  try {
    setStatus('Requesting camera...', 'info');
    const stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: cameraFacingMode },
      audio: false,
    });
    setCameraFlipVisible(true);
    loadStream(stream, 'camera');
  } catch {
    setCameraFlipVisible(false);
    setStatus('Camera access denied', 'error');
  }
}

async function handleCameraFlip() {
  if (!navigator.mediaDevices?.getUserMedia || !(videoEl.srcObject instanceof MediaStream)) return;

  const previousFacingMode = cameraFacingMode;
  cameraFacingMode = cameraFacingMode === 'environment' ? 'user' : 'environment';
  videoEl.srcObject.getTracks().forEach((track) => track.stop());

  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: cameraFacingMode },
      audio: false,
    });
    setCameraFlipVisible(true);
    loadStream(stream, 'camera');
  } catch {
    cameraFacingMode = previousFacingMode;
    try {
      const fallbackStream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: previousFacingMode },
        audio: false,
      });
      setCameraFlipVisible(true);
      loadStream(fallbackStream, 'camera');
    } catch {
      beginSourceLoad();
      setCameraFlipVisible(false);
    }
    setStatus('Camera flip not available on this device', 'error');
  }
}

async function handleScreenLoad() {
  if (!navigator.mediaDevices?.getDisplayMedia) return;

  try {
    setCameraFlipVisible(false);
    setStatus('Requesting screen...', 'info');
    const stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false });
    loadStream(stream, 'screen');
  } catch {
    setStatus('Screen capture cancelled', 'error');
  }
}

function beginSourceLoad() {
  if (recorder.isRecording()) {
    void stopRecording();
  }

  setTheaterAvailability(false);
  stopLoop();
  videoLoaded = false;
  timeline.setEnabled(false);
  timeline.setPaused();
  timeline.syncNow();
  controls.setPaused();
  const attachedStream = videoEl.srcObject instanceof MediaStream ? videoEl.srcObject : null;
  if (attachedStream) {
    attachedStream.getTracks().forEach((track) => track.stop());
    if (activeStream === attachedStream) {
      activeStream = null;
    }
  }

  clearActiveSource();
  videoEl.srcObject = null;
  videoEl.removeAttribute('src');
  videoEl.load();
}

function clearActiveSource() {
  pipeline.clearExternalResources();

  if (activeStream) {
    activeStream.getTracks().forEach((track) => track.stop());
    activeStream = null;
  }

  if (activeObjectUrl) {
    URL.revokeObjectURL(activeObjectUrl);
    activeObjectUrl = null;
  }
}

function loadVideo(src, isLocal) {
  if (!isLocal && isYouTubeUrl(src)) {
    handleLoadFailure('YouTube URLs are not supported directly — use yt-dlp to download or extract a direct media URL');
    return;
  }

  if (!isLocal && isDashUrl(src)) {
    handleLoadFailure('DASH not supported in this build');
    return;
  }

  if (!isLocal && isHlsUrl(src)) {
    loadHlsVideo(src);
    return;
  }

  pipeline.setSourceProfile(buildSourceProfile(isLocal ? 'file' : 'url', HAS_RVFC));

  if (isLocal) {
    videoEl.removeAttribute('crossOrigin');
  } else {
    videoEl.crossOrigin = 'anonymous';
  }

  videoEl.src = src;
  videoEl.muted = true;
  videoEl.loop = true;
  videoEl.playsInline = true;

  const onLoadedMetadata = () => {
    cleanup();
    onVideoReady();
  };

  const onError = () => {
    cleanup();
    if (!isLocal) {
      const proxied = `https://corsproxy.io/?${encodeURIComponent(src)}`;
      setStatus('Retrying via CORS proxy...', 'info');
      videoEl.crossOrigin = 'anonymous';
      videoEl.src = proxied;

      const onLoadedMetadataProxy = () => { cleanupProxy(); onVideoReady(); };
      const onErrorProxy = () => {
        cleanupProxy();
        handleLoadFailure('\u2717 Failed \u2014 check URL');
      };
      const cleanupProxy = () => {
        videoEl.removeEventListener('loadedmetadata', onLoadedMetadataProxy);
        videoEl.removeEventListener('error', onErrorProxy);
      };
      videoEl.addEventListener('loadedmetadata', onLoadedMetadataProxy);
      videoEl.addEventListener('error', onErrorProxy);
      videoEl.load();
    } else {
      handleLoadFailure('\u2717 Failed to load file');
    }
  };

  const cleanup = () => {
    videoEl.removeEventListener('loadedmetadata', onLoadedMetadata);
    videoEl.removeEventListener('error', onError);
  };

  videoEl.addEventListener('loadedmetadata', onLoadedMetadata);
  videoEl.addEventListener('error', onError);
  videoEl.load();
}

async function loadHlsVideo(src) {
  pipeline.setSourceProfile(buildSourceProfile('hls', HAS_RVFC));
  videoEl.crossOrigin = 'anonymous';
  videoEl.muted = true;
  videoEl.loop = true;
  videoEl.playsInline = true;

  const onLoadedMetadata = () => {
    cleanup();
    onVideoReady('\u2713 Loaded [HLS]');
  };

  const onError = () => {
    cleanup();
    pipeline.clearExternalResources();
    handleLoadFailure('\u2717 Failed to load HLS stream');
  };

  const cleanup = () => {
    videoEl.removeEventListener('loadedmetadata', onLoadedMetadata);
    videoEl.removeEventListener('error', onError);
  };

  videoEl.addEventListener('loadedmetadata', onLoadedMetadata);
  videoEl.addEventListener('error', onError);

  try {
    await attachHlsSource(src, videoEl, pipeline);
  } catch (error) {
    cleanup();
    pipeline.clearExternalResources();
    handleLoadFailure(`\u2717 ${error.message}`);
  }
}

function loadStream(stream, sourceKind) {
  beginSourceLoad();
  pipeline.setSourceProfile(buildSourceProfile(sourceKind, HAS_RVFC));
  setCameraFlipVisible(sourceKind === 'camera');

  activeStream = stream;
  videoEl.removeAttribute('crossOrigin');
  videoEl.autoplay = true;
  videoEl.muted = true;
  videoEl.defaultMuted = true;
  videoEl.loop = false;
  videoEl.playsInline = true;
  videoEl.srcObject = stream;

  if (import.meta.env.DEV) {
    const track = stream.getVideoTracks()[0];
    console.log('[MotionDiff] stream attach', {
      kind: sourceKind,
      label: track?.label,
      readyState: track?.readyState,
      settings: track?.getSettings?.(),
    });
    videoEl.addEventListener('loadedmetadata', () => {
      console.log('[MotionDiff] loadedmetadata', {
        videoWidth: videoEl.videoWidth,
        videoHeight: videoEl.videoHeight,
      });
    }, { once: true });
  }

  let waitingForResize = false;
  const onResize = () => {
    if (videoEl.srcObject !== stream) {
      cleanup();
      return;
    }
    cleanup();
    onVideoReady();
  };

  const onLoadedMetadata = () => {
    if (videoEl.srcObject !== stream) {
      cleanup();
      return;
    }
    videoEl.removeEventListener('loadedmetadata', onLoadedMetadata);
    if (videoEl.videoWidth === 0 || videoEl.videoHeight === 0) {
      waitingForResize = true;
      videoEl.addEventListener('resize', onResize, { once: true });
      return;
    }

    cleanup();
    onVideoReady();
  };

  const onError = (event) => {
    if (videoEl.srcObject !== stream) {
      cleanup();
      return;
    }
    cleanup();
    const message = event?.message ?? event?.error?.message ?? 'unknown';
    setStatus(`Stream error: ${message}`, 'error');
    pipeline.clearState();
  };

  const cleanup = () => {
    waitingForResize = false;
    videoEl.removeEventListener('loadedmetadata', onLoadedMetadata);
    videoEl.removeEventListener('resize', onResize);
    videoEl.removeEventListener('error', onError);
  };

  videoEl.addEventListener('loadedmetadata', onLoadedMetadata);
  videoEl.addEventListener('error', onError);

  if (sourceKind === 'screen') {
    stream.getVideoTracks()[0]?.addEventListener('ended', () => {
      if (activeStream !== stream) return;
      activeStream = null;
      setTheaterAvailability(false);
      setStatus('Screen share ended', 'idle');
      pipeline.stop();
      pipeline.clearState();
    });
  }
}

function onVideoReady(loadedMessage = '\u2713 Loaded') {
  videoLoaded = true;
  pipeline.updateDimensions(videoEl);

  // In Canvas2D fallback, we manually set canvas dimensions
  // (WebGL path sets them inside pipeline.updateDimensions → glRenderer.setSize)
  if (!pipeline._useWebGL) {
    canvas.width = pipeline.width;
    canvas.height = pipeline.height;
  }

  setStatus(loadedMessage, 'success');
  timeline.setEnabled(true);
  timeline.syncNow();
  setTheaterAvailability(false);

  videoEl.play().then(() => {
    controls.setPlaying();
    timeline.setPlaying();
    setTheaterAvailability(true);
    startLoop();
  }).catch(() => {
    setStatus(`${loadedMessage} \u2014 press play`, 'success');
    controls.setPaused();
    timeline.setPaused();
    timeline.setEnabled(true);
    setTheaterAvailability(false);
    if (controls.placeholderOriginal) controls.placeholderOriginal.style.display = 'none';
    if (controls.placeholderDiff)     controls.placeholderDiff.style.display = 'none';
    processCurrentFrame();
  });
}

function handlePlayPause() {
  if (!videoLoaded) return;
  if (videoEl.paused) {
    videoEl.play().then(() => {
      controls.setPlaying();
      timeline.setPlaying();
      setTheaterAvailability(true);
      startLoop();
    });
  } else {
    videoEl.pause();
    controls.setPaused();
    timeline.setPaused();
    setTheaterAvailability(false);
    stopLoop();
  }
}

function handleStepFrame(deltaSeconds) {
  if (!videoLoaded) return;

  if (!videoEl.paused) {
    videoEl.pause();
    controls.setPaused();
    timeline.setPaused();
    setTheaterAvailability(false);
    stopLoop();
  }

  const duration = Number.isFinite(videoEl.duration) ? videoEl.duration : 0;
  const nextTime = Math.min(Math.max(videoEl.currentTime + deltaSeconds, 0), duration || 0);
  if (nextTime === videoEl.currentTime) {
    processCurrentFrame();
    return;
  }

  videoEl.currentTime = nextTime;
}

function applyParameterPreset(params, name, source) {
  controls.applyParams(params);
  if (params.processingWidth !== undefined) {
    pipeline.setProcessingWidth(params.processingWidth);
    syncCanvasSize();
  }
  pipeline.setParams(params);
  timeline.syncNow();

  if (videoLoaded) {
    processCurrentFrame();
  }

  const prefix = source === 'user' ? 'Loaded saved preset' : 'Preset';
  setStatus(`${prefix}: ${name}`, 'success');
}

async function handleRecordToggle() {
  if (!videoLoaded) {
    setStatus('Load a video first', 'error');
    return;
  }

  if (!CanvasRecorder.isSupported(canvas)) {
    setStatus('Recording is not supported in this browser.', 'error');
    return;
  }

  if (recorder.isRecording()) {
    await stopRecording();
    return;
  }

  try {
    recorder.start();
    controls.setRecording(true);
    setStatus('Recording...', 'success');
  } catch (error) {
    controls.setRecording(false);
    setStatus(error.message, 'error');
  }
}

async function stopRecording() {
  const result = await recorder.stop();
  controls.setRecording(false);
  if (result?.filename) {
    setStatus(`Saved: ${result.filename}`, 'success');
  }
}

async function handleAutoConfigure() {
  if (!videoLoaded) {
    setStatus('Load a video first', 'error');
    return;
  }

  const wasPaused = videoEl.paused;
  const originalRate = videoEl.playbackRate;

  controls.setAutoBusy(true);
  stopLoop();
  if (!videoEl.paused) {
    videoEl.pause();
  }
  controls.setPaused();
  timeline.setPaused();

  try {
    const frames = await pipeline.sampleFrames(videoEl, 30);
    const { frameOffset, threshold } = analyzeSample(frames, timeline.getFPS());

    controls.applyParams({ frameOffset, threshold });
    pipeline.setParams({ frameOffset, threshold });
    processCurrentFrame();

    setStatus(`Auto-configured: offset=${frameOffset} threshold=${threshold}`, 'success');

    if (!wasPaused) {
      videoEl.playbackRate = originalRate;
      await videoEl.play();
      controls.setPlaying();
      timeline.setPlaying();
      startLoop();
    }
  } catch (error) {
    setStatus(`Auto-config failed: ${error.message}`, 'error');
  } finally {
    controls.setAutoBusy(false);
    timeline.syncNow();
  }
}

// Canvas 2D fallback: Worker sends results via callback
pipeline.onResult = (result) => {
  if (!loopRunning || !videoLoaded) return;
  if (pipeline._useWebGL) return; // WebGL renders directly in process()

  if (result && result.magnified) {
    renderMagnify(result.magnified, outputCtx, canvas.width, canvas.height);
    return;
  }

  if (result && result.accumulated) {
    render(currentMode, result.accumulated, result.currentFrame, outputCtx, pipeline.width, pipeline.height, controls.state.algorithm, controls.state.ageColorEnabled);
  } else if (result && result.currentFrame) {
    render(currentMode, null, result.currentFrame, outputCtx, pipeline.width, pipeline.height, controls.state.algorithm, controls.state.ageColorEnabled);
  }
};

function processCurrentFrame() {
  pipeline.setParams({
    frameOffset: controls.state.frameOffset,
    threshold: controls.state.threshold,
    trailLength: controls.state.trailLength,
    channelSpread: controls.state.channelSpread,
    algorithm: controls.state.algorithm,
    blurEnabled: controls.state.blurEnabled,
    ageColorEnabled: controls.state.ageColorEnabled,
    rgbTintR: controls.state.rgbTintR,
    rgbTintG: controls.state.rgbTintG,
    rgbTintB: controls.state.rgbTintB,
    ageColorNew: controls.state.ageColorNew,
    ageColorOld: controls.state.ageColorOld,
    fpsCap: controls.state.fpsCap,
    magAmp: controls.state.magAmp,
    magFreqLow: controls.state.magFreqLow,
    magFreqHigh: controls.state.magFreqHigh,
    magChroma: controls.state.magChroma,
    magDownsample: controls.state.magDownsample,
  });

  pipeline.process(videoEl);

  // One audio update per processed frame. gridCols is 0 unless the engine is
  // running, and the pipeline skips the readback entirely at 0.
  const grid = pipeline.getEnergyGrid(audioEngine.gridCols, audioEngine.gridRows);
  if (grid) audioEngine.update(grid);
}

function tick() {
  if (!loopRunning || !videoLoaded) return;
  processCurrentFrame();
}

function resetFrameMetrics() {
  pipeline._lastFrameTime = 0;
  processedFrameCount = 0;
  fpsWindowStart = 0;
  skippedFrameCount = 0;
}

function shouldSkipFrame(now) {
  const { fpsCap } = pipeline.params;
  if (!fpsCap) return false;
  const minInterval = 1000 / fpsCap;
  if (pipeline._lastFrameTime > 0 && now - pipeline._lastFrameTime < minInterval) {
    skippedFrameCount += 1;
    return true;
  }
  pipeline._lastFrameTime = now;
  return false;
}

function noteProcessedFrame(now) {
  if (!import.meta.env.DEV) return;
  processedFrameCount += 1;
  if (fpsWindowStart === 0) {
    fpsWindowStart = now;
    return;
  }
  if (processedFrameCount % 60 === 0) {
    const elapsed = now - fpsWindowStart;
    const measuredFps = elapsed > 0 ? 60000 / elapsed : 0;
    const skippedSuffix = skippedFrameCount ? ` (skipped ${skippedFrameCount})` : '';
    console.log(`FPS: ${measuredFps.toFixed(1)}${skippedSuffix}`);
    fpsWindowStart = now;
    skippedFrameCount = 0;
  }
}

function rvfcTick(now) {
  if (!shouldSkipFrame(now)) {
    tick();
    noteProcessedFrame(now);
  }
  if (loopRunning) {
    rvfcId = videoEl.requestVideoFrameCallback(rvfcTick);
  }
}

function rafTick(now) {
  if (!shouldSkipFrame(now)) {
    tick();
    noteProcessedFrame(now);
  }
  if (loopRunning) {
    animFrameId = requestAnimationFrame(rafTick);
  }
}

function startLoop() {
  if (loopRunning) return;
  loopRunning = true;
  resetFrameMetrics();
  // The AudioContext already has its gesture; this only un-pauses the voices.
  if (audioEngine.params.enabled) audioEngine.start();

  if (HAS_RVFC) {
    rvfcId = videoEl.requestVideoFrameCallback(rvfcTick);
  } else {
    animFrameId = requestAnimationFrame(rafTick);
  }
}

function stopLoop() {
  loopRunning = false;
  resetFrameMetrics();
  // No frames means no energy updates — fade out instead of holding a drone.
  audioEngine.stop();
  if (animFrameId !== null) {
    cancelAnimationFrame(animFrameId);
    animFrameId = null;
  }
  if (rvfcId !== null && HAS_RVFC) {
    videoEl.cancelVideoFrameCallback(rvfcId);
    rvfcId = null;
  }
}

document.addEventListener('visibilitychange', () => {
  if (!videoLoaded) return;
  if (document.hidden) {
    if (!videoEl.paused) {
      videoEl.pause();
      stopLoop();
      videoEl.dataset.autoPaused = 'true';
      controls.setPaused();
      timeline.setPaused();
      setTheaterAvailability(false);
    }
  } else {
    if (videoEl.dataset.autoPaused === 'true') {
      delete videoEl.dataset.autoPaused;
      videoEl.play().then(() => {
        controls.setPlaying();
        timeline.setPlaying();
        setTheaterAvailability(true);
        startLoop();
      });
    }
  }
});

theaterCloseBtn?.addEventListener('click', () => {
  setTheaterActive(false);
});

theaterBackdrop?.addEventListener('click', () => {
  setTheaterActive(false);
});

document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && theaterActive) {
    setTheaterActive(false);
  }
});

window.addEventListener('pagehide', () => {
  audioEngine.dispose();
});

if (import.meta.env.DEV) {
  // SPEC-sonification A6: compare the WebGL readback against the core math.
  window.__motionDiffEnergyParity = (cols, rows) => debugEnergyParity(pipeline, cols, rows);
}

videoEl.addEventListener('seeked', () => {
  timeline.syncNow();
  if (videoLoaded && videoEl.paused) {
    processCurrentFrame();
  }
});
