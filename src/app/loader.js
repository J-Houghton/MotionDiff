export function isDashUrl(url) {
  return /\.mpd($|\?)/i.test(url);
}

export function isHlsUrl(url) {
  return /\.m3u8($|\?)/i.test(url) || /\/hls\//i.test(url);
}

export function isYouTubeUrl(url) {
  return /(?:youtube\.com|youtu\.be)/i.test(url);
}
