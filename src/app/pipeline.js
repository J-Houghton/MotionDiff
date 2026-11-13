import PipelineWorker from './pipeline.worker.js?worker';
import { WebGLRenderer } from './renderer.webgl.js';
import { buildSourceProfile } from './source-profile.js';
import { FrameRing, ringCapacity } from '../core/buffer.js';
import { emaAlpha } from '../core/magnify.js';
import {
  classifyStep,
  frameDeltaMs,
  lookbackTime,
  shouldStore,
  storeInterval,
} from '../core/timebase.js';
import { boxBlur } from '../core/blur.js';
import { posyBlend, rawDiff } from '../core/diff.js';
import { diffMagnitude, poolMagnitude } from '../core/magnitude.js';

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

    this.params = {
      frameOffset: 5,
      threshold: 20,
      trailLength: 5,
      channelSpread: 0,
      algorithm: 'posy',
      blurEnabled: false,
      ageColorEnabled: false,
      rgbTintR: '#ff0000',
      rgbTintG: '#00ff00',
      rgbTintB: '#0000ff',
      ageColorNew: '#ff4400',
      ageColorOld: '#0044ff',
      fpsCap: null,
      magAmp: 15,
      magFreqLow: 0.7,
      magFreqHigh: 2.0,
      magChroma: 1.0,
      magDownsample: 2,
    };

    this.onResult = null;
  }

  /**
   * @param {HTMLVideoElement} videoEl
   * @param {HTMLCanvasElement} outputCanvasEl
   * @param {{forceCanvas2D?: boolean}} [options] - forceCanvas2D skips WebGL2
   *   and runs the worker fallback (for testing that path on a capable GPU)
   */
  init(videoEl, outputCanvasEl, options = {}) {
    this._videoEl = videoEl;
    this._outputCanvas = outputCanvasEl;
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
      this._glRenderer = new WebGLRenderer(outputCanvasEl);
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
    const frames = this._useWebGL ? this._ring.capacity : ringCapacity(this.width, this.height);
    return { frames, megabytes: (frames * this.width * this.height * 4) / (1024 * 1024) };
  }

  setParams(params) {
    if (params.frameOffset !== undefined) this.params.frameOffset = params.frameOffset;
    if (params.threshold !== undefined) this.params.threshold = params.threshold;
    if (params.trailLength !== undefined) this.params.trailLength = params.trailLength;
    if (params.channelSpread !== undefined) this.params.channelSpread = params.channelSpread;
    if (params.algorithm !== undefined && params.algorithm !== this.params.algorithm) {
      const wasMagnify = this.params.algorithm === 'magnify';
      this.params.algorithm = params.algorithm;
      if (params.algorithm === 'magnify') {
        this.resetMagnifyState();
      } else if (wasMagnify) {
        // Trails were not fed while magnifying; drop the stale ring
        // instead of showing pre-magnify ghosts.
        if (this._useWebGL && this._glRenderer) this._glRenderer.clearTrails();
        if (this._worker) this._worker.postMessage({ type: 'clearTrails' });
      }
    }
    if (params.blurEnabled !== undefined) this.params.blurEnabled = params.blurEnabled;
    if (params.ageColorEnabled !== undefined) this.params.ageColorEnabled = params.ageColorEnabled;
    if (params.rgbTintR !== undefined) this.params.rgbTintR = params.rgbTintR;
    if (params.rgbTintG !== undefined) this.params.rgbTintG = params.rgbTintG;
    if (params.rgbTintB !== undefined) this.params.rgbTintB = params.rgbTintB;
    if (params.ageColorNew !== undefined) this.params.ageColorNew = params.ageColorNew;
    if (params.ageColorOld !== undefined) this.params.ageColorOld = params.ageColorOld;
    if (params.fpsCap !== undefined && params.fpsCap !== this.params.fpsCap) {
      this.params.fpsCap = params.fpsCap;
      this.logProcessingConfig();
    }
    if (params.magAmp !== undefined) this.params.magAmp = params.magAmp;
    if (params.magFreqLow !== undefined) this.params.magFreqLow = params.magFreqLow;
    if (params.magFreqHigh !== undefined) this.params.magFreqHigh = params.magFreqHigh;
    if (params.magChroma !== undefined) this.params.magChroma = params.magChroma;
    if (params.magDownsample !== undefined && params.magDownsample !== this.params.magDownsample) {
      this.params.magDownsample = params.magDownsample;
      this.resetMagnifyState();
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
        this.width, this.height, ringCapacity(this.width, this.height),
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

    if (this._useWebGL) {
      this._applyStepWebGL(step, time);
      if (this.params.algorithm === 'magnify') {
        this._processMagnifyWebGL(video, time, step, dtMs);
      } else {
        this._processWebGL(video, time, step);
      }
    } else if (this.params.algorithm === 'magnify') {
      this._processMagnifyWorker(video, time, step, dtMs);
    } else {
      this._processWorker(video, time, step);
    }
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

  _processWebGL(video, time, step) {
    const gl = this._glRenderer;
    // Video element → GPU texture; no readback, nothing kept on the JS heap.
    if (!gl.captureVideo(video)) return;

    const {
      frameOffset,
      threshold,
      channelSpread,
      trailLength,
      algorithm,
      blurEnabled,
      ageColorEnabled,
      rgbTintR,
      rgbTintG,
      rgbTintB,
      ageColorNew,
      ageColorOld,
    } = this.params;

    // Each channel compares against the stored frame nearest its lookback
    // time, considering only frames older than this one. While the ring is
    // still filling the gap is shorter than asked for, never longer.
    const ring = this._ring;
    const ageR = ring.nearest(lookbackTime(time, frameOffset, channelSpread, 0), time);
    const ageG = ring.nearest(lookbackTime(time, frameOffset, channelSpread, 1), time);
    const ageB = ring.nearest(lookbackTime(time, frameOffset, channelSpread, 2), time);

    if (ageR < 0 || ageG < 0 || ageB < 0) {
      // Nothing to compare against yet — show blank
      gl.renderBlank(algorithm, ageColorEnabled);
      this._hasMagnitude = false;
    } else {
      const layers = this._ringLayers;
      layers[0] = ring.slotAt(ageR);
      layers[1] = ring.slotAt(ageG);
      layers[2] = ring.slotAt(ageB);

      // Run diff shader → _diffFB
      gl.renderDiff({ threshold, algorithm, rgbTintR, rgbTintG, rgbTintB, layers });

      // Optional blur
      if (blurEnabled) {
        gl.renderBlur();
      }

      // Add the diff to the trail ring. The same frame rendered again (a
      // parameter change while paused) replaces its entry instead.
      if (step === 'repeat') gl.replaceTrail();
      else gl.pushTrail();

      // Accumulate trails → _accumFB
      const isPosy = algorithm === 'posy';
      gl.renderAccumulate(trailLength, isPosy, threshold, ageColorEnabled, ageColorNew, ageColorOld);

      // Composite to canvas
      gl.renderComposite(this._currentMode || 'diff', algorithm, ageColorEnabled);
      this._hasMagnitude = true;
    }

    this._storeCurrentFrame(time, step);
  }

  /** Keep the frame just captured as history for the frames that follow. */
  _storeCurrentFrame(time, step) {
    if (step === 'repeat') return;
    const { frameOffset, channelSpread } = this.params;
    const interval = storeInterval(frameOffset, channelSpread, this._ring.capacity);
    if (!shouldStore(this._lastStoredTime, time, interval)) return;

    this._glRenderer.storeCurrent(this._ring.push(time));
    this._lastStoredTime = time;
  }

  /**
   * Set the current display mode for WebGL composite.
   * Called from main.js to keep the mode in sync.
   * @param {string} mode - 'diff' | 'overlay' | 'glow'
   */
  setMode(mode) {
    this._currentMode = mode;
  }

  // ── Magnify: WebGL path ─────────────────────────────────────

  _processMagnifyWebGL(video, time, step, dtMs) {
    const gl = this._glRenderer;
    if (!gl.captureVideo(video)) return;

    // Keep the lookback ring warm so switching back to Posy/Raw behaves.
    this._storeCurrentFrame(time, step);
    this._hasMagnitude = false;

    if (!gl.magnifySupported) {
      // The UI disables the magnify option when unsupported; if we still
      // get here, show a blank frame rather than rendering garbage.
      gl.renderBlank(this.params.algorithm, false);
      return;
    }

    // dtMs is media time, so the pass band is in Hz of the scene at any
    // playback rate; a repeated frame advances the filters by nothing.
    const ok = gl.renderMagnify({
      alphaFast: emaAlpha(this.params.magFreqHigh, dtMs),
      alphaSlow: emaAlpha(this.params.magFreqLow, dtMs),
      amp: this.params.magAmp,
      chroma: this.params.magChroma,
      downsample: this.params.magDownsample,
      blurEnabled: this.params.blurEnabled,
    });
    if (!ok) {
      gl.renderBlank(this.params.algorithm, false);
    }
    this._hasMagnitude = ok;
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

  _processWorker(video, time, step) {
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
      params: { ...this.params },
      width: this.width,
      height: this.height,
      energyCols: this._energyCols,
      energyRows: this._energyRows,
    }, [pixels.buffer]);
  }
}

