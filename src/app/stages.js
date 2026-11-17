// @ts-check
/**
 * Shared measurement stages (records/design/pipeline-stages.md).
 *
 * One Stages object belongs to the Pipeline. Each frame, `begin(frame)`
 * clears the memo and the object rides along as `frame.stages`; a mode's
 * render asks it for measurements instead of computing them itself. Every
 * stage is computed on the first request in a frame and returned from the
 * memo after that, so a stateful measurement (the background model, flow's
 * smoothing, the history ages) advances exactly once per frame however many
 * views pull it, and each variant of a measurement draws into a target of
 * its own.
 *
 * This is the only module that wires measurements together: the mode
 * modules' helpers take what another module measured as an argument, and
 * which gate or variance a measurement uses is decided here, in one place,
 * from `pipeline.params`. The parity probes keep driving the helpers
 * directly, without a Stages object.
 */
import { BG_HOLD_SECONDS, backgroundAlpha } from '../core/background.js';
import { boxDepth, depthSpeedFactor } from '../core/depth.js';
import { MASK_VOTES_STRICT } from '../core/mask.js';
import { bornTracks, labelComponents, stepTracks } from '../core/track.js';
import { fitSimilarity } from '../core/flow.js';
import { lookbackTime } from '../core/timebase.js';
import { learnMask, updateBackground } from './modes/background.js';
import { maskDifference, maskDraw, maskLayers } from './modes/mask.js';
import {
  FLOW_TRUSTED, READINGS_WIDTH, flowFactor, flowLevels, flowVelocity, fullSpeed, reportReadings,
} from './modes/flow.js';
import { advanceHistory } from './modes/history.js';
import { quietGate } from './modes/magnify.js';
import { flowBetween, flowLuma, flowPass, readField } from './flow.js';
import { reduceField } from './particles.js';

// The camera's shift over an interval, applied to a ring frame: each output
// pixel reads the source at p − (t + A·(p − c)) with manual bilinear (the
// ring is unfiltered) and every sample rounded back to a whole 0..255
// level, mirroring core warpFrame. Work happens in image coordinates
// (y down); the ring's rows are stored bottom-up.
export const WARP_FRAG = `#version 300 es
precision highp float;
precision highp sampler2DArray;

uniform sampler2DArray uRing;
uniform int uLayer;
uniform vec2 uShift;   // camera translation over the interval, px
uniform vec2 uAffine;  // zoom and rotation over the interval

out vec4 fragColor;

vec3 at(ivec2 img, ivec2 size) {
  ivec2 q = clamp(img, ivec2(0), size - 1);
  return floor(texelFetch(uRing, ivec3(q.x, size.y - 1 - q.y, uLayer), 0).rgb * 255.0 + 0.5);
}

void main() {
  ivec2 size = ivec2(textureSize(uRing, 0).xy);
  // This output texel, as an image position (row 0 at the top).
  vec2 img = vec2(gl_FragCoord.x - 0.5, float(size.y) - gl_FragCoord.y - 0.5);
  vec2 c = (vec2(size) - 1.0) / 2.0;
  vec2 r = img - c;
  vec2 s = img - (uShift + vec2(uAffine.x * r.x - uAffine.y * r.y, uAffine.y * r.x + uAffine.x * r.y));
  s = clamp(s, vec2(0.0), vec2(size) - 1.0);
  vec2 base = floor(s);
  vec2 f = s - base;
  ivec2 i = ivec2(base);
  vec3 top = mix(at(i, size), at(i + ivec2(1, 0), size), f.x);
  vec3 bottom = mix(at(i + ivec2(0, 1), size), at(i + ivec2(1, 1), size), f.x);
  fragColor = vec4(floor(mix(top, bottom, f.y) + 0.5) / 255.0, 1.0);
}`;

export class Stages {
  constructor() {
    /** @type {import('./modes/index.js').ModeFrame|null} */
    this._frame = null;
    /** @type {Map<string, *>} */
    this._memo = new Map();
    // The camera's trajectory: cumulative position per processed frame,
    // stamped like the ring, so a warp between any two stamps is a
    // difference of entries (records/design/camera-compensation.md).
    this._track = { epoch: -1, entries: [], buffers: null };
    // The warp target pool: fixed keys, assigned in order each frame.
    this._warps = 0;
    // Grouping and tracking state (records/design/tracking.md), reset with the epoch.
    this._objectsState = null;
  }

