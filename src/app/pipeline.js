import PipelineWorker from './pipeline.worker.js?worker';
import { WebGLRenderer } from './renderer.webgl.js';
import { buildSourceProfile } from './source-profile.js';
import { FrameRing, ringCapacity } from '../core/buffer.js';
import {
  classifyStep,
  frameDeltaMs,
  framesToSeconds,
  shouldStore,
  storeInterval,
} from '../core/timebase.js';
import { defaultParams, getMode } from './modes/index.js';

const DEFAULT_PROCESS_WIDTH = 640;

/**
 * Whether the browser supports requestVideoFrameCallback on HTMLVideoElement.
 */
const HAS_RVFC = 'requestVideoFrameCallback' in HTMLVideoElement.prototype;

export class Pipeline {
  constructor() {
    this._capCanvas = null;
    this._capCtx = null;
    this._videoEl = null;
    this.width = 0;
    this.height = 0;
    this._processWidth = DEFAULT_PROCESS_WIDTH;
    this._lastFrameTime = 0;

    // ── Media-time base (see core/timebase.js) ──
    // Stamp of the last processed frame, seconds of media time
    this._lastTime = NaN;
    // Stamp of the newest frame kept as history
    this._lastStoredTime = NaN;
    // A seek completed since the last processed frame
    this._seeked = false;
    // Media time the last new frame advanced by (reused when it is re-rendered)
    this._lastDtMs = 0;

    // ── Frame history ──
    // WebGL: the pixels live in the renderer's texture-array ring and this
    // FrameRing tracks which layer holds which frame. Worker fallback: the
    // worker owns both the pixels and its own FrameRing.
    this._ring = new FrameRing(1);
    this._ringLayers = [0, 0, 0];
    // Whether the last processed frame produced a motion magnitude
    this._hasMagnitude = false;

    // ── Worker path (fallback) ──
    this._worker = null;
    this._workerBusy = false;
    // The frame the worker is currently processing, kept for compositing
    this._pendingFrame = null;

    this._currentFrame = null;
    this._sourceProfile = buildSourceProfile('file', HAS_RVFC);

    // ── Sonification energy grid (see core/energy.js) ──
    // Size 0 means "nobody is listening" — neither path computes a grid.
    this._energyCols = 0;
    this._energyRows = 0;
    this._energyGrid = null;
    this._energyGridCols = 0;
    this._energyGridRows = 0;

    /** @type {boolean} Whether WebGL is active */
    this._useWebGL = false;

    /** @type {WebGLRenderer|null} */
    this._glRenderer = null;

    /** @type {HTMLCanvasElement|null} The output canvas element */
    this._outputCanvas = null;

    this.hls = null;

    // Every mode's params with their defaults (see modes/index.js), plus the
    // processing fps cap, which belongs to no mode.
    this.params = { ...defaultParams(), fpsCap: null };

    /** Display mode for modes that composite: 'diff' | 'overlay' | 'glow' | 'data' */
    this._currentMode = 'diff';
    // Per-frame context handed to the active mode's render(); reused.
    this._frame = {
      gl: null, ring: null, time: 0, step: 'first', dtMs: 0, stepMs: 0, trailAgeStep: 0,
      params: this.params, display: 'diff', layers: [0, 0, 0],
    };
    // A mode may say something about what it sees (frame.note): passed on to
    // the status line when the text changes, at most about once a second.
    this._frame.note = (message, type = 'info') => this._note(message, type);
    this._lastNote = '';
    this._lastNoteAt = 0;
    // Why the active mode cannot run here, if it cannot (reported once)
    this._unavailable = null;

    /** @type {((message: string, type: string) => void)|null} */
    this.onStatus = null;

    this.onResult = null;
  }