/**
 * Dev-only parity probe for the diff and blur shaders against core/diff.js
 * and core/blur.js. Runs Posy and Raw, with and without threshold and blur,
 * on a pair of pseudo-random frames and reports the largest per-channel
 * difference per case. Everything except the tinted case is expected to be
 * exactly 0: the shader does the same whole-number arithmetic as the core.
 *
 * Like debugEnergyParity it resizes the renderer and clears the pipeline —
 * run it on an idle page.
 *
 * @param {Pipeline} pipeline - A pipeline whose init() picked the WebGL path
 * @returns {{cases: {name: string, maxDiff: number}[], pass: boolean}|null}
 */
export function debugDiffParity(pipeline) {
  const gl = pipeline?._glRenderer;
  if (!gl) return null;

  const width = 32;
  const height = 16;
  let seed = 12345;
  const random = () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed / 4294967296;
  };
  const prev = new Uint8ClampedArray(width * height * 4);
  const next = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < prev.length; i += 4) {
    for (let c = 0; c < 3; c++) {
      prev[i + c] = Math.floor(random() * 256);
      // Mostly small differences so the threshold has pixels on both sides.
      next[i + c] = Math.min(255, Math.max(0, prev[i + c] + Math.round((random() - 0.5) * (random() < 0.3 ? 200 : 30))));
    }
    prev[i + 3] = next[i + 3] = 255;
  }

  const restoreWidth = gl.width;
  const restoreHeight = gl.height;
  const restoreFrames = gl.ringFrames;
  gl.setSize(width, height, 2);
  gl.uploadPixels(new ImageData(prev, width, height));
  gl.storeCurrent(0);
  gl.uploadPixels(new ImageData(next, width, height));

  const tint = (hex) => {
    const rgb = [1, 3, 5].map((at) => parseInt(hex.slice(at, at + 2), 16));
    const sum = rgb[0] + rgb[1] + rgb[2];
    return rgb.map((v) => v / sum);
  };

  const CASES = [
    { name: 'posy t=0', algorithm: 'posy', threshold: 0 },
    { name: 'posy t=14', algorithm: 'posy', threshold: 14 },
    { name: 'raw t=0', algorithm: 'raw', threshold: 0 },
    { name: 'raw t=14', algorithm: 'raw', threshold: 14 },
    { name: 'posy t=14 blur', algorithm: 'posy', threshold: 14, blur: true },
    { name: 'raw t=14 blur', algorithm: 'raw', threshold: 14, blur: true },
    { name: 'posy t=14 tinted', algorithm: 'posy', threshold: 14, tints: ['#ff8800', '#00ff40', '#2040ff'], tolerance: 1 },
  ];

  const cases = CASES.map(({ name, algorithm, threshold, blur = false, tints = ['#ff0000', '#00ff00', '#0000ff'], tolerance = 0 }) => {
    // Core reference, built the way the worker builds it.
    const weights = tints.map(tint);
    const old = new Uint8ClampedArray(prev.length);
    for (let i = 0; i < prev.length; i += 4) {
      for (let c = 0; c < 3; c++) {
        old[i + c] = Math.round(prev[i] * weights[c][0] + prev[i + 1] * weights[c][1] + prev[i + 2] * weights[c][2]);
      }
      old[i + 3] = 255;
    }
    const core = new Uint8ClampedArray(prev.length);
    (algorithm === 'posy' ? posyBlend : rawDiff)(next, old, core, threshold);
    if (blur) boxBlur(core, width, height);

    gl.renderDiff({
      threshold,
      algorithm,
      rgbTintR: tints[0],
      rgbTintG: tints[1],
      rgbTintB: tints[2],
      layers: [0, 0, 0],
    });
    if (blur) gl.renderBlur();
    const gpu = gl.readDiffPixels();

    let maxDiff = 0;
    for (let i = 0; i < core.length; i++) {
      if ((i & 3) === 3) continue;
      maxDiff = Math.max(maxDiff, Math.abs(core[i] - gpu[i]));
    }
    return { name, maxDiff, pass: maxDiff <= tolerance };
  });

  if (restoreWidth > 0 && restoreHeight > 0) gl.setSize(restoreWidth, restoreHeight, restoreFrames);
  pipeline.clearState();

  return { cases, pass: cases.every((c) => c.pass) };
}