  /** Start a new frame: whatever was measured belonged to the last one. */
  begin(frame) {
    this._frame = frame;
    this._memo.clear();
    this._warps = 0;
    return this;
  }

  _get(key, make) {
    if (!this._memo.has(key)) this._memo.set(key, make());
    return this._memo.get(key);
  }

  /**
   * Ring layers of the two older frames [gap, second gap], or null while
   * there is no history yet.
   * @returns {number[]|null}
   */
  maskPair() {
    return this._get('maskPair', () => maskLayers(this._frame));
  }

  /** The stamps of those two frames, for the camera's warp. */
  _maskTimes() {
    return this._get('maskTimes', () => {
      const { ring, time, params } = this._frame;
      const near = ring.nearest(lookbackTime(time, params.frameOffset, 0, 0), time);
      const far = ring.nearest(lookbackTime(time, Math.max(params.secondGap, params.frameOffset + 1), 0, 0), time);
      return near < 0 || far < 0 ? null : [ring.timeAt(near), ring.timeAt(far)];
    });
  }

  /**
   * The camera's own motion (records/design/camera-compensation.md): this frame's
   * similarity fit — dx, dy in picture px/s, zoom 1/s, rotation rad/s,
   * share — from an ungated, unsmoothed solve of its own, and the running
   * trajectory those velocities integrate into. Null while `cameraComp`
   * is off.
   */
  camera() {
    return this._get('camera', () => {
      const frame = this._frame;
      if (!frame.params.cameraComp) return null;
      const renderer = frame.gl;
      if (!renderer.floatTargets) return null;
      if (this._track.epoch !== renderer.epoch) {
        this._track = { epoch: renderer.epoch, entries: [], buffers: this._track.buffers };
      }
      const track = this._track;
      const last = track.entries[track.entries.length - 1] || null;
      if (last && last.time === frame.time) return { velocity: last.v, track };

      const { ring, time, params } = frame;
      const age = ring.nearest(lookbackTime(time, params.flowGap, 0, 0), time);
      let velocity = { dx: 0, dy: 0, zoom: 0, rot: 0, share: 0 };
      const gapSeconds = age >= 0 ? time - ring.timeAt(age) : 0;
      // A thinned ring can offer only a distant frame; a solve across it
      // reads nothing the fit should trust.
      if (age >= 0 && gapSeconds > 1e-4 && gapSeconds <= 0.5) {
        const factor = flowFactor(renderer.width);
        const current = flowLuma(renderer, 'camera:current', factor);
        const older = flowLuma(renderer, 'camera:older', factor, ring.slotAt(age));
        const flow = flowBetween(renderer, 'camera', older, current, { levels: flowLevels(current.width) });
        const reduced = reduceField(renderer, 'camera:field', flow, READINGS_WIDTH);
        track.buffers = readField(renderer, reduced, track.buffers);
        const fit = fitSimilarity(track.buffers.values, reduced.width, reduced.height, {
          present: FLOW_TRUSTED,
          stride: 4,
          pixelsPerCell: flow.width / reduced.width,
        });
        // Working pixels per gap → picture pixels per second; zoom and
        // rotation are ratios per gap, so only time scales them.
        velocity = {
          dx: (fit.dx * factor) / gapSeconds,
          dy: (fit.dy * factor) / gapSeconds,
          zoom: fit.zoom / gapSeconds,
          rot: fit.rot / gapSeconds,
          share: fit.share,
        };
        // The fit speaks for the camera only when enough of the frame
        // backs it, and only above a stillness dead band — otherwise a
        // still camera's noise fits would random-walk the trajectory and
        // compensation would INVENT motion (the readings' camera line
        // holds the same two rules).
        const reach = Math.hypot(velocity.dx, velocity.dy)
          + Math.hypot(velocity.zoom, velocity.rot) * (renderer.width / 2);
        if (velocity.share < 0.25 || reach < renderer.width * 0.02) {
          velocity = { dx: 0, dy: 0, zoom: 0, rot: 0, share: velocity.share };
        }
      }
      const prev = last || { x: 0, y: 0, zoom: 0, rot: 0 };
      const dt = frame.stepMs / 1000;
      track.entries.push({
        time,
        x: prev.x + velocity.dx * dt,
        y: prev.y + velocity.dy * dt,
        zoom: prev.zoom + velocity.zoom * dt,
        rot: prev.rot + velocity.rot * dt,
        v: velocity,
      });
      if (track.entries.length > 240) track.entries.splice(0, track.entries.length - 240);
      return { velocity, track };
    });
  }