  /**
   * @param {HTMLVideoElement} videoEl
   * @param {HTMLCanvasElement} outputCanvasEl
   * @param {object} [options]
   * @param {boolean} [options.forceCanvas2D] - skip WebGL2 and run the worker
   *   fallback (for testing that path on a capable GPU)
   * @param {boolean} [options.noFloat] - behave as a GPU without float render
   *   targets would (for testing that fallback)
   * @param {number} [options.ringBudgetBytes] - memory budget for the frame
   *   ring; phones get a smaller one
   * @param {number} [options.processWidth] - initial processing width
   */
  init(videoEl, outputCanvasEl, options = {}) {
    this._videoEl = videoEl;
    this._outputCanvas = outputCanvasEl;
    this._ringOptions = options.ringBudgetBytes ? { budgetBytes: options.ringBudgetBytes } : undefined;
    if (options.processWidth) this._processWidth = options.processWidth;
    // 2D capture canvas: the worker fallback's frame source, and how
    // sampleBursts reads pixels for auto-configure on either path.
    this._capCanvas = document.createElement('canvas');
    this._capCtx = this._capCanvas.getContext('2d', { willReadFrequently: true });

    // A seek is only noted here. Whether it invalidates history is decided
    // from the next frame's timestamp: a one-frame step keeps it, a jump or
    // a rewind does not.
    videoEl.addEventListener('seeked', () => { this._seeked = true; });

    // Try WebGL2 first
    try {
      if (options.forceCanvas2D) throw new Error('Canvas 2D forced by ?renderer=canvas2d');
      this._glRenderer = new WebGLRenderer(outputCanvasEl, { noFloat: options.noFloat });
      this._useWebGL = true;
      console.log('Renderer: WebGL2');
    } catch (e) {
      console.log('WebGL2 init failed:', e.message);
      console.log('Renderer: Canvas 2D (fallback)');
      this._useWebGL = false;
      this._glRenderer = null;
      this._initWorker();
    }
  }

  _initWorker() {
    if (this._worker) this._worker.terminate();
    this._worker = new PipelineWorker();
    this._workerBusy = false;

    this._worker.onmessage = (e) => {
      const msg = e.data;
      if (msg.type !== 'result') return;

      this._workerBusy = false;

      // The motion magnitude grid comes with every kind of result. A result
      // without one means that frame had no measurement: don't keep
      // sounding the previous frame's.
      if (msg.energyBuffer) {
        this._energyGrid = new Float32Array(msg.energyBuffer);
        this._energyGridCols = msg.energyCols;
        this._energyGridRows = msg.energyRows;
      } else {
        this._energyGrid = null;
      }

      if (msg.magnifiedBuffer) {
        const magArr = new Uint8ClampedArray(msg.magnifiedBuffer);
        const magnified = new ImageData(magArr, msg.magnifiedWidth, msg.magnifiedHeight);
        if (this.onResult) {
          this.onResult({ magnified });
        }
        return;
      }

      let accumulated = null;
      const currentFrame = this._pendingFrame;
      this._pendingFrame = null;

      // A result for a frame captured before a resize is stale: drop it.
      const fits = currentFrame
        && currentFrame.width === this.width && currentFrame.height === this.height;
      if (!fits) return;

      if (msg.accumulatedBuffer) {
        const accArr = new Uint8ClampedArray(msg.accumulatedBuffer);
        accumulated = new ImageData(accArr, this.width, this.height);
      }

      if (this.onResult) {
        this.onResult({ currentFrame, accumulated });
      }
    };
  }

  start() {
    this.clearState();
  }

  stop() {
    this._workerBusy = false;
    this._lastFrameTime = 0;
  }

  clearState() {
    this._ring.clear();
    this._lastTime = NaN;
    this._lastStoredTime = NaN;
    this._seeked = false;
    this._hasMagnitude = false;
    this._energyGrid = null;

    if (this._useWebGL && this._glRenderer) {
      this._glRenderer.clearTrails();
    }

    if (this._worker) {
      this._worker.postMessage({ type: 'clear' });
    }
    this._workerBusy = false;
    this._lastFrameTime = 0;
  }

  /**
   * Re-seed the magnify EMA states from the next frame. Called on source
   * change, resize, a break in the timeline (jump, rewind, loop), and when
   * switching into magnify mode — the same situations that clear trails.
   */
  resetMagnifyState() {
    if (this._useWebGL && this._glRenderer) {
      this._glRenderer.resetMagnifyState?.();
    }
    if (this._worker) {
      this._worker.postMessage({ type: 'magReset' });
    }
  }

  setHlsInstance(hls) {
    if (this.hls) {
      this.hls.destroy();
    }
    this.hls = hls;
  }

  clearExternalResources() {
    this.setHlsInstance(null);
  }

  setSourceProfile(profile) {
    this._sourceProfile = profile;
  }

