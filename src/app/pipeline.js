import PipelineWorker from './pipeline.worker.js?worker';
import { WebGLRenderer } from './renderer.webgl.js';
import { buildSourceProfile } from './source-profile.js';
import { FrameRing, ringCapacity } from '../core/buffer.js';
import { emaAlpha } from '../core/magnify.js';
import { posyBlend } from '../core/diff.js';
import { cellEnergies } from '../core/energy.js';

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

    // ── Magnify mode ──
    // Timestamp of the last processed magnify frame (real dt for emaAlpha)
    this._magLastTime = 0;
    // Downsampled capture canvas for the worker magnify path
    this._magCapCanvas = null;
    this._magCapCtx = null;

    // ── Frame history ──
    // WebGL: the pixels live in the renderer's texture-array ring and this
    // FrameRing tracks which layer holds which frame. Worker fallback: the
    // worker owns both the pixels and its own FrameRing.
    this._ring = new FrameRing(1);
    this._frameIndex = 0;
    this._ringLayers = [0, 0, 0];
    // Whether the last processed frame produced a diff (energy grid source)
    this._hasDiff = false;

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
      threshold: 10,
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
    // sampleFrames reads pixels for auto-configure on either path.
    this._capCanvas = document.createElement('canvas');
    this._capCtx = this._capCanvas.getContext('2d', { willReadFrequently: true });

    // Seeks must re-seed the magnify EMA states (avoids a flash while
    // the band-pass re-converges on unrelated content).
    videoEl.addEventListener('seeked', () => this.resetMagnifyState());

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

      if (msg.energyBuffer) {
        this._energyGrid = new Float32Array(msg.energyBuffer);
        this._energyGridCols = msg.energyCols;
        this._energyGridRows = msg.energyRows;
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
    this._magLastTime = 0;
  }

  clearState() {
    this._ring.clear();
    this._frameIndex = 0;
    this._hasDiff = false;
    this._energyGrid = null;

    if (this._useWebGL && this._glRenderer) {
      this._glRenderer.clearTrails();
    }

    if (this._worker) {
      this._worker.postMessage({ type: 'clear' });
    }
    this._workerBusy = false;
    this._lastFrameTime = 0;
    this._magLastTime = 0;
  }

  /**
   * Re-seed the magnify EMA states from the next frame. Called on source
   * change, seek, resize, and when switching into magnify mode — the same
   * situations that clear trails.
   */
  resetMagnifyState() {
    this._magLastTime = 0;
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
   * Latest motion-energy grid for whichever render path is active, or null
   * before the first processed frame. Asking for a size is also what turns the
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
      if (!this._glRenderer || !this._hasDiff) return null;
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

  async sampleFrames(video, sampleCount = 30) {
    const duration = Number.isFinite(video.duration) ? video.duration : 0;
    if (!duration || !this.width || !this.height) return [];

    const frames = [];
    const totalSamples = Math.max(2, sampleCount);
    const finalTime = Math.max(duration - 0.05, 0);
    const originalTime = video.currentTime;

    for (let index = 0; index < totalSamples; index++) {
      const ratio = totalSamples === 1 ? 0 : index / (totalSamples - 1);
      const targetTime = finalTime * ratio;
      await this._seekVideo(video, targetTime);
      const frame = this.captureFrame(video);
      if (frame) {
        frames.push(new Uint8ClampedArray(frame.data));
      }
    }

    await this._seekVideo(video, originalTime);
    return frames;
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
   */
  process(video) {
    if (this._useWebGL) {
      if (this.params.algorithm === 'magnify') {
        this._processMagnifyWebGL(video);
      } else {
        this._processWebGL(video);
      }
    } else {
      if (this.params.algorithm === 'magnify') {
        this._processMagnifyWorker(video);
      } else {
        this._processWorker(video);
      }
    }
  }

  /**
   * Real frame interval for the magnify EMAs, measured between processed
   * frames. Falls back to 30 fps on the first frame after a reset.
   */
  _magFrameDt(now) {
    const dtMs = this._magLastTime > 0
      ? Math.min(Math.max(now - this._magLastTime, 0.1), 1000)
      : 1000 / 30;
    this._magLastTime = now;
    return dtMs;
  }

  // ── WebGL Path ──────────────────────────────────────────────

  _processWebGL(video) {
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

    // The ring holds frames older than this one; the gap for each channel
    // clamps to the oldest frame while the ring is still filling.
    const index = this._frameIndex;
    const ring = this._ring;
    const ageR = ring.nearest(index - frameOffset, index);
    const ageG = ring.nearest(index - (frameOffset + channelSpread), index);
    const ageB = ring.nearest(index - (frameOffset + channelSpread * 2), index);

    if (ageR < 0 || ageG < 0 || ageB < 0) {
      // Nothing to compare against yet — show blank
      gl.renderBlank(algorithm, ageColorEnabled);
      this._hasDiff = false;
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

      // Push diff result into trail ring
      gl.pushTrail();

      // Accumulate trails → _accumFB
      const isPosy = algorithm === 'posy';
      gl.renderAccumulate(trailLength, isPosy, threshold, ageColorEnabled, ageColorNew, ageColorOld);

      // Composite to canvas
      gl.renderComposite(this._currentMode || 'diff', algorithm, ageColorEnabled);
      this._hasDiff = true;
    }

    this._storeCurrentFrame();
  }

  /** Keep the frame just captured as history for the frames that follow. */
  _storeCurrentFrame() {
    this._glRenderer.storeCurrent(this._ring.push(this._frameIndex));
    this._frameIndex += 1;
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

  _processMagnifyWebGL(video) {
    const gl = this._glRenderer;
    if (!gl.captureVideo(video)) return;

    // Keep the lookback ring warm so switching back to Posy/Raw behaves.
    this._storeCurrentFrame();
    this._hasDiff = false;

    if (!gl.magnifySupported) {
      // The UI disables the magnify option when unsupported; if we still
      // get here, show a blank frame rather than rendering garbage.
      gl.renderBlank(this.params.algorithm, false);
      return;
    }

    const dtMs = this._magFrameDt(performance.now());
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
  }

  // ── Magnify: Worker path (fallback) ─────────────────────────

  /**
   * Capture the current frame at the magnify processing size. The
   * downsampling is the spatial pooling; the worker path is capped at
   * 320 px wide (correctness over speed on the CPU fallback).
   */
  _captureMagnifyFrame(video) {
    if (!this.width || !this.height) return null;
    const ds = this.params.magDownsample || 1;
    const w = Math.max(2, Math.min(320, Math.round(this.width / ds)));
    const h = Math.max(2, Math.round(this.height * (w / this.width)));

    if (!this._magCapCanvas) {
      this._magCapCanvas = document.createElement('canvas');
      this._magCapCtx = this._magCapCanvas.getContext('2d', { willReadFrequently: true });
    }
    if (this._magCapCanvas.width !== w || this._magCapCanvas.height !== h) {
      this._magCapCanvas.width = w;
      this._magCapCanvas.height = h;
    }

    try {
      this._magCapCtx.drawImage(video, 0, 0, w, h);
      return this._magCapCtx.getImageData(0, 0, w, h);
    } catch {
      return null;
    }
  }

  _processMagnifyWorker(video) {
    const frame = this._captureMagnifyFrame(video);
    if (!frame) return;

    if (this._workerBusy) return;
    this._workerBusy = true;

    const dtMs = this._magFrameDt(performance.now());
    const currentFrameBuffer = frame.data.buffer;

    this._worker.postMessage({
      type: 'process',
      currentFrameBuffer,
      params: { ...this.params },
      dtMs,
      width: frame.width,
      height: frame.height,
    }, [currentFrameBuffer]);
  }

  // ── Worker Path (fallback) ──────────────────────────────────

  _processWorker(video) {
    // One frame in flight at a time. A frame that arrives while the worker
    // is busy is skipped before it costs a capture.
    if (this._workerBusy) return;

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
      time: this._frameIndex,
      params: { ...this.params },
      width: this.width,
      height: this.height,
      energyCols: this._energyCols,
      energyRows: this._energyRows,
    }, [pixels.buffer]);
    this._frameIndex += 1;
  }
}