  /** The camera's shift in pixels between a stored frame's stamp and now. */
  _shiftBetween(oldTime) {
    const entries = this._track.entries;
    const now = entries[entries.length - 1];
    if (!now || entries.length < 2) return { dx: 0, dy: 0, zoom: 0, rot: 0 };
    // The cumulative position at oldTime, interpolated between entries and
    // clamped at the track's ends (frames before the first estimate warp by
    // what is known).
    let lo = entries[0];
    let hi = now;
    for (let i = entries.length - 1; i >= 0; i--) {
      if (entries[i].time <= oldTime) { lo = entries[i]; hi = entries[Math.min(i + 1, entries.length - 1)]; break; }
    }
    const span = hi.time - lo.time;
    const mix = span > 0 ? Math.min(1, Math.max(0, (oldTime - lo.time) / span)) : 0;
    const at = (key) => lo[key] + (hi[key] - lo[key]) * mix;
    return { dx: now.x - at('x'), dy: now.y - at('y'), zoom: now.zoom - at('zoom'), rot: now.rot - at('rot') };
  }

  /**
   * A ring frame resampled as the still camera would have seen it: the
   * input every differencing consumer uses in place of the raw layer while
   * compensation is on. Null while it is off.
   * @param {number} layer - Ring layer
   * @param {number} oldTime - That frame's stamp
   */
  stabilised(layer, oldTime) {
    if (!this.camera()) return null;
    return this._get(`warp:${layer}:${oldTime}`, () => {
      const frame = this._frame;
      const renderer = frame.gl;
      const shift = this._shiftBetween(oldTime);
      // Targets before binds; a fixed pool of keys, assigned per frame.
      const target = renderer.target(`camera:warp${this._warps++}`, renderer.width, renderer.height);
      const program = renderer.program('camera:warp', WARP_FRAG, { uRing: 0 });
      const gl = renderer.gl;
      gl.useProgram(program.prog);
      renderer.bind(0, renderer.ringTexture, true);
      gl.uniform1i(program.u.uLayer, layer);
      gl.uniform2f(program.u.uShift, shift.dx, shift.dy);
      gl.uniform2f(program.u.uAffine, shift.zoom, shift.rot);
      renderer.draw(target.fb, renderer.width, renderer.height);
      return target;
    });
  }

  /** The two mask frames warped, or null (off, or no history). */
  _stabilisedPair() {
    const layers = this.maskPair();
    const times = this._maskTimes();
    if (!layers || !times || !this.camera()) return null;
    const a = this.stabilised(layers[0], times[0]);
    const b = this.stabilised(layers[1], times[1]);
    return a && b ? [a.tex, b.tex] : null;
  }

  /**
   * The raw three-frame decision in the mask mode's own configuration
   * (blur, lighting normalisation, auto threshold), R = decision,
   * G = strength. Null while there is no history.
   */
  maskRaw() {
    return this._get('maskRaw', () => {
      const frame = this._frame;
      const { params } = frame;
      const layers = this.maskPair();
      if (!layers) return null;
      const model = params.maskAuto ? this.background() : null;
      return maskDifference(frame.gl, {
        key: 'stage:mask-raw',
        layers,
        older: this._stabilisedPair(),
        threshold: params.threshold,
        blur: params.maskBlur,
        variance: model ? model.variance : undefined,
        gradient: params.maskGradient,
      });
    });
  }

  /**
   * The plain raw decision every other consumer shares (blur on, nothing
   * else): what the history feed and flow's mask gate difference. Null
   * while there is no history.
   */
  maskPlain() {
    return this._get('maskPlain', () => {
      const frame = this._frame;
      const layers = this.maskPair();
      if (!layers) return null;
      return maskDifference(frame.gl, {
        key: 'stage:mask-plain',
        layers,
        older: this._stabilisedPair(),
        threshold: frame.params.threshold,
        blur: true,
      });
    });
  }

  /**
   * The history feed: the plain decision under the strict vote (a hairline
   * would stripe the history). Null while there is no history.
   */
  maskStrict() {
    return this._get('maskStrict', () => {
      const frame = this._frame;
      const raw = this.maskPlain();
      if (!raw) return null;
      const renderer = frame.gl;
      const voted = renderer.target('stage:mask-strict', renderer.width, renderer.height);
      maskDraw(renderer, raw.tex, voted.fb, { clean: MASK_VOTES_STRICT, output: 'data' });
      return voted;
    });
  }

