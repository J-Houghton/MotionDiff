/**
 * Sample clips offered in the source picker. They are not part of the
 * project: each is played from where its owner hosts it (the host must allow
 * cross-origin reads, or the frames cannot reach WebGL).
 *
 *   label    shown on the button
 *   url      the file
 *   preset   optional: the name of the PARAMETER_PRESETS entry the sample
 *            opens with. The preset is the one source of truth for the
 *            sample's mode, settings and display, and the same look is
 *            offered in the panel's Preset list for any footage.
 *   credit   where it comes from and under what licence
 *
 * A sample without a preset keeps whatever mode and settings are current.
 */
export const TEST_CLIPS = [
  {
    label: 'Trees in Wind',
    url: 'https://videos.pexels.com/video-files/1254570/1254570-hd_1920_1080_30fps.mp4',
    preset: 'Trees in Wind',
    credit: 'Pexels licence',
  },
  {
    label: 'Flowing River',
    url: 'https://videos.pexels.com/video-files/6981415/6981415-hd_1920_1080_25fps.mp4',
    preset: 'Flowing Water',
    credit: 'Pexels licence',
  },
  {
    label: 'Sunset Timelapse',
    url: 'https://videos.pexels.com/video-files/5646694/5646694-hd_1920_1080_30fps.mp4',
    preset: 'Sunset Timelapse',
    credit: 'Pexels licence',
  },
  // Samples that show off a mode, in mode order. Each was checked in its mode
  // with these settings (static camera, or the whole frame would light up).
  {
    // A sleeping kitten on a locked-off camera: the breathing (about 40
    // breaths a minute — normal for a kitten) is nearly invisible in the
    // video and plain under magnification. It stirs once around 6.5 s.
    label: 'Sleeping Kitten',
    url: 'https://videos.pexels.com/video-files/13925469/13925469-hd_1920_1080_30fps.mp4',
    preset: 'Sleeping Kitten',
    credit: 'Pexels licence',
  },
  {
    // A timelapse: a flower unfolds against a still wall.
    label: 'Flower Opening',
    url: 'https://videos.pexels.com/video-files/12538831/12538831-hd_1920_1080_30fps.mp4',
    preset: 'Flower Opening',
    credit: 'Pexels licence',
  },
  {
    // Dozens of bees on a plain wall: each is cut out where it is.
    label: 'Bees at the Hive',
    url: 'https://videos.pexels.com/video-files/9491523/9491523-hd_1920_1080_25fps.mp4',
    preset: 'Bees at the Hive',
    credit: 'Pexels licence',
  },
  {
    // A few gulls against clear sky: each leaves a ribbon along its path.
    label: 'Gulls Overhead',
    url: 'https://videos.pexels.com/video-files/28077187/12294615_1920_1080_30fps.mp4',
    preset: 'Gulls Overhead',
    credit: 'Pexels licence',
  },
  {
    // An intersection from high up: cars and people cut out whole, and the
    // ones that stop are absorbed.
    label: 'Crossing from Above',
    url: 'https://videos.pexels.com/video-files/37252006/15781298_1920_1080_60fps.mp4',
    preset: 'Crossing from Above',
    credit: 'Pexels licence',
  },
  {
    label: 'Motorway',
    url: 'https://videos.pexels.com/video-files/854897/854897-hd_1920_1080_30fps.mp4',
    preset: 'Motorway',
    credit: 'Pexels licence',
  },
  {
    // A timelapse: cloud streams over a snowy ridge. Slow flow needs a
    // longer gap and a small speed range; shown over the video.
    label: 'Clouds over Peaks',
    url: 'https://videos.pexels.com/video-files/27608396/12184838_1920_1080_24fps.mp4',
    preset: 'Clouds over Peaks',
    credit: 'Pexels licence',
  },
  {
    label: 'Weir',
    url: 'https://videos.pexels.com/video-files/7876183/7876183-hd_1920_1080_30fps.mp4',
    preset: 'Flowing Water',
    credit: 'Pexels licence',
  },
  {
    // A candle's plume in front of printed random dots, the flame out of
    // frame: the frames show only the dots. Pinned to a commit so it cannot
    // change under us.
    label: 'Candle Plume',
    url: 'https://raw.githubusercontent.com/JPaonaskar/Background-Oriented-Schlieren/f1ca8f60354c05260e2569af7826b5dc8380f9a7/Sample%20Data/Candle.MOV',
    preset: 'Candle Plume',
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
// One list serves both uses: the panel's Preset select offers every entry
// for whatever footage is loaded, and a sample names the entry it opens
// with (TEST_CLIPS.preset) — the samples' looks are not a second preset
// system. `display` is optional; a preset without one keeps the current
// display.
export const PARAMETER_PRESETS = [
  // Hand-made Posy and Raw looks. (Subtle Wind lives on as Trees in Wind,
  // Atmosphere as Sunset Timelapse: the same tuning, named by the footage
  // that shows it off.)
  {
    name: 'Trees in Wind',
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
    name: 'Sunset Timelapse',
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
  // The looks the samples open with, named after their sample. Each was
  // checked on its footage (static camera, or the whole frame would light
  // up); on other footage they are starting points.
  {
    name: 'Sleeping Kitten',
    params: { algorithm: 'magnify', magAmp: 20, magFreqLow: 0.15, magFreqHigh: 1.0, magChroma: 1, magDownsample: 2, blurEnabled: false },
  },
  {
    name: 'Flower Opening',
    display: 'diff',
    params: { algorithm: 'posy', frameOffset: 30, threshold: 8, trailLength: 20, channelSpread: 2, blurEnabled: false, ageColorEnabled: false },
  },
  {
    name: 'Bees at the Hive',
    display: 'diff',
    params: { algorithm: 'mask', frameOffset: 3, secondGap: 30, threshold: 20, maskBlur: true, maskClean: true, maskShow: 'cutout', trailLength: 5 },
  },
  {
    name: 'Gulls Overhead',
    display: 'diff',
    params: { algorithm: 'history', historyShow: 'age', historyLength: 60, frameOffset: 5, secondGap: 30, threshold: 15, ageColorNew: '#ff4400', ageColorOld: '#0044ff' },
  },
  {
    name: 'Crossing from Above',
    display: 'diff',
    params: { algorithm: 'background', absorbSeconds: 4, threshold: 20, maskShow: 'cutout', frameOffset: 5, trailLength: 0 },
  },
  {
    name: 'Motorway',
    display: 'diff',
    params: { algorithm: 'flow', flowShow: 'particles', flowGap: 2, flowRange: 40, flowSmoothing: 6, traceDensity: 25, traceLength: 15, traceGain: 1, traceColour: 'heading' },
  },
  {
    name: 'Clouds over Peaks',
    display: 'glow',
    params: { algorithm: 'flow', flowShow: 'particles', flowGap: 4, flowRange: 10, flowSmoothing: 15, traceDensity: 25, traceLength: 15, traceGain: 1, traceColour: 'heading' },
  },
  {
    // One water look serves the river and the weir.
    name: 'Flowing Water',
    display: 'diff',
    params: { algorithm: 'flow', flowShow: 'particles', flowGap: 2, flowRange: 20, flowSmoothing: 6, traceDensity: 25, traceLength: 15, traceGain: 1, traceColour: 'heading' },
  },
  {
    name: 'Candle Plume',
    params: { algorithm: 'schlieren', schlierenShow: 'knife', schlierenHold: false, schlierenRange: 25, schlierenWindow: 4, schlierenSmooth: 1, schlierenReference: 60, schlierenSteady: true },
  },
];

/** @param {string} name @returns {{name: string, display?: string, params: object}|null} */
export function getPreset(name) {
  return PARAMETER_PRESETS.find((preset) => preset.name === name) || null;
}