  logProcessingConfig() {
    const capLabel = this.params.fpsCap ? `${this.params.fpsCap}fps` : 'uncapped';
    console.log(`Pipeline: processing at ${this._processWidth}px, cap ${capLabel}`);
  }

  /**
   * Frame history available for lookback on the active path.
   * @returns {{frames: number, megabytes: number}}
   */
  getHistoryInfo() {
    const frames = this._useWebGL ? this._ring.capacity : ringCapacity(this.width, this.height, this._ringOptions);
    return { frames, megabytes: (frames * this.width * this.height * 4) / (1024 * 1024) };
  }

  /**
   * Update runtime params. Unknown keys are ignored, so a preset saved by a
   * build with more modes loads without harm.
   */
  setParams(params) {
    const previous = this.params.algorithm;
    for (const key of Object.keys(params)) {
      if (!(key in this.params) || params[key] === undefined) continue;
      if (key === 'magDownsample' && params[key] !== this.params[key]) {
        this.params[key] = params[key];
        this.resetMagnifyState();
        continue;
      }
      this.params[key] = params[key];
    }

    if (this.params.algorithm !== previous) {
      this.params.algorithm = getMode(this.params.algorithm).id;
      // Every mode owns the trail and the temporal state while it runs:
      // start the new one clean instead of showing the last one's leftovers.
      if (this._useWebGL && this._glRenderer) this._glRenderer.clearTrails();
      if (this._worker) this._worker.postMessage({ type: 'clearTrails' });
      this.resetMagnifyState();
      this._unavailable = null;
    }
  }

  /**
   * Latest motion-magnitude grid for whichever render path and mode is
   * active, or null when the last frame carries no measurement (before the
   * first comparison, right after a seek). Asking for a size is also what turns the
   * grid on: the worker path computes at the requested size from the next frame
   * onward, and cols/rows below 1 switch the readback off entirely.
   *
   * @param {number} cols
   * @param {number} rows
   * @returns {Float32Array|null} cols*rows energies in 0..1, row-major
   */
  getEnergyGrid(cols, rows) {
    const nextCols = Number.isFinite(cols) ? Math.floor(cols) : 0;
    const nextRows = Number.isFinite(rows) ? Math.floor(rows) : 0;

    if (nextCols !== this._energyCols || nextRows !== this._energyRows) {
      this._energyCols = nextCols;
      this._energyRows = nextRows;
      this._energyGrid = null;
    }

    if (nextCols < 1 || nextRows < 1) return null;

    if (this._useWebGL) {
      if (!this._glRenderer || !this._hasMagnitude) return null;
      return this._glRenderer.readEnergyGrid(nextCols, nextRows);
    }

    // Worker results lag the request by a frame; ignore stale grid sizes.
    if (this._energyGridCols !== nextCols || this._energyGridRows !== nextRows) return null;
    return this._energyGrid;
  }

  setProcessingWidth(width) {
    const nextWidth = Number.parseInt(width, 10);
    if (!Number.isFinite(nextWidth) || nextWidth <= 0 || nextWidth === this._processWidth) return;
    this._processWidth = nextWidth;

    if (!this._useWebGL && nextWidth > 640) {
      console.warn(`Processing width ${nextWidth}px may be slow on Canvas 2D fallback.`);
    }

    if (this._videoEl) {
      this.updateDimensions(this._videoEl);
    }
    this.logProcessingConfig();
  }

  updateDimensions(video) {
    const vw = video.videoWidth;
    const vh = video.videoHeight;
    if (!vw || !vh) return;
    const scale = this._processWidth / vw;
    this.width = this._processWidth;
    this.height = Math.round(vh * scale);
    this._capCanvas.width = this.width;
    this._capCanvas.height = this.height;

    if (this._useWebGL && this._glRenderer) {
      // The ring is sized from a memory budget, so it gets shorter as the
      // processing resolution goes up.
      const frames = this._glRenderer.setSize(
        this.width, this.height, ringCapacity(this.width, this.height, this._ringOptions),
      );
      if (frames !== this._ring.capacity) {
        this._ring = new FrameRing(frames);
        const { megabytes } = this.getHistoryInfo();
        console.log(`Frame ring: ${frames} frames at ${this.width}x${this.height} (${megabytes.toFixed(0)} MB on the GPU)`);
      }
    }

    this.start();
  }

