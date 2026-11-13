// Synthetic scenes with known motion. Prepended to synth.js (which records
// them as clips for watching) and render.js (which steps them frame by frame
// through the pipeline, so every frame's ground truth is exact).
//
//   makeScene(kind) → { width, height, fps, seconds, draw(ctx, frame), truth(frame) }
//
// truth / truth-noisy (12 s at 30 fps, 640x360), on a static textured background:
//   - a bright 60 px square at y = 80..140 moving right at 120 px/s: it runs
//     for 3.5 s, STOPS for 5 s (3.5 s to 8.5 s), then moves on and leaves
//   - a disc of radius 22 heading down-right at 30 degrees, 104 px/s
//   - a disc heading left (180 degrees) at 100 px/s along y = 300, from t = 6 s
//   - per-pixel noise of amplitude 3 (truth) or 16 (truth-noisy)
// sixty: the square (never stopping) and the first disc at 60 fps, 5 s.
// pulse: a still skin-toned patch whose brightness swings by ±1.2 levels at
//   1.2 Hz (72 bpm), 12 s. Invisible to the eye.
// flow (8 s at 30 fps): textured movers on a still textured background, for
//   optical flow and particle traces (the flat objects of `truth` carry flow
//   only at their rims):
//   - a band across the top (y = 30..110) sliding right at 90 px/s
//   - a 120x90 block heading down-left (135 degrees) at 60 px/s
//   - a disc of radius 75 at (150, 245) turning clockwise at 1 rad/s: 75 px/s
//     at its rim, nothing at its centre
function makeScene(kind) {
  if (kind === 'flow') return makeFlowScene();
  const width = 640;
  const height = 360;
  const fps = kind === 'sixty' ? 60 : 30;
  const seconds = kind === 'sixty' ? 5 : 12;
  const noise = kind === 'truth-noisy' ? 16 : kind === 'pulse' ? 2 : 3;

  const lcg = (seed) => { let s = seed >>> 0; return () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296; }; };

  // Static background, drawn once: a gradient with blocks and stripes so a
  // background model has structure to learn.
  const bg = Object.assign(document.createElement('canvas'), { width, height });
  const bx = bg.getContext('2d');
  const random = lcg(20261113);
  const grad = bx.createLinearGradient(0, 0, width, height);
  grad.addColorStop(0, '#2a3a4a'); grad.addColorStop(1, '#6a5a48');
  bx.fillStyle = grad; bx.fillRect(0, 0, width, height);
  for (let i = 0; i < 26; i++) {
    bx.fillStyle = `rgb(${40 + random() * 90 | 0}, ${50 + random() * 90 | 0}, ${50 + random() * 90 | 0})`;
    bx.fillRect(random() * width | 0, random() * height | 0, 20 + random() * 70 | 0, 12 + random() * 50 | 0);
  }
  for (let x = 0; x < width; x += 16) { bx.fillStyle = 'rgba(0,0,0,.12)'; bx.fillRect(x, 0, 2, height); }

  /** Where everything is at a frame, in pixels; angles in degrees, y down. */
  function truth(frame) {
    const t = frame / fps;
    if (kind === 'pulse') return { t, patch: { cx: 320, cy: 180, rx: 110, ry: 140, hz: 1.2 } };
    const moved = kind === 'sixty' ? t : (t < 3.5 ? t : t < 8.5 ? 3.5 : t - 5);
    const out = {
      t,
      square: { x: 40 + 120 * moved, y: 80, size: 60, moving: kind === 'sixty' || t < 3.5 || t >= 8.5, angle: 0, speed: 120 },
      disc: { cx: 60 + 90 * t, cy: 150 + 52 * t, r: 22, angle: 30, speed: 104 },
    };
    if (kind !== 'sixty' && t >= 6) out.disc2 = { cx: 660 - 100 * (t - 6), cy: 300, r: 22, angle: 180, speed: 100 };
    return out;
  }

  function draw(ctx, frame) {
    const state = truth(frame);
    ctx.drawImage(bg, 0, 0);
    if (state.patch) {
      const swing = 1.2 * Math.sin(2 * Math.PI * state.patch.hz * state.t);
      ctx.fillStyle = `rgb(${196 + swing}, ${150 + swing * 0.7}, ${128 + swing * 0.5})`;
      ctx.beginPath(); ctx.ellipse(state.patch.cx, state.patch.cy, state.patch.rx, state.patch.ry, 0, 0, 7); ctx.fill();
    } else {
      ctx.fillStyle = '#f0f0f0';
      ctx.fillRect(state.square.x, state.square.y, state.square.size, state.square.size);
      ctx.fillStyle = '#c8d4e0';
      ctx.beginPath(); ctx.arc(state.disc.cx, state.disc.cy, state.disc.r, 0, 7); ctx.fill();
      if (state.disc2) { ctx.fillStyle = '#e0c8a8'; ctx.beginPath(); ctx.arc(state.disc2.cx, state.disc2.cy, state.disc2.r, 0, 7); ctx.fill(); }
    }
    if (noise > 0) {
      // Seeded per frame, so a frame looks the same whenever it is drawn.
      const rnd = lcg(977 + frame * 7919);
      const img = ctx.getImageData(0, 0, width, height);
      const d = img.data;
      for (let i = 0; i < d.length; i += 4) {
        const n = (rnd() - 0.5) * 2 * noise;
        d[i] += n; d[i + 1] += n; d[i + 2] += n;
      }
      ctx.putImageData(img, 0, 0);
    }
  }

  return { width, height, fps, seconds, draw, truth };
}