  /** The two-frame voted mask that gates the background model's learning. */
  learnMask() {
    return this._get('learnMask', () => {
      const frame = this._frame;
      let older = null;
      if (this.camera()) {
        const { ring, time, params } = frame;
        const near = ring.nearest(lookbackTime(time, params.frameOffset, 0, 0), time);
        if (near >= 0) {
          const warped = this.stabilised(ring.slotAt(near), ring.timeAt(near));
          if (warped) older = [warped.tex, warped.tex];
        }
      }
      return learnMask(frame, older);
    });
  }

  /**
   * The background model, advanced once for this frame: the decision target
   * (R = foreground, G = distance from the model, vote not applied) with
   * `variance`, the per-pixel noise texture.
   */
  background() {
    return this._get('background', () => {
      const frame = this._frame;
      const { params } = frame;
      return updateBackground(frame.gl, {
        mask: this.learnMask().tex,
        alpha: backgroundAlpha(frame.stepMs, params.absorbSeconds),
        holdStep: frame.stepMs / 1000 / BG_HOLD_SECONDS,
        threshold: params.threshold,
        repeat: frame.step === 'repeat',
      });
    });
  }

  /**
   * The smoothed velocity field, advanced once for this frame, with the
   * gate `pipeline.params` ask for applied. Null while there is no older
   * frame. (See flowVelocity for what the field holds.)
   */
  velocity() {
    return this._get('velocity', () => {
      const frame = this._frame;
      const { flowOnly } = frame.params;
      // Which decision gates the flow is decided here: the plain mask when
      // there is one (no second frame yet: measure everywhere), the model's
      // foreground, or nothing. Passed as a thunk so a stateful decision is
      // only measured — and the model only advances — on a frame whose
      // solve actually runs (see flowVelocity).
      const source = flowOnly === 'mask' ? () => this.maskPlain()
        : flowOnly === 'foreground' ? () => this.background()
          : null;
      const camera = this.camera();
      return flowVelocity(frame, source, camera ? camera.velocity : null);
    });
  }

  /**
   * The velocity field read back small and measured: sets frame.readings
   * and the status note, and returns the readings. Null while there is no
   * field.
   */
  flowReadings() {
    return this._get('flowReadings', () => {
      const frame = this._frame;
      const velocity = this.velocity();
      if (!velocity) return null;
      const readings = /** @type {*} */ (reportReadings(frame, velocity, fullSpeed(frame.params, frame.gl.width)));
      // With compensation on, the field's own median reads near zero by
      // construction: the camera line reports the fit instead.
      const camera = this.camera();
      if (readings && camera) {
        readings.camera = { ...camera.velocity };
        readings.cameraSpeed = Math.hypot(camera.velocity.dx, camera.velocity.dy);
        readings.compensated = true;
      }
      return readings;
    });
  }

  /**
   * The history state, advanced once for this frame: age per pixel, pooled
   * directions, and (for the measured view) the laid-down flow colours.
   * Null while there is no history feed yet.
   * @param {'age'|'direction'|'measured'} view
   */
  history(view) {
    return this._get(`history:${view}`, () => {
      const frame = this._frame;
      const mask = this.maskStrict();
      if (!mask) return null;
      return advanceHistory(frame.gl, {
        mask: mask.tex,
        ageStep: frame.stepMs / 1000 / (frame.params.historyLength / 30),
        repeat: frame.step === 'repeat',
        view,
        velocity: view === 'measured' ? this.velocity() : null,
      });
    });
  }

  /** Magnify's mute-still-areas gate, built on the background model. */
  quietGate() {
    return this._get('quietGate', () => quietGate(this._frame, this.background()));
  }

  /**
   * The depth model's latest answer as a stage (records/design/depth-stage.md): the
   * coarse inverse-depth grid with min/max/median, the stamp of the frame
   * it saw, and `age` — media seconds this frame is ahead of it. Null
   * while depth is off or before the first answer. The model runs beside
   * the pipeline; this never waits for it.
   */
  depth() {
    return this._get('depth', () => {
      const latest = this._frame.depth;
      if (!latest || !this._frame.params.maskDepth) return null;
      return { ...latest, age: Math.max(0, this._frame.time - latest.time) };
    });
  }

