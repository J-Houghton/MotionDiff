// @ts-check
/**
 * Shared measurement stages (docs/pipeline-stages.md).
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
import { MASK_VOTES_STRICT } from '../core/mask.js';
import { learnMask, updateBackground } from './modes/background.js';
import { maskDifference, maskDraw, maskLayers } from './modes/mask.js';
import { flowVelocity, fullSpeed, reportReadings } from './modes/flow.js';
import { advanceHistory } from './modes/history.js';
import { quietGate } from './modes/magnify.js';

export class Stages {
  constructor() {
    /** @type {import('./modes/index.js').ModeFrame|null} */
    this._frame = null;
    /** @type {Map<string, *>} */
    this._memo = new Map();
  }

  /** Start a new frame: whatever was measured belonged to the last one. */
  begin(frame) {
    this._frame = frame;
    this._memo.clear();
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
    return this._get('learnMask', () => learnMask(this._frame));
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
      return flowVelocity(frame, source);
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
      return reportReadings(frame, velocity, fullSpeed(frame.params, frame.gl.width));
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
}
