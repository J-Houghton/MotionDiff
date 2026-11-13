/**
 * Session: everything the app does that is not interface.
 *
 * Owns the video element, the pipeline, the frame loop, sources (file, URL,
 * HLS, camera, screen), transport, export and the audio engine, and reports
 * what changed through `on()`. The UI calls methods here and redraws from
 * the state it reads back; nothing in this file touches a control.
 */
import { Pipeline } from './pipeline.js';
import { AudioEngine } from './audio.js';
import { attachHlsSource, isDashUrl, isHlsUrl, isYouTubeUrl } from './loader.js';
import { CanvasRecorder } from './exporter.js';
import { render, renderBlank, renderMagnify } from './renderer.js';
import { buildSourceProfile } from './source-profile.js';
import { getMode } from './modes/index.js';
import { analyzeSample } from '../core/analyze.js';

/**
 * Defaults for phones: a smaller picture to process and a third of the
 * desktop frame-ring budget (phones share memory between CPU and GPU).
 * At 480x270 that is still the full 120 frames; a 480x640 portrait camera
 * feed gets 52.
 */
export const PHONE_DEFAULTS = { processWidth: 480, ringBudgetBytes: 64 * 1024 * 1024 };

const HAS_RVFC = 'requestVideoFrameCallback' in HTMLVideoElement.prototype;
const DEFAULT_FPS = 30;

/**
 * After a paused seek, frame-callback metadata further than this from
 * currentTime describes some other frame (browsers can deliver a stale one
 * when nothing was being presented); the stamp then comes from currentTime.
 */
const STALE_FRAME_META_S = 0.25;
/** How long to wait for a frame callback after a paused seek. */
const SEEK_FRAME_WAIT_MS = 250;
/**
 * Frame callbacks are the best clock (exact media time per frame) but they
 * are not guaranteed: they arrive only while the browser is presenting the
 * video, and stall for a second or two while a decoder starts or recovers
 * from a seek. So they are used only while they flow. After a gap longer
 * than this between two of them, frames are taken on the display clock
 * (whenever the decoder's frame counter moves) until this many callbacks
 * arrive on time in a row.
 *
 * Measured in headless Chrome: with the video transparent (the normal state
 * here) callbacks flow at the source rate once playback has warmed up.
 * Whether every browser keeps calling back for a video nobody can see is not
 * something this code relies on.
 */
const FRAME_CALLBACK_STALL_MS = 120;
const FRAME_CALLBACK_HEALTHY = 4;

export class Session {
  /**
   * @param {object} options
   * @param {HTMLVideoElement} options.video
   * @param {HTMLCanvasElement} options.canvas
   * @param {boolean} [options.forceCanvas2D]
   * @param {boolean} [options.noFloat]
   * @param {number} [options.processWidth]
   * @param {number} [options.ringBudgetBytes]
   */
  constructor(options) {
    this.video = options.video;
    this.canvas = options.canvas;
    this.pipeline = new Pipeline();
    this.audio = new AudioEngine();
    this.recorder = new CanvasRecorder(this.canvas);

    this.loaded = false;
    this.playing = false;
    this.recording = false;
    this.busy = false;
    /** @type {{kind: string, label: string}|null} */
    this.source = null;
    this.display = 'overlay';
    this.fps = DEFAULT_FPS;
    this.status = { message: '', type: 'idle' };

    this._listeners = new Set();
    this._loopRunning = false;
    this._rafId = null;
    this._rvfcId = null;
    this._lastTickMs = 0;
    this._lastCallbackMs = 0;
    this._callbackRun = 0;      // frame callbacks that arrived on time, in a row
    this._watchdogFrame = -1;   // decoder frame count at the last display-clock frame
    this._fpsProbe = null;
    this._frameDeltas = [];
    this._lastMediaTime = NaN;
    this._stream = null;
    this._objectUrl = null;
    this._facingMode = 'environment';
    this._seekToken = 0;
    this._sampling = false;
    this._toolStepping = false;
    this._ctx2d = null;

    const { pipeline, video, canvas } = this;
    pipeline.init(video, canvas, options);
    pipeline.setMode(this.display);
    pipeline.onStatus = (message, type) => this.setStatus(message, type);
    this.width = pipeline._processWidth;
    this.webgl = pipeline._useWebGL;
    this.floatTargets = this.webgl ? pipeline._glRenderer.floatTargets : true;
    if (!this.webgl) this._ctx2d = canvas.getContext('2d', { willReadFrequently: true });
    console.log(`Frame source: ${HAS_RVFC ? 'requestVideoFrameCallback' : 'requestAnimationFrame (fallback)'}`);

    // Canvas 2D fallback: the worker sends each result back for compositing.
    pipeline.onResult = (result) => this._drawWorkerResult(result);

    video.addEventListener('seeked', () => this._onSeeked());
    video.addEventListener('ended', () => { if (!video.loop) this._setPlaying(false); });
    document.addEventListener('visibilitychange', () => this._onVisibility());
    window.addEventListener('pagehide', () => this.audio.dispose());
  }