  /**
   * Grouping and tracking (records/design/tracking.md): the voted decision read back
   * on a coarse grid, shapes labelled, and the track step run once per
   * frame. Publishes onto frame.readings and returns the born tracks in
   * picture pixels, or null while there is nothing to track.
   *
   * @param {{tex: *}} decision - The mover decision (mask raw or the model's),
   *   before the vote; the vote is applied here as the picture applies it
   */
  objects(decision) {
    return this._get('objects', () => {
      const frame = this._frame;
      const renderer = frame.gl;
      if (!decision) return null;
      if (this._objectsState?.epoch !== renderer.epoch) {
        this._objectsState = { epoch: renderer.epoch, tracks: [], nextId: 1, buffers: null, lastTime: NaN };
      }
      const state = this._objectsState;
      // The same frame again: the step already ran; report what it found.
      if (state.lastTime === frame.time) return state.published;

      // Vote, reduce to a coarse grid, read back.
      const voted = renderer.target('stage:track-voted', renderer.width, renderer.height);
      maskDraw(renderer, decision.tex, voted.fb, { clean: true, output: 'data' });
      const reduced = reduceField(renderer, 'stage:track-grid', { tex: voted.tex, width: renderer.width, height: renderer.height }, 192);
      state.buffers = readField(renderer, reduced, state.buffers);
      const { width: cols, height: rows } = reduced;
      const cell = renderer.width / cols;
      const grid = new Uint8Array(cols * rows);
      // A block counts as moving when a good third of its pixels did: a
      // lower bar bridges the gap between two cars nose to tail.
      for (let i = 0; i < cols * rows; i++) grid[i] = state.buffers.values[i * 4] >= 0.35 ? 1 : 0;

      const detections = labelComponents(grid, cols, rows, 10).map((part) => ({
        cx: (part.cx + 0.5) * cell,
        cy: (part.cy + 0.5) * cell,
        w: (part.x1 - part.x0 + 1) * cell,
        h: (part.y1 - part.y0 + 1) * cell,
      }));
      const step = stepTracks(state.tracks, detections, { dt: frame.stepMs / 1000, nextId: state.nextId });
      state.tracks = step.tracks;
      state.nextId = step.nextId;
      state.lastTime = frame.time;

      const shown = bornTracks(state.tracks).map((t) => ({
        id: t.id,
        x: t.cx - t.w / 2,
        y: t.cy - t.h / 2,
        w: t.w,
        h: t.h,
        cx: t.cx,
        cy: t.cy,
        vx: t.vx,
        vy: t.vy,
        speed: Math.hypot(t.vx, t.vy),
        age: t.age,
        coasting: t.miss > 0,
      }));
      // Depth, where the stage has it (records/design/depth-stage.md): each box
      // samples its median inverse depth and carries the factor that makes
      // its speed comparable at the scene's median depth — or no factor
      // where the map declines, and the raw speed stands unmarked. The
      // factor is smoothed per id (successive maps renormalise, and a map
      // is a look or two old against a mover's current box), and a coasted
      // box samples nothing — its position is a prediction, not a find —
      // but keeps the factor it had, as it keeps its speed.
      const depth = this.depth();
      if (depth) {
        const factors = (state.factors ||= new Map());
        for (const o of shown) {
          let factor = null;
          if (!o.coasting) {
            const at = boxDepth(depth.grid, depth.cols, depth.rows, o, renderer.width, renderer.height);
            factor = depthSpeedFactor(depth.median, at, depth.min, depth.max);
          }
          if (factor !== null) {
            const prev = factors.get(o.id);
            const smoothed = prev === undefined ? factor : prev + (factor - prev) * 0.25;
            factors.set(o.id, smoothed);
            o.depthFactor = smoothed;
          } else if (o.coasting && factors.has(o.id)) {
            o.depthFactor = factors.get(o.id);
          }
        }
        const alive = new Set(shown.map((o) => o.id));
        for (const id of factors.keys()) if (!alive.has(id)) factors.delete(id);
      }
      state.published = shown;
      frame.readings = {
        ...(frame.readings || { mode: frame.params.algorithm }),
        objects: shown,
        width: renderer.width,
        height: renderer.height,
        ...(depth ? { depthAge: depth.age } : {}),
      };
      return shown;
    });
  }
}
