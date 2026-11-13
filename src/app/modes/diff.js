/**
 * Frame differencing on the GPU, shared by the Posy and Raw modes: diff
 * against three time-shifted frames → optional blur → trail → composite.
 */
import { lookbackTime } from '../../core/timebase.js';
import { TRAIL_HOLD, TRAIL_REFRESH } from '../../core/trails.js';

/**
 * @param {object} frame - The per-frame context from Pipeline.process
 * @param {'posy'|'raw'} algorithm
 * @returns {boolean} false when there is nothing to compare against yet
 */
export function renderDiff(frame, algorithm) {
  const { gl, ring, time, params } = frame;
  const {
    frameOffset, channelSpread, threshold, blurEnabled, ageColorEnabled,
    rgbTintR, rgbTintG, rgbTintB, ageColorNew, ageColorOld,
  } = params;
  const isPosy = algorithm === 'posy';
  const ageColor = isPosy && ageColorEnabled;

  // Each channel compares against the stored frame nearest its lookback
  // time, considering only frames older than this one. While the ring is
  // still filling the gap is shorter than asked for, never longer.
  const ageR = ring.nearest(lookbackTime(time, frameOffset, channelSpread, 0), time);
  const ageG = ring.nearest(lookbackTime(time, frameOffset, channelSpread, 1), time);
  const ageB = ring.nearest(lookbackTime(time, frameOffset, channelSpread, 2), time);
  if (ageR < 0 || ageG < 0 || ageB < 0) {
    gl.renderBlank(algorithm, ageColor);
    return false;
  }

  const layers = frame.layers;
  layers[0] = ring.slotAt(ageR);
  layers[1] = ring.slotAt(ageG);
  layers[2] = ring.slotAt(ageB);

  gl.renderDiff({ threshold, algorithm, rgbTintR, rgbTintG, rgbTintB, layers });
  if (blurEnabled) gl.renderBlur();

  // Advance the trail by this diff → trail image. The same frame rendered
  // again (a parameter change while paused) is recomputed from the state
  // before it rather than stacked on top.
  gl.renderTrail({
    isPosy,
    ageStep: frame.trailAgeStep,
    hold: TRAIL_HOLD,
    refresh: TRAIL_REFRESH,
    repeat: frame.step === 'repeat',
    ageColorEnabled: ageColor,
    ageColorStyle: params.ageColorStyle,
    ageColorNew,
    ageColorOld,
  });

  gl.renderComposite(frame.display, algorithm, ageColor);
  return true;
}
