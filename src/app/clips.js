/**
 * Sample clips offered in the source picker. They are not part of the
 * project: each is played from where its owner hosts it (the host must allow
 * cross-origin reads, or the frames cannot reach WebGL).
 *
 *   label    shown on the button
 *   url      the file
 *   mode     optional: the mode this sample shows off (a mode id). Named on
 *            the button, and selected when the sample is loaded
 *   params   optional: settings applied with it (pipeline params)
 *   display  optional: 'diff' | 'overlay' | 'glow'
 *   credit   where it comes from and under what licence
 *
 * A sample without a mode keeps whatever mode and settings are current.
 */
export const TEST_CLIPS = [
  {
    label: 'Trees in Wind',
    url: 'https://videos.pexels.com/video-files/1254570/1254570-hd_1920_1080_30fps.mp4',
    credit: 'Pexels licence',
  },
  {
    label: 'Flowing River',
    url: 'https://videos.pexels.com/video-files/6981415/6981415-hd_1920_1080_25fps.mp4',
    credit: 'Pexels licence',
  },
  {
    label: 'Sunset Timelapse',
    url: 'https://videos.pexels.com/video-files/5646694/5646694-hd_1920_1080_30fps.mp4',
    credit: 'Pexels licence',
  },
  // One sample per mode, in mode order. Each was checked in its mode with
  // these settings (static camera, or the whole frame would light up).
  {
    // A timelapse: a flower unfolds against a still wall.
    label: 'Flower Opening',
    url: 'https://videos.pexels.com/video-files/12538831/12538831-hd_1920_1080_30fps.mp4',
    mode: 'posy',
    params: { frameOffset: 30, threshold: 8, trailLength: 20, channelSpread: 2, blurEnabled: false, ageColorEnabled: false },
    display: 'diff',
    credit: 'Pexels licence',
  },
  {
    label: 'Face, Held Still',
    url: 'https://videos.pexels.com/video-files/8724224/8724224-hd_1366_720_25fps.mp4',
    mode: 'magnify',
    params: { magAmp: 15, magFreqLow: 0.7, magFreqHigh: 2.0, magChroma: 1.0, magDownsample: 2, blurEnabled: false },
    credit: 'Pexels licence',
  },
  {
    // Dozens of bees on a plain wall: each is cut out where it is.
    label: 'Bees at the Hive',
    url: 'https://videos.pexels.com/video-files/9491523/9491523-hd_1920_1080_25fps.mp4',
    mode: 'mask',
    params: { frameOffset: 3, secondGap: 30, threshold: 20, maskBlur: true, maskClean: true, maskShow: 'cutout', trailLength: 5 },
    display: 'diff',
    credit: 'Pexels licence',
  },
  {
    // A few gulls against clear sky: each leaves a ribbon along its path.
    label: 'Gulls Overhead',
    url: 'https://videos.pexels.com/video-files/28077187/12294615_1920_1080_30fps.mp4',
    mode: 'history',
    params: { historyShow: 'age', historyLength: 60, frameOffset: 5, secondGap: 30, threshold: 15, ageColorNew: '#ff4400', ageColorOld: '#0044ff' },
    display: 'diff',
    credit: 'Pexels licence',
  },
  {
    // An intersection from high up: cars and people cut out whole, and the
    // ones that stop are absorbed.
    label: 'Crossing from Above',
    url: 'https://videos.pexels.com/video-files/37252006/15781298_1920_1080_60fps.mp4',
    mode: 'background',
    params: { absorbSeconds: 4, threshold: 20, maskShow: 'cutout', frameOffset: 5, trailLength: 0 },
    display: 'diff',
    credit: 'Pexels licence',
  },
  {
    label: 'Motorway',
    url: 'https://videos.pexels.com/video-files/854897/854897-hd_1920_1080_30fps.mp4',
    mode: 'flow',
    params: { flowShow: 'particles', flowGap: 2, flowRange: 40, flowSmoothing: 6, traceDensity: 25, traceLength: 15, traceGain: 1, traceColour: 'heading' },
    display: 'diff',
    credit: 'Pexels licence',
  },
  {
    // A timelapse: cloud streams over a snowy ridge. Slow flow needs a
    // longer gap and a small speed range; shown over the video.
    label: 'Clouds over Peaks',
    url: 'https://videos.pexels.com/video-files/27608396/12184838_1920_1080_24fps.mp4',
    mode: 'flow',
    params: { flowShow: 'particles', flowGap: 4, flowRange: 10, flowSmoothing: 15, traceDensity: 25, traceLength: 15, traceGain: 1, traceColour: 'heading' },
    display: 'glow',
    credit: 'Pexels licence',
  },
  {
    label: 'Weir',
    url: 'https://videos.pexels.com/video-files/7876183/7876183-hd_1920_1080_30fps.mp4',
    mode: 'flow',
    params: { flowShow: 'particles', flowGap: 2, flowRange: 20, flowSmoothing: 6, traceDensity: 25, traceLength: 15, traceGain: 1, traceColour: 'heading' },
    display: 'diff',
    credit: 'Pexels licence',
  },
  {
    // A candle's plume in front of printed random dots, the flame out of
    // frame: the frames show only the dots. Pinned to a commit so it cannot
    // change under us.
    label: 'Candle Plume',
    url: 'https://raw.githubusercontent.com/JPaonaskar/Background-Oriented-Schlieren/f1ca8f60354c05260e2569af7826b5dc8380f9a7/Sample%20Data/Candle.MOV',
    mode: 'schlieren',
    params: { schlierenShow: 'knife', schlierenHold: false, schlierenRange: 25, schlierenWindow: 4, schlierenSmooth: 1, schlierenReference: 60, schlierenSteady: true },
    credit: 'JPaonaskar/Background-Oriented-Schlieren, MIT licence',
  },
];