  // ── Events ──────────────────────────────────────────────────

  /**
   * Subscribe to changes. `event` is one of 'status', 'source', 'play',
   * 'params', 'display', 'recording', 'busy', 'time'.
   * @param {(event: string) => void} listener
   */
  on(listener) {
    this._listeners.add(listener);
  }

  _emit(event) {
    for (const listener of this._listeners) listener(event);
  }

  setStatus(message, type = 'info') {
    this.status = { message, type };
    this._emit('status');
  }

  // ── Params, mode, display ───────────────────────────────────

  get params() { return this.pipeline.params; }

  get mode() { return getMode(this.pipeline.params.algorithm); }

  /** Why the active mode cannot run here, or null. */
  modeProblem(mode = this.mode) {
    if (!this.webgl && !mode.worker) return `${mode.label} needs WebGL2`;
    if (this.webgl && mode.needsFloat && !this.floatTargets) return `${mode.label} needs float render targets, which this GPU lacks`;
    return null;
  }

  setParams(params) {
    this.pipeline.setParams(params);
    if (params.algorithm !== undefined) {
      const problem = this.modeProblem();
      if (problem) this.setStatus(problem, 'error');
    }
    this._emit('params');
    this._redrawIfPaused();
  }

  /** @param {'diff'|'overlay'|'glow'|'data'} display */
  setDisplay(display) {
    this.display = display;
    this.pipeline.setMode(display);
    this._emit('display');
    this._redrawIfPaused();
  }

  setWidth(width) {
    this.pipeline.setProcessingWidth(width);
    this.width = this.pipeline._processWidth;
    this._syncCanvasSize();
    this._emit('params');
    this._redrawIfPaused();
  }

  _redrawIfPaused() {
    if (this.loaded && this.video.paused) this._process();
  }

  _syncCanvasSize() {
    if (this.webgl) return;
    this.canvas.width = this.pipeline.width || 1;
    this.canvas.height = this.pipeline.height || 1;
  }

  // ── Sources ─────────────────────────────────────────────────

  get isLive() {
    return !Number.isFinite(this.video.duration) || this.video.duration <= 0;
  }

  loadFile(file) {
    this._beginLoad();
    this._objectUrl = URL.createObjectURL(file);
    this.setStatus('Loading…', 'info');
    this._pendingSource = { kind: 'file', label: file.name };
    return this._loadVideo(this._objectUrl, true);
  }

  loadUrl(url) {
    this._beginLoad();
    this.setStatus('Loading…', 'info');
    this._pendingSource = { kind: 'url', label: url.split('/').pop().split('?')[0] || url };
    return this._loadVideo(url, false);
  }