  /**
   * Capture current video frame as ImageData through the 2D canvas.
   * Uses VideoFrame bridge when available. The WebGL path never calls this
   * while rendering — it uploads the video element directly.
   */
  captureFrame(video) {
    const w = this.width;
    const h = this.height;
    if (!w || !h) return null;

    const mode = this._sourceProfile?.frameCapture ?? 'draw-image';
    try {
      if (mode === 'video-frame') {
        this._currentFrame = new VideoFrame(video);
      }
      if (mode === 'video-frame' && this._currentFrame) {
        this._capCtx.drawImage(this._currentFrame, 0, 0, w, h);
      } else {
        this._capCtx.drawImage(video, 0, 0, w, h);
      }
      return this._capCtx.getImageData(0, 0, w, h);
    } catch {
      return null;
    } finally {
      this._currentFrame?.close();
      this._currentFrame = null;
    }
  }

  /**
   * Sample short bursts of consecutive frames for auto-configure.
   *
   * A seekable source is sampled by seeking: `burstCount` bursts spread
   * over the clip, each `framesPerBurst` frames one source-frame interval
   * apart (aimed at the middle of each frame so a seek cannot straddle two).
   * A live source (camera, screen, live stream) cannot be seeked, so one
   * burst is taken from the frames as they arrive.
   *
   * Pixels are read through the 2D capture canvas at the processing size.
   *
   * @param {HTMLVideoElement} video
   * @param {{burstCount?: number, framesPerBurst?: number, fps?: number}} [options]
   *   fps is the source frame rate; defaults to 30
   * @returns {Promise<{bursts: Uint8ClampedArray[][], fps: number}>} fps is
   *   the rate the returned frames are actually spaced at
   */
  async sampleBursts(video, options = {}) {
    const burstCount = Math.max(1, options.burstCount ?? 4);
    const framesPerBurst = Math.max(2, options.framesPerBurst ?? 6);
    const sourceFps = Number.isFinite(options.fps) && options.fps > 0 ? options.fps : 30;
    if (!this.width || !this.height) return { bursts: [], fps: sourceFps };

    const duration = Number.isFinite(video.duration) ? video.duration : 0;
    if (!duration) return this._sampleLiveBurst(video, framesPerBurst * 2, sourceFps);

    const step = 1 / sourceFps;
    const burstSpan = framesPerBurst * step;
    const lastStart = Math.max(duration - burstSpan - 0.05, 0);
    const originalTime = video.currentTime;
    const bursts = [];

    try {
      for (let b = 0; b < burstCount; b++) {
        // Burst b starts at the centre of the b-th of burstCount equal slices.
        const start = lastStart * ((b + 0.5) / burstCount);
        const frames = [];
        for (let i = 0; i < framesPerBurst; i++) {
          await this._seekVideo(video, start + (i + 0.5) * step);
          const frame = this.captureFrame(video);
          if (frame) frames.push(frame.data);
        }
        if (frames.length >= 2) bursts.push(frames);
      }
    } finally {
      await this._seekVideo(video, originalTime);
    }
    return { bursts, fps: sourceFps };
  }

  /**
   * Capture `count` consecutive frames from a playing, unseekable source
   * and measure the rate they actually arrived at.
   */
  async _sampleLiveBurst(video, count, fallbackFps) {
    const frames = [];
    const times = [];
    const nextFrame = () => new Promise((resolve) => {
      if (HAS_RVFC) {
        video.requestVideoFrameCallback((_now, meta) => resolve(meta.mediaTime));
      } else {
        requestAnimationFrame(() => resolve(video.currentTime));
      }
    });

    // Give up if frames stop arriving (a paused or ended stream).
    const deadline = performance.now() + 3000;
    while (frames.length < count && performance.now() < deadline) {
      const time = await Promise.race([
        nextFrame(),
        new Promise((resolve) => setTimeout(() => resolve(null), 500)),
      ]);
      if (time === null) continue;
      if (times.length && time <= times[times.length - 1]) continue; // same frame again
      const frame = this.captureFrame(video);
      if (!frame) continue;
      frames.push(frame.data);
      times.push(time);
    }

    const span = times.length >= 2 ? times[times.length - 1] - times[0] : 0;
    const fps = span > 0 ? (times.length - 1) / span : fallbackFps;
    return { bursts: frames.length >= 2 ? [frames] : [], fps };
  }

