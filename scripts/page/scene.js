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
function makeScene(kind) {
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