  async loadCamera() {
    if (!navigator.mediaDevices?.getUserMedia) {
      this.setStatus('This browser has no camera access (it needs HTTPS)', 'error');
      return;
    }
    try {
      this.setStatus('Requesting camera…', 'info');
      const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: this._facingMode }, audio: false });
      await this._loadStream(stream, 'camera');
    } catch {
      this.setStatus('Camera access denied', 'error');
    }
  }

  async flipCamera() {
    if (this.source?.kind !== 'camera') return;
    const previous = this._facingMode;
    this._facingMode = previous === 'environment' ? 'user' : 'environment';
    this.video.srcObject?.getTracks?.().forEach((track) => track.stop());
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: this._facingMode }, audio: false });
      await this._loadStream(stream, 'camera');
    } catch {
      this._facingMode = previous;
      this.setStatus('This device has no other camera', 'error');
      await this.loadCamera();
    }
  }

  async loadScreen() {
    if (!navigator.mediaDevices?.getDisplayMedia) {
      this.setStatus('Screen capture is not available in this browser', 'error');
      return;
    }
    try {
      this.setStatus('Requesting screen…', 'info');
      const stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false });
      await this._loadStream(stream, 'screen');
    } catch {
      this.setStatus('Screen capture cancelled', 'error');
    }
  }

  /** Tear down whatever is loading or playing. */
  _beginLoad() {
    if (this.recorder.isRecording()) void this.toggleRecord();
    this._stopLoop();
    this.loaded = false;
    this._setPlaying(false);

    this.pipeline.clearExternalResources();
    const attached = this.video.srcObject instanceof MediaStream ? this.video.srcObject : null;
    for (const stream of new Set([attached, this._stream])) stream?.getTracks().forEach((track) => track.stop());
    this._stream = null;
    if (this._objectUrl) {
      URL.revokeObjectURL(this._objectUrl);
      this._objectUrl = null;
    }
    this.video.srcObject = null;
    this.video.removeAttribute('src');
    this.video.load();
  }

  _fail(message) {
    this._beginLoad();
    this.pipeline.stop();
    this.pipeline.clearState();
    this.source = null;
    this._clearOutput();
    this._emit('source');
    this.setStatus(message, 'error');
  }

  _clearOutput() {
    const { algorithm, ageColorEnabled } = this.pipeline.params;
    if (this.webgl) {
      this.pipeline._glRenderer.renderBlank(algorithm, ageColorEnabled);
    } else if (this._ctx2d) {
      renderBlank(this._ctx2d, this.canvas.width || 1, this.canvas.height || 1, algorithm, ageColorEnabled);
    }
  }

  /** Resolve when `video` has metadata, reject on error. */
  _whenMetadata() {
    const { video } = this;
    return new Promise((resolve, reject) => {
      const done = (fn) => () => {
        video.removeEventListener('loadedmetadata', onMeta);
        video.removeEventListener('error', onError);
        fn();
      };
      const onMeta = done(resolve);
      const onError = done(() => reject(new Error('load failed')));
      video.addEventListener('loadedmetadata', onMeta);
      video.addEventListener('error', onError);
    });
  }

  async _loadVideo(src, isLocal) {
    const { video, pipeline } = this;
    if (!isLocal && isYouTubeUrl(src)) {
      this._fail('YouTube URLs are not supported directly: download the video, or use a direct media URL');
      return;
    }
    if (!isLocal && isDashUrl(src)) {
      this._fail('DASH streams are not supported');
      return;
    }

    video.muted = true;
    video.loop = true;
    video.playsInline = true;

    if (!isLocal && isHlsUrl(src)) {
      pipeline.setSourceProfile(buildSourceProfile('hls', HAS_RVFC));
      video.crossOrigin = 'anonymous';
      this._pendingSource.kind = 'hls';
      try {
        const ready = this._whenMetadata();
        await attachHlsSource(src, video, pipeline);
        await ready;
        await this._ready();
      } catch (error) {
        pipeline.clearExternalResources();
        this._fail(`Could not load the HLS stream${error.message && error.message !== 'load failed' ? `: ${error.message}` : ''}`);
      }
      return;
    }

    pipeline.setSourceProfile(buildSourceProfile(isLocal ? 'file' : 'url', HAS_RVFC));
    if (isLocal) video.removeAttribute('crossOrigin');
    else video.crossOrigin = 'anonymous';

    try {
      const ready = this._whenMetadata();
      video.src = src;
      video.load();
      await ready;
    } catch {
      if (isLocal) {
        this._fail('Could not play that file');
        return;
      }
      // A cross-origin URL without CORS headers cannot be read as pixels:
      // retry through a public CORS proxy.
      try {
        this.setStatus('Retrying via CORS proxy…', 'info');
        const ready = this._whenMetadata();
        video.src = `https://corsproxy.io/?${encodeURIComponent(src)}`;
        video.load();
        await ready;
      } catch {
        this._fail('Could not load that URL');
        return;
      }
    }
    await this._ready();
  }

  async _loadStream(stream, kind) {
    const { video, pipeline } = this;
    this._beginLoad();
    pipeline.setSourceProfile(buildSourceProfile(kind, HAS_RVFC));
    this._stream = stream;
    this._pendingSource = { kind, label: stream.getVideoTracks()[0]?.label || kind };

    video.removeAttribute('crossOrigin');
    video.autoplay = true;
    video.muted = true;
    video.loop = false;
    video.playsInline = true;

    try {
      const ready = this._whenMetadata();
      video.srcObject = stream;
      await ready;
      // Some streams report 0x0 until the first frame arrives.
      if (!video.videoWidth) await new Promise((resolve) => video.addEventListener('resize', resolve, { once: true }));
    } catch {
      this._fail('The stream could not be played');
      return;
    }
    if (video.srcObject !== stream) return; // replaced while starting

    stream.getVideoTracks()[0]?.addEventListener('ended', () => {
      if (this._stream !== stream) return;
      this._stopLoop();
      this.pipeline.stop();
      this.loaded = false;
      this.source = null;
      this._setPlaying(false);
      this._emit('source');
      this.setStatus(kind === 'screen' ? 'Screen share ended' : 'Camera stopped', 'info');
    });

    const rate = stream.getVideoTracks()[0]?.getSettings?.().frameRate;
    await this._ready(Number.isFinite(rate) && rate > 0 ? rate : undefined);
  }

  async _ready(knownFps) {
    this.loaded = true;
    this.source = this._pendingSource;
    this.fps = knownFps || DEFAULT_FPS;
    this._frameDeltas.length = 0;
    this._lastMediaTime = NaN;
    this.pipeline.updateDimensions(this.video);
    this._syncCanvasSize();
    this._emit('source');
    this.setStatus(this.modeProblem() || 'Loaded', this.modeProblem() ? 'error' : 'success');
    await this.play();
    if (this.video.paused) this._process(); // autoplay refused: show the first frame
  }

  // ── Transport ───────────────────────────────────────────────

  get duration() { return this.isLive ? 0 : this.video.duration; }

  get currentTime() { return this.video.currentTime || 0; }

  _setPlaying(playing) {
    if (this.playing === playing) return;
    this.playing = playing;
    this._emit('play');
  }

  async play() {
    if (!this.loaded) return;
    try {
      await this.video.play();
      this._setPlaying(true);
      this._startLoop();
    } catch {
      this._setPlaying(false);
    }
  }

  pause() {
    if (!this.loaded) return;
    this.video.pause();
    this._setPlaying(false);
    this._stopLoop();
  }

  toggle() {
    return this.video.paused ? this.play() : this.pause();
  }

  /** Step by whole frames; pauses first. @param {number} frames - e.g. 1 or -1 */
  step(frames) {
    if (!this.loaded || this.isLive) return;
    if (!this.video.paused) this.pause();
    this.seek(this.video.currentTime + frames / this.fps);
  }

  seek(time) {
    if (!this.loaded || this.isLive) return;
    const clamped = Math.min(Math.max(time, 0), this.video.duration);
    if (clamped === this.video.currentTime) this._redrawIfPaused();
    else this.video.currentTime = clamped;
  }

  setRate(rate) {
    this.video.playbackRate = rate;
    this._emit('play');
  }

  get rate() { return this.video.playbackRate; }

  // ── Frame loop ──────────────────────────────────────────────

  /**
   * @param {{mediaTime?: number}} [frameMeta] - requestVideoFrameCallback
   *   metadata when the frame comes from one
   */
  _process(frameMeta) {
    this.pipeline.process(this.video, frameMeta);
    // One audio update per processed frame. The grid size is 0 unless the
    // engine is running, and the pipeline skips the readback entirely at 0.
    const grid = this.pipeline.getEnergyGrid(this.audio.gridCols, this.audio.gridRows);
    if (grid) this.audio.update(grid);
  }

  _drawWorkerResult(result) {
    if (!this.loaded || !result || !this._ctx2d) return;
    const { canvas, pipeline } = this;
    if (result.magnified) {
      renderMagnify(result.magnified, this._ctx2d, canvas.width, canvas.height);
      return;
    }
    if (!result.currentFrame) return;
    const { algorithm, ageColorEnabled } = pipeline.params;
    // The data view is a WebGL feature; the fallback shows the plain result.
    const display = this.display === 'data' ? 'diff' : this.display;
    render(display, result.accumulated, result.currentFrame, this._ctx2d, pipeline.width, pipeline.height, algorithm, ageColorEnabled && algorithm === 'posy');
  }

  _skipForCap(now) {
    const { fpsCap } = this.pipeline.params;
    if (!fpsCap) return false;
    if (this._lastTickMs > 0 && now - this._lastTickMs < 1000 / fpsCap) return true;
    this._lastTickMs = now;
    return false;
  }

  /** Source frame rate from the spacing of presented frames. */
  _noteFrameTime(mediaTime) {
    const delta = mediaTime - this._lastMediaTime;
    this._lastMediaTime = mediaTime;
    if (!(delta > 0.002 && delta < 0.5)) return;
    const deltas = this._frameDeltas;
    deltas.push(delta);
    if (deltas.length > 40) deltas.shift();
    if (deltas.length < 12 || deltas.length % 8) return;
    // A low percentile ignores the doubled gaps that dropped frames leave.
    const sorted = [...deltas].sort((a, b) => a - b);
    const fps = 1 / sorted[Math.floor(sorted.length * 0.25)];
    if (Math.abs(fps - this.fps) > 0.5) {
      this.fps = fps;
      this._emit('source');
    }
  }

  _tick(now, frameMeta) {
    if (!this._loopRunning || !this.loaded) return;
    if (frameMeta && !this._stream) this._noteFrameTime(frameMeta.mediaTime);
    if (!this._skipForCap(now)) this._process(frameMeta);
    this._arm();
  }

  _arm() {
    if (!this._loopRunning) return;
    if (!HAS_RVFC) {
      this._rafId = requestAnimationFrame((now) => this._tick(now));
      return;
    }
    this._rvfcId = this.video.requestVideoFrameCallback((now, meta) => {
      const arrived = performance.now();
      this._callbackRun = arrived - this._lastCallbackMs < FRAME_CALLBACK_STALL_MS ? this._callbackRun + 1 : 0;
      this._lastCallbackMs = arrived;
      // Not flowing yet: the display clock is feeding frames, so this one
      // only counts toward becoming healthy again.
      if (this._callbackRun >= FRAME_CALLBACK_HEALTHY) this._tick(now, meta);
      else this._arm();
    });
    if (this._rafId === null) this._rafId = requestAnimationFrame((now) => this._displayTick(now));
  }

  /** How many frames the decoder has produced, where the browser says. */
  _decodedFrames() {
    const { video } = this;
    return video.getVideoPlaybackQuality?.().totalVideoFrames ?? video.webkitDecodedFrameCount ?? -1;
  }

  /**
   * The display-clock side of the frame loop. Idle while frame callbacks
   * flow. Otherwise, each time the decoder has a new frame, it processes
   * what the element is showing, stamped with currentTime, so the picture
   * keeps moving whether or not callbacks arrive.
   */
  _displayTick(now) {
    this._rafId = null;
    if (!this._loopRunning) return;
    const { video } = this;
    const flowing = this._callbackRun >= FRAME_CALLBACK_HEALTHY
      && performance.now() - this._lastCallbackMs < FRAME_CALLBACK_STALL_MS;
    if (!flowing && this.loaded && !video.paused) {
      this._callbackRun = Math.min(this._callbackRun, FRAME_CALLBACK_HEALTHY - 1);
      const decoded = this._decodedFrames();
      // Without a frame counter, fall back to "the clock moved".
      const fresh = decoded >= 0 ? decoded !== this._watchdogFrame : video.currentTime !== this._watchdogFrame;
      if (fresh) {
        this._watchdogFrame = decoded >= 0 ? decoded : video.currentTime;
        if (decoded >= 0 && !this._stream) this._noteDecoded(decoded, video.currentTime);
        if (!this._skipForCap(now)) this._process();
      }
    }
    this._rafId = requestAnimationFrame((next) => this._displayTick(next));
  }

  /** Source frame rate from the decoder's frame count against media time. */
  _noteDecoded(decoded, mediaTime) {
    const probe = this._fpsProbe;
    if (!probe || mediaTime < probe.time || decoded < probe.frames) {
      this._fpsProbe = { frames: decoded, time: mediaTime };
      return;
    }
    if (mediaTime - probe.time < 1) return;
    const fps = (decoded - probe.frames) / (mediaTime - probe.time);
    this._fpsProbe = { frames: decoded, time: mediaTime };
    if (fps > 1 && fps < 240 && Math.abs(fps - this.fps) > 0.5) {
      this.fps = fps;
      this._emit('source');
    }
  }

  _startLoop() {
    if (this._loopRunning) return;
    this._loopRunning = true;
    this._lastTickMs = 0;
    this._lastCallbackMs = 0;
    this._callbackRun = 0;
    this._fpsProbe = null;
    // The AudioContext already has its gesture; this only un-pauses the voices.
    if (this.audio.params.enabled) void this.audio.start();
    this._arm();
  }

  _stopLoop() {
    this._loopRunning = false;
    // No frames means no energy updates: fade out instead of holding a drone.
    this.audio.stop();
    if (this._rafId !== null) cancelAnimationFrame(this._rafId);
    if (this._rvfcId !== null && HAS_RVFC) this.video.cancelVideoFrameCallback(this._rvfcId);
    this._rafId = null;
    this._rvfcId = null;
  }

  /**
   * Process the frame a seek landed on while paused. The frame callback
   * gives its exact media time (the clock playback uses, so stepping lines
   * up with frames already in history); a timer covers browsers that do not
   * fire it for a paused seek.
   */
  _onSeeked() {
    this._emit('time');
    const { video } = this;
    if (!this.loaded || !video.paused || this._sampling || this._toolStepping) return;
    if (!HAS_RVFC) {
      this._process();
      return;
    }

    const token = ++this._seekToken;
    let done = false;
    const run = (frameMeta) => {
      if (done || token !== this._seekToken) return;
      // Another seek is already in flight: the element reports the new time
      // but still shows the old picture. Its own seeked event will follow.
      if (video.seeking) return;
      done = true;
      clearTimeout(timer);
      if (!this.loaded || !video.paused) return;
      const stale = frameMeta && Math.abs(video.currentTime - frameMeta.mediaTime) > STALE_FRAME_META_S;
      this._process(stale ? undefined : frameMeta);
    };
    const timer = setTimeout(() => run(undefined), SEEK_FRAME_WAIT_MS);
    video.requestVideoFrameCallback((_now, frameMeta) => run(frameMeta));
  }

  _onVisibility() {
    if (!this.loaded) return;
    if (document.hidden) {
      if (!this.video.paused && !this.isLive) {
        this.pause();
        this._autoPaused = true;
      }
    } else if (this._autoPaused) {
      this._autoPaused = false;
      void this.play();
    }
  }

  _seekAndWait(time) {
    const { video } = this;
    return new Promise((resolve) => {
      if (Math.abs(video.currentTime - time) < 0.0005) {
        resolve();
        return;
      }
      video.addEventListener('seeked', () => resolve(), { once: true });
      video.currentTime = time;
    });
  }

  /**
   * Seek to an exact time and process that frame straight away, stamped with
   * the seek time. For tools that render fixed moments (scripts/filmstrip.mjs);
   * the transport uses seek() and step().
   */
  async stepTo(time) {
    if (!this.loaded || this.isLive) return;
    if (!this.video.paused) this.pause();
    this._toolStepping = true;
    try {
      await this._seekAndWait(Math.min(Math.max(time, 0), this.video.duration));
    } finally {
      this._toolStepping = false;
    }
    this._process();
  }

  // ── Export ──────────────────────────────────────────────────

  get canRecord() {
    return CanvasRecorder.isSupported(this.canvas);
  }

  async toggleRecord() {
    if (!this.loaded) {
      this.setStatus('Load a video first', 'error');
      return;
    }
    if (!this.canRecord) {
      this.setStatus('Recording is not supported in this browser', 'error');
      return;
    }
    if (this.recorder.isRecording()) {
      const result = await this.recorder.stop();
      this.recording = false;
      this._emit('recording');
      if (result?.filename) this.setStatus(`Saved ${result.filename}`, 'success');
      return;
    }
    try {
      this.recorder.start();
      this.recording = true;
      this._emit('recording');
      this.setStatus('Recording…', 'info');
    } catch (error) {
      this.setStatus(error.message, 'error');
    }
  }

  // ── Auto-configure ──────────────────────────────────────────

  async autoConfigure() {
    if (!this.loaded) {
      this.setStatus('Load a video first', 'error');
      return;
    }
    if (this.busy) return;

    // A live source cannot be seeked: it is sampled as it plays, so it must
    // keep playing. A seekable one is paused and sampled by seeking.
    const live = this.isLive;
    const wasPaused = this.video.paused;
    this.busy = true;
    this._sampling = true;
    this._emit('busy');
    this.setStatus('Analysing motion…', 'info');
    this._stopLoop();
    if (!live) this.video.pause();
    else if (this.video.paused) await this.video.play().catch(() => {});

    try {
      const { bursts, fps } = await this.pipeline.sampleBursts(this.video, { fps: this.fps });
      if (bursts.length === 0) throw new Error('could not read any frames');
      const { frameOffset, threshold, noiseFloor } = analyzeSample(bursts, fps);
      this.pipeline.setParams({ frameOffset, threshold });
      // The sampling seeks left unrelated frames behind.
      this.pipeline.clearState();
      this._emit('params');
      this.setStatus(`Auto: gap ${Math.round((frameOffset * 1000) / 30)} ms, threshold ${threshold} (noise floor ${noiseFloor.toFixed(1)})`, 'success');
    } catch (error) {
      this.setStatus(`Auto-configure failed: ${error.message}`, 'error');
    } finally {
      this.busy = false;
      this._sampling = false;
      this._emit('busy');
      if (live || !wasPaused) await this.play();
      else this._process();
    }
  }
}