/**
 * Synthetic frame pairs for the magnitude parity probe.
 *
 * - `wedge`: only the second frame carries a brightness wedge, so every cell
 *   lands on a different magnitude and every deviation has the same sign.
 * - `signed`: a bright square moves 6 px inside one cell (a positive band
 *   where it arrives, a negative band where it left) and a checkerboard
 *   inverts (alternate pixels deviate up and down). Averaging the signed
 *   Posy values over a cell cancels both to ~0; only a per-pixel unsigned
 *   magnitude sees them.
 */
function buildParityPatterns(width, height) {
  const base = 96;
  const make = (fn) => {
    const data = new Uint8ClampedArray(width * height * 4);
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const i = (y * width + x) * 4;
        data[i] = data[i + 1] = data[i + 2] = fn(x, y);
        data[i + 3] = 255;
      }
    }
    return data;
  };
  const square = (x0) => (x, y) => {
    if (x >= 64 && y >= 32) return 0; // checkerboard region, filled below
    return x >= x0 && x < x0 + 6 && y >= 20 && y < 28 ? 216 : base;
  };
  const checker = (phase) => (x, y) => ((x + y + phase) % 2 === 0 ? 136 : 56);
  const signed = (x0, phase) => (x, y) => (x >= 64 && y >= 32 ? checker(phase)(x, y) : square(x0)(x, y));

  return {
    wedge: {
      prev: make(() => base),
      // Motion grows to the right and is strongest at the top.
      next: make((x, y) => base + Math.round((x / (width - 1)) * 120 * (1 - y / (height - 1)))),
    },
    signed: {
      prev: make(signed(34, 0)),
      next: make(signed(40, 1)),
    },
  };
}