  _seekVideo(video, targetTime) {
    return new Promise((resolve, reject) => {
      const clampedTime = Math.min(Math.max(targetTime, 0), Number.isFinite(video.duration) ? video.duration : targetTime);
      if (Math.abs(video.currentTime - clampedTime) < 0.0005) {
        resolve();
        return;
      }

      const onSeeked = () => {
        cleanup();
        resolve();
      };
      const onError = () => {
        cleanup();
        reject(new Error('Seek failed while sampling frames.'));
      };
      const cleanup = () => {
        video.removeEventListener('seeked', onSeeked);
        video.removeEventListener('error', onError);
      };

      video.addEventListener('seeked', onSeeked, { once: true });
      video.addEventListener('error', onError, { once: true });
      video.currentTime = clampedTime;
    });
  }

  /**
   * Main processing entry point.
   * Routes to either WebGL or Worker path.
   *
   * @param {HTMLVideoElement} video
   * @param {{mediaTime?: number}} [frameMeta] - requestVideoFrameCallback
   *   metadata for the frame being presented, when the caller has it
   */
  process(video, frameMeta) {
    // The worker takes one frame at a time. Skip before stamping so the
    // next frame it does take is classified against the last one it saw.
    if (!this._useWebGL && this._workerBusy) return;

    const prevTime = this._lastTime;
    const time = this._frameTime(video, frameMeta);
    const step = classifyStep(prevTime, time, this._seeked);
    this._seeked = false;
    this._lastTime = time;
    const dtMs = frameDeltaMs(step, prevTime, time);
    // A re-rendered frame advances the magnify filters by nothing, but its
    // trail is recomputed with the step it had the first time.
    if (step !== 'repeat') this._lastDtMs = dtMs;
    const trailAgeStep = this._trailAgeStep();

    const mode = getMode(this.params.algorithm);
    if (this._useWebGL) {
      this._applyStepWebGL(step, time);
      this._renderWebGL(video, mode, time, step, dtMs, trailAgeStep);
    } else if (!mode.worker) {
      this._reportUnavailable(`${mode.label} needs WebGL2, which this browser did not provide`);
    } else if (mode.id === 'magnify') {
      this._processMagnifyWorker(video, time, step, dtMs);
    } else {
      this._processWorker(video, time, step, trailAgeStep);
    }
  }

  /** Tell the UI once why the active mode shows nothing. */
  _note(message, type) {
    const now = performance.now();
    if (message === this._lastNote || now - this._lastNoteAt < 1200) return;
    this._lastNote = message;
    this._lastNoteAt = now;
    if (this.onStatus) this.onStatus(message, type);
  }

  _reportUnavailable(reason) {
    if (this._unavailable === reason) return;
    this._unavailable = reason;
    if (this.onStatus) this.onStatus(reason, 'error');
  }

  /**
   * How far trail ages advance for the current frame, in trail windows.
   * `trailLength` is in the same 1/30 s units as `frameOffset`.
   */
  _trailAgeStep() {
    const windowSeconds = framesToSeconds(Math.max(this.params.trailLength, 0.001));
    return this._lastDtMs / 1000 / windowSeconds;
  }

  /**
   * Media time of the frame the video element is showing.
   *
   * requestVideoFrameCallback's mediaTime is exact. Without it, a paused
   * video that has not been seeked is still showing the frame processed
   * last, whatever currentTime has drifted to; otherwise currentTime is the
   * best available clock.
   */
  _frameTime(video, frameMeta) {
    const mediaTime = frameMeta?.mediaTime;
    if (Number.isFinite(mediaTime)) return mediaTime;
    if (video.paused && !this._seeked && Number.isFinite(this._lastTime)) return this._lastTime;
    return video.currentTime;
  }

  // ── WebGL Path ──────────────────────────────────────────────

  /** Drop whatever history the step made unusable. */
  _applyStepWebGL(step, time) {
    if (step === 'advance' || step === 'repeat') return;

    if (step === 'rewind') {
      // Frames stamped at or after the new position are in its future.
      this._ring.dropFrom(time);
      this._lastStoredTime = this._ring.newestTime;
    } else {
      this._ring.clear();
      this._lastStoredTime = NaN;
    }
    // clearTrails also re-seeds the magnify EMA states.
    this._glRenderer.clearTrails();
  }

