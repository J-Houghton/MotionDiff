const STREAM_SOURCES = new Set(['camera']);

export function isStreamSource(kind) {
  return STREAM_SOURCES.has(kind);
}

export function buildSourceProfile(kind, hasRvfc) {
  const isStream = isStreamSource(kind);
  return {
    kind,
    isStream,
    frameCapture: isStream ? 'draw-image'
      : hasRvfc ? 'video-frame'
      : 'draw-image',
  };
}