/** A canvas of overlapping blobs and specks: texture at every scale, like a natural surface. */
function textureCanvas(width, height, seed, tone) {
  let s = seed >>> 0;
  const random = () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296; };
  const canvas = Object.assign(document.createElement('canvas'), { width, height });
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = `rgb(${tone[0]}, ${tone[1]}, ${tone[2]})`;
  ctx.fillRect(0, 0, width, height);
  const blobs = Math.round((width * height) / 90);
  for (let n = 0; n < blobs; n++) {
    const size = 2 + random() * random() * 34;
    const shade = (random() - 0.5) * 150;
    ctx.fillStyle = `rgba(${tone[0] + shade | 0}, ${tone[1] + shade * 0.9 | 0}, ${tone[2] + shade * 0.8 | 0}, 0.75)`;
    ctx.beginPath();
    ctx.ellipse(random() * width, random() * height, size, size * (0.4 + random() * 0.6), random() * 3.2, 0, 7);
    ctx.fill();
  }
  return canvas;
}

function makeFlowScene() {
  const width = 640;
  const height = 360;
  const fps = 30;
  const seconds = 8;
  const lcg = (seed) => { let s = seed >>> 0; return () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296; }; };

  const BAND = { y: 30, h: 80, angle: 0, speed: 90, period: 1024 };
  const BLOCK = { x0: 500, y0: 120, w: 120, h: 90, angle: 135, speed: 60 };
  const DISC = { cx: 150, cy: 245, r: 75, omega: 1 };
  const bg = textureCanvas(width, height, 11, [92, 100, 108]);
  const band = textureCanvas(BAND.period, BAND.h, 22, [120, 104, 88]);
  const block = textureCanvas(BLOCK.w, BLOCK.h, 33, [84, 112, 96]);
  const disc = textureCanvas(DISC.r * 2, DISC.r * 2, 44, [104, 92, 120]);

  function truth(frame) {
    const t = frame / fps;
    const a = (BLOCK.angle * Math.PI) / 180;
    return {
      t,
      band: { y: BAND.y, h: BAND.h, angle: BAND.angle, speed: BAND.speed },
      block: { x: BLOCK.x0 + Math.cos(a) * BLOCK.speed * t, y: BLOCK.y0 + Math.sin(a) * BLOCK.speed * t, w: BLOCK.w, h: BLOCK.h, angle: BLOCK.angle, speed: BLOCK.speed },
      disc: { ...DISC },
    };
  }

  function draw(ctx, frame) {
    const state = truth(frame);
    ctx.drawImage(bg, 0, 0);
    const shift = (BAND.speed * state.t) % BAND.period;
    ctx.save();
    ctx.beginPath(); ctx.rect(0, BAND.y, width, BAND.h); ctx.clip();
    ctx.drawImage(band, shift - BAND.period, BAND.y);
    ctx.drawImage(band, shift, BAND.y);
    ctx.restore();
    ctx.drawImage(block, state.block.x, state.block.y);
    ctx.save();
    ctx.translate(DISC.cx, DISC.cy);
    ctx.rotate(DISC.omega * state.t);
    ctx.beginPath(); ctx.arc(0, 0, DISC.r, 0, 7); ctx.clip();
    ctx.drawImage(disc, -DISC.r, -DISC.r);
    ctx.restore();

    const rnd = lcg(977 + frame * 7919);
    const img = ctx.getImageData(0, 0, width, height);
    const d = img.data;
    for (let i = 0; i < d.length; i += 4) {
      const n = (rnd() - 0.5) * 6;
      d[i] += n; d[i + 1] += n; d[i + 2] += n;
    }
    ctx.putImageData(img, 0, 0);
  }

  return { width, height, fps, seconds, draw, truth };
}
