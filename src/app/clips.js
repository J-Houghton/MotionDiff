export const TEST_CLIPS = [
  {
    label: 'Trees in Wind',
    url: 'https://videos.pexels.com/video-files/1254570/1254570-hd_1920_1080_30fps.mp4',
  },
  {
    label: 'Flowing River',
    url: 'https://videos.pexels.com/video-files/6981415/6981415-hd_1920_1080_25fps.mp4',
  },
  {
    label: 'Sunset Timelapse',
    url: 'https://videos.pexels.com/video-files/5646694/5646694-hd_1920_1080_30fps.mp4',
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