/**
 * Dev-only parity probe for the shared motion magnitude (originally
 * SPEC-sonification A6).
 *
 * Feeds synthetic frame pairs through the CPU core math
 * (posyBlend → diffMagnitude → poolMagnitude) and through the WebGL diff,
 * magnitude and pooling programs, and returns both grids per pattern. Only
 * ever called behind `import.meta.env.DEV`, so production builds tree-shake
 * it away.
 *
 * For the signed pattern it also reports `signedMean`: what pooling the
 * signed diff first would have measured, to show the cancellation the
 * unsigned magnitude avoids.
 *
 * It resizes the renderer to the synthetic frame size and clears the pipeline
 * afterwards — run it on an idle page, not mid-playback.
 *
 * @param {Pipeline} pipeline - A pipeline whose init() picked the WebGL path
 * @param {number} [cols]
 * @param {number} [rows]
 * @returns {object|null} { cols, rows, core, webgl, maxDiff } for the wedge
 *   pattern, the same fields plus signedMean under `signed`, and `pass`
 *   (every cell of both patterns within 0.05)
 */
export function debugEnergyParity(pipeline, cols = 8, rows = 4) {
  const gl = pipeline?._glRenderer;
  if (!gl) return null;

  const width = 128;
  const height = 64;
  const patterns = buildParityPatterns(width, height);

  const restoreWidth = gl.width;
  const restoreHeight = gl.height;
  const restoreFrames = gl.ringFrames;
  gl.setSize(width, height, 2);

  const run = ({ prev, next }) => {
    const diff = new Uint8ClampedArray(width * height * 4);
    posyBlend(next, prev, diff, 0);
    const magnitude = diffMagnitude(diff, true, new Float32Array(width * height));
    const core = Array.from(poolMagnitude(magnitude, width, height, cols, rows));

    // Previous frame into ring layer 0, then the frame under test as current.
    gl.uploadPixels(new ImageData(prev, width, height));
    gl.storeCurrent(0);
    gl.uploadPixels(new ImageData(next, width, height));
    gl.renderDiff({
      threshold: 0,
      algorithm: 'posy',
      rgbTintR: '#ff0000',
      rgbTintG: '#00ff00',
      rgbTintB: '#0000ff',
      layers: [0, 0, 0],
    });
    const grid = gl.readEnergyGrid(cols, rows);
    const webgl = grid ? Array.from(grid) : [];

    // Pool the signed values first, then take the deviation (the wrong order).
    const signedValues = new Float32Array(width * height);
    for (let p = 0; p < signedValues.length; p++) signedValues[p] = diff[p * 4] / 255;
    const signedMean = Array.from(poolMagnitude(signedValues, width, height, cols, rows))
      .map((mean) => Math.abs(mean * 255 - 128) / 127);

    let maxDiff = webgl.length === core.length ? 0 : Infinity;
    for (let i = 0; i < core.length && i < webgl.length; i++) {
      maxDiff = Math.max(maxDiff, Math.abs(core[i] - webgl[i]));
    }
    return { core, webgl, signedMean, maxDiff };
  };

  const wedge = run(patterns.wedge);
  const signed = run(patterns.signed);

  if (restoreWidth > 0 && restoreHeight > 0) gl.setSize(restoreWidth, restoreHeight, restoreFrames);
  pipeline.clearState();

  return {
    cols,
    rows,
    core: wedge.core,
    webgl: wedge.webgl,
    maxDiff: wedge.maxDiff,
    signed,
    pass: wedge.maxDiff < 0.05 && signed.maxDiff < 0.05,
  };
}