/**
 * Dev-only parity probe for SPEC-sonification A6.
 *
 * Feeds the same two synthetic frames through the CPU core math and the WebGL
 * readback and returns both grids so their cells can be compared. Only ever
 * called behind `import.meta.env.DEV`, so production builds tree-shake it away.
 *
 * It resizes the renderer to the synthetic frame size and clears the pipeline
 * afterwards — run it on an idle page, not mid-playback.
 *
 * @param {Pipeline} pipeline - A pipeline whose init() picked the WebGL path
 * @param {number} [cols]
 * @param {number} [rows]
 * @returns {{cols: number, rows: number, core: number[], webgl: number[]}|null}
 */
export function debugEnergyParity(pipeline, cols = 8, rows = 4) {
  const gl = pipeline?._glRenderer;
  if (!gl) return null;

  const width = 128;
  const height = 64;
  const prev = new Uint8ClampedArray(width * height * 4);
  const next = new Uint8ClampedArray(width * height * 4);
  const base = 96;

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      prev[i] = prev[i + 1] = prev[i + 2] = base;
      prev[i + 3] = 255;
      // Only the second frame carries the wedge: motion grows to the right and
      // is strongest at the top, so every cell lands on a different energy.
      const wedge = Math.round((x / (width - 1)) * 120 * (1 - y / (height - 1)));
      next[i] = next[i + 1] = next[i + 2] = base + wedge;
      next[i + 3] = 255;
    }
  }

  const diff = new Uint8ClampedArray(width * height * 4);
  posyBlend(next, prev, diff, 0);
  const core = cellEnergies(diff, width, height, cols, rows, true);

  const restoreWidth = gl.width;
  const restoreHeight = gl.height;
  const restoreFrames = gl.ringFrames;
  gl.setSize(width, height, 2);
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
  const webgl = Array.from(gl.readEnergyGrid(cols, rows));

  if (restoreWidth > 0 && restoreHeight > 0) gl.setSize(restoreWidth, restoreHeight, restoreFrames);
  pipeline.clearState();

  return { cols, rows, core: Array.from(core), webgl };
}
