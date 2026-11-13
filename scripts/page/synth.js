// Runs inside a blank page (injected by scripts/filmstrip.mjs after scene.js).
// Records a synthetic scene as a clip, for loading into the app by hand.
// Browser-recorded WebM cannot be seeked frame-accurately, so filmstrips do
// not use these files: render.js steps the scene directly.
//
// `args`: { kind: 'truth' | 'truth-noisy' | 'sixty' | 'pulse' }
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const scene = makeScene(args.kind);

const cv = Object.assign(document.createElement('canvas'), { width: scene.width, height: scene.height });
const ctx = cv.getContext('2d', { willReadFrequently: true });
const stream = cv.captureStream(0);
const track = stream.getVideoTracks()[0];
const rec = new MediaRecorder(stream, { mimeType: 'video/webm;codecs=vp8', videoBitsPerSecond: args.kind === 'truth-noisy' ? 8e6 : 5e6 });
const chunks = [];
rec.ondataavailable = (e) => e.data.size && chunks.push(e.data);
const stopped = new Promise((r) => (rec.onstop = r));
rec.start();

const start = performance.now();
for (let f = 0; f < scene.fps * scene.seconds; f++) {
  scene.draw(ctx, f);
  track.requestFrame();
  // Pace against the wall clock so frame timestamps land on the grid.
  await wait(Math.max(0, start + ((f + 1) * 1000) / scene.fps - performance.now()));
}
rec.stop();
await stopped;

const blob = new Blob(chunks, { type: 'video/webm' });
const dataUrl = await new Promise((resolve) => { const r = new FileReader(); r.onload = () => resolve(r.result); r.readAsDataURL(blob); });
return { dataUrl, bytes: blob.size, fps: scene.fps, seconds: scene.seconds };
