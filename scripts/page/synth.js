// Runs inside a blank page (injected by scripts/filmstrip.mjs). Records a
// synthetic clip with known motion, for checks that need ground truth.
//
// `args`: { kind: 'truth' | 'truth-noisy' | 'sixty' | 'pulse' }
//
// truth (12 s, 30 fps, 640x360), all on a static textured background:
//   - a bright 60 px square at y = 80..140 moving right at 120 px/s; it runs
//     for 3.5 s, STOPS for 5 s (3.5 s to 8.5 s), then moves on and leaves
//   - a disc of radius 22 moving down-right at 30 degrees, 104 px/s, from t = 0
//   - a disc moving left (180 degrees) at 100 px/s along y = 300 from t = 6 s
//   - per-pixel noise of amplitude 3 ('truth') or 16 ('truth-noisy')
// sixty: the square and first disc at 60 fps, 5 s.
// pulse: a still skin-toned patch whose brightness swings by ±1.2 levels at
//   1.2 Hz (72 bpm) on a static background, 12 s. Invisible to the eye.
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const W = 640;
const H = 360;
const kind = args.kind;
const FPS = kind === 'sixty' ? 60 : 30;
const SECONDS = kind === 'sixty' ? 5 : 12;
const NOISE = kind === 'truth-noisy' ? 16 : kind === 'pulse' ? 2 : 3;

let seed = 20261113;
const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 4294967296; };

// Static background, drawn once: a gradient with blocks and stripes so a
// background model has structure to learn.
const bg = Object.assign(document.createElement('canvas'), { width: W, height: H });
const bx = bg.getContext('2d');
const grad = bx.createLinearGradient(0, 0, W, H);
grad.addColorStop(0, '#2a3a4a'); grad.addColorStop(1, '#6a5a48');
bx.fillStyle = grad; bx.fillRect(0, 0, W, H);
for (let i = 0; i < 26; i++) {
  bx.fillStyle = `rgb(${40 + random() * 90 | 0}, ${50 + random() * 90 | 0}, ${50 + random() * 90 | 0})`;
  bx.fillRect(random() * W | 0, random() * H | 0, 20 + random() * 70 | 0, 12 + random() * 50 | 0);
}
for (let x = 0; x < W; x += 16) { bx.fillStyle = 'rgba(0,0,0,.12)'; bx.fillRect(x, 0, 2, H); }

const cv = Object.assign(document.createElement('canvas'), { width: W, height: H });
const ctx = cv.getContext('2d', { willReadFrequently: true });
const stream = cv.captureStream(0);
const track = stream.getVideoTracks()[0];
const rec = new MediaRecorder(stream, { mimeType: 'video/webm;codecs=vp8', videoBitsPerSecond: 10e6 });
const chunks = [];
rec.ondataavailable = (e) => e.data.size && chunks.push(e.data);
const stopped = new Promise((r) => (rec.onstop = r));
rec.start();

const start = performance.now();
for (let f = 0; f < FPS * SECONDS; f++) {
  const t = f / FPS;
  ctx.drawImage(bg, 0, 0);

  if (kind === 'pulse') {
    const swing = 1.2 * Math.sin(2 * Math.PI * 1.2 * t);
    ctx.fillStyle = `rgb(${196 + swing}, ${150 + swing * 0.7}, ${128 + swing * 0.5})`;
    ctx.beginPath(); ctx.ellipse(320, 180, 110, 140, 0, 0, 7); ctx.fill();
  } else {
    // Square: move, stop, move on.
    const moved = kind === 'sixty' ? t : (t < 3.5 ? t : t < 8.5 ? 3.5 : t - 5);
    ctx.fillStyle = '#f0f0f0';
    ctx.fillRect(40 + 120 * moved, 80, 60, 60);
    // Disc heading down-right at 30 degrees.
    ctx.fillStyle = '#c8d4e0';
    ctx.beginPath(); ctx.arc(60 + 90 * t, 150 + 52 * t, 22, 0, 7); ctx.fill();
    // Disc heading left.
    if (t >= 6) { ctx.fillStyle = '#e0c8a8'; ctx.beginPath(); ctx.arc(660 - 100 * (t - 6), 300, 22, 0, 7); ctx.fill(); }
  }

  if (NOISE > 0) {
    const img = ctx.getImageData(0, 0, W, H);
    const d = img.data;
    for (let i = 0; i < d.length; i += 4) {
      const n = (random() - 0.5) * 2 * NOISE;
      d[i] += n; d[i + 1] += n; d[i + 2] += n;
    }
    ctx.putImageData(img, 0, 0);
  }

  track.requestFrame();
  // Pace against the wall clock so frame timestamps land on the grid.
  const due = start + ((f + 1) * 1000) / FPS;
  await wait(Math.max(0, due - performance.now()));
}
rec.stop();
await stopped;

const blob = new Blob(chunks, { type: 'video/webm' });
const dataUrl = await new Promise((resolve) => { const r = new FileReader(); r.onload = () => resolve(r.result); r.readAsDataURL(blob); });
return { dataUrl, bytes: blob.size, fps: FPS, seconds: SECONDS };