/**
 * Preset format version. Version 2 thresholds are in raw difference units
 * (mean absolute channel difference, 0..255) in every mode; before that a
 * Posy threshold was measured against the half-difference Posy stores, so
 * the same look needed half the number.
 */
export const PRESET_VERSION = 2;

/** Highest value the threshold control accepts. */
export const MAX_THRESHOLD = 120;

/**
 * Bring preset params saved under an older format up to date. Returns the
 * same object when nothing needs changing.
 *
 * @param {object} params
 * @param {number} [version] - Version the preset was saved under (1 if unmarked)
 * @returns {object}
 */
export function migratePresetParams(params, version = 1) {
  if (!params || version >= PRESET_VERSION) return params;

  const wasPosy = params.algorithm === 'posy' || params.algorithm === undefined;
  if (wasPosy && Number.isFinite(params.threshold)) {
    return { ...params, threshold: Math.min(MAX_THRESHOLD, params.threshold * 2) };
  }
  return params;
}

// Thresholds are in raw difference units (PRESET_VERSION 2).
export const PARAMETER_PRESETS = [
  {
    name: 'Subtle Wind',
    params: {
      frameOffset: 2,
      threshold: 16,
      trailLength: 8,
      channelSpread: 0,
      algorithm: 'posy',
      blurEnabled: false,
    },
  },
  {
    name: 'Ghost Trails',
    params: {
      frameOffset: 10,
      threshold: 24,
      trailLength: 15,
      channelSpread: 2,
      algorithm: 'posy',
      blurEnabled: false,
    },
  },
  {
    name: 'High Contrast',
    params: {
      frameOffset: 3,
      threshold: 5,
      trailLength: 3,
      channelSpread: 0,
      algorithm: 'raw',
      blurEnabled: false,
    },
  },
  {
    name: 'Atmosphere',
    params: {
      frameOffset: 30,
      threshold: 12,
      trailLength: 20,
      channelSpread: 1,
      algorithm: 'posy',
      blurEnabled: true,
    },
  },
  {
    name: 'Rainbow Drift',
    params: {
      frameOffset: 8,
      threshold: 20,
      trailLength: 12,
      channelSpread: 4,
      algorithm: 'posy',
      blurEnabled: false,
    },
  },
];