  _renderWebGL(video, mode, time, step, dtMs, trailAgeStep) {
    const gl = this._glRenderer;
    // Video element → GPU texture; no readback, nothing kept on the JS heap.
    if (!gl.captureVideo(video)) return;

    if (mode.needsFloat && !gl.floatTargets) {
      gl.renderBlank('raw', false);
      this._hasMagnitude = false;
      this._reportUnavailable(`${mode.label} needs float render targets, which this GPU lacks`);
    } else {
      const frame = this._frame;
      frame.gl = gl;
      frame.ring = this._ring;
      frame.time = time;
      frame.step = step;
      frame.dtMs = dtMs;
      frame.trailAgeStep = trailAgeStep;
      frame.stepMs = this._lastDtMs;
      frame.params = this.params;
      frame.display = this._currentMode;
      this._hasMagnitude = mode.render(frame) !== false;
      if (this._hasMagnitude && this._currentMode === 'data') gl.renderDataView(mode.data.kind);
    }

    // Keep the ring warm in every mode so switching modes has history.
    this._storeCurrentFrame(time, step, mode);
  }

  /** Keep the frame just captured as history for the frames that follow. */
  _storeCurrentFrame(time, step, mode) {
    if (step === 'repeat') return;
    // How far back the mode reads decides how densely history is kept.
    const { frameOffset, channelSpread } = this.params;
    const [shortest, longest] = mode.lookback
      ? mode.lookback(this.params)
      : [frameOffset, frameOffset + channelSpread * 2];
    const interval = storeInterval(shortest, (longest - shortest) / 2, this._ring.capacity);
    if (!shouldStore(this._lastStoredTime, time, interval)) return;

    this._glRenderer.storeCurrent(this._ring.push(time));
    this._lastStoredTime = time;
  }

  /**
   * Display mode: 'diff' | 'overlay' | 'glow', or 'data' to look at the
   * active mode's data output instead of its picture (WebGL only).
   * @param {string} mode
   */
  setMode(mode) {
    this._currentMode = mode;
  }

  /**
   * The active mode's result as data: one RGBA float per pixel at the data
   * target's size, row 0 at the top. R is the mode's magnitude (0..1), G and
   * B are mode-specific (see the mode's `data`). WebGL only; reads back from
   * the GPU, so it is for tools and experiments, not per-frame use.
   *
   * @returns {{kind: string, what: string, width: number, height: number, values: Float32Array}|null}
   */
  readData() {
    if (!this._useWebGL || !this._glRenderer || !this._hasMagnitude) return null;
    const field = this._glRenderer.readDataField();
    if (!field) return null;
    const { kind, what } = getMode(this.params.algorithm).data;
    return { kind, what, ...field };
  }

  // ── Magnify: Worker path (fallback) ─────────────────────────

  _processMagnifyWorker(video, time, step, dtMs) {
    // The worker gets the frame at the processing size and does the
    // spatial pooling itself, in floats.
    const frame = this.captureFrame(video);
    if (!frame) return;
    this._workerBusy = true;

    const currentFrameBuffer = frame.data.buffer;

    this._worker.postMessage({
      type: 'process',
      currentFrameBuffer,
      time,
      step,
      params: { ...this.params },
      dtMs,
      width: frame.width,
      height: frame.height,
      energyCols: this._energyCols,
      energyRows: this._energyRows,
    }, [currentFrameBuffer]);
  }

  // ── Worker Path (fallback) ──────────────────────────────────

  _processWorker(video, time, step, trailAgeStep) {
    const frame = this.captureFrame(video);
    if (!frame) return;
    this._workerBusy = true;

    // The worker keeps the pixels it is sent as its history, so it gets its
    // own copy and this one stays here for compositing the result.
    this._pendingFrame = frame;
    const pixels = frame.data.slice();

    this._worker.postMessage({
      type: 'process',
      currentFrameBuffer: pixels.buffer,
      time,
      step,
      trailAgeStep,
      ringBudgetBytes: this._ringOptions?.budgetBytes,
      params: { ...this.params },
      width: this.width,
      height: this.height,
      energyCols: this._energyCols,
      energyRows: this._energyRows,
    }, [pixels.buffer]);
  }
}
