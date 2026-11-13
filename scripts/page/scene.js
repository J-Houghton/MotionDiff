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
// plume, plume-weak, plume-wall, plume-drift: see the end of this file.
function makeScene(kind) {
  if (kind === 'flow') return makeFlowScene();
  if (kind.startsWith('plume')) return makePlumeScene(kind);
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

// ── Schlieren: a background seen through a synthetic plume of hot air ──
// plume (8 s at 30 fps, 640x360): a printed-style background of random 3 px
//   squares, warped by a known displacement field. Nothing happens for the
//   first second (a clean reference); the source is "lit" between 1.0 s and
//   1.5 s. Above it: a smooth column for the first 100 px, and eddies that
//   rise at about 150 px/s inside a widening cone. Peak shift 0.3 px.
// plume-weak: the same with a peak of 0.08 px.
// plume-wall: a rough natural surface (blotches with a fine grain, like
//   plaster or gravel) instead of the print, plain from x = 345 on.
// plume-drift: the camera creeps 0.4 px over the clip and trembles by 0.08 px.

/**
 * The plume's displacement field: by how much the background appears shifted
 * at a place and time, in pixels. Pure (no DOM), so scripts/truth-check.mjs
 * evaluates this file and calls it too.
 */
function plumeField(kind) {
  const peak = kind === 'plume-weak' ? 0.08 : 0.3;
  const source = { x: 320, y: 345 };
  const rise = 150;         // px/s, mean speed of the eddies
  const span = 345;         // an eddy lives over this height, then starts again
  const columnHeight = 100; // the smooth column above the source
  let s = 20261113;
  const random = () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296; };
  const eddies = Array.from({ length: 46 }, () => ({
    side: random() * 2 - 1,                 // where across the cone, −1..1
    phase: random(),                        // where along its life at t = 0
    radius: 8 + random() * 12,
    gain: (0.55 + random() * 0.45) * (random() < 0.5 ? -1 : 1),
    speed: rise * (0.92 + random() * 0.16),
  }));
  const halfWidth = (h) => 10 + 0.18 * h;
  const ramp = (a, b, v) => { const u = Math.min(1, Math.max(0, (v - a) / (b - a))); return u * u * (3 - 2 * u); };
  const lit = (t) => ramp(1.0, 1.5, t);

  /** Where each eddy is at time t: [{x, y, radius, gain}], gain including its fade at both ends. */
  function eddiesAt(t) {
    return eddies.map((e) => {
      const h = (e.phase * span + e.speed * t) % span;
      const fade = ramp(30, 80, h) * (1 - ramp(span - 70, span - 10, h));
      return { x: source.x + e.side * halfWidth(h) * 0.8, y: source.y - h, radius: e.radius, gain: e.gain * fade };
    });
  }

  /** Displacement at (x, y) and time t → [dx, dy]. For many pixels use fieldAt. */
  function displacement(x, y, t) {
    let dx = 0;
    let dy = 0;
    for (const e of eddiesAt(t)) {
      const rx = x - e.x;
      const ry = y - e.y;
      const q = (rx * rx + ry * ry) / (2 * e.radius * e.radius);
      if (q > 8) continue;
      const g = (-e.gain * Math.exp(-q)) / e.radius;
      dx += g * rx;
      dy += g * ry;
    }
    const h = source.y - y;
    if (h > 0 && h < columnHeight + 20) {
      const w = 7 + 0.05 * h;
      const rx = x - source.x;
      dx += (-1.1 * rx * Math.exp(-(rx * rx) / (2 * w * w)) * (1 - ramp(columnHeight - 30, columnHeight + 20, h)) * ramp(0, 12, h)) / w;
    }
    // A unit gain gives a slope of exp(-1/2) at its steepest.
    const scale = (peak / 0.607) * lit(t);
    return [dx * scale, dy * scale];
  }

  /** The whole field at time t: Float32Array, 2 per pixel. */
  function fieldAt(t, width, height) {
    const out = new Float32Array(width * height * 2);
    const scale = (peak / 0.607) * lit(t);
    if (scale === 0) return out;
    for (const e of eddiesAt(t)) {
      if (e.gain === 0) continue;
      const reach = Math.ceil(e.radius * 4);
      const x0 = Math.max(0, Math.floor(e.x - reach));
      const x1 = Math.min(width - 1, Math.ceil(e.x + reach));
      const y0 = Math.max(0, Math.floor(e.y - reach));
      const y1 = Math.min(height - 1, Math.ceil(e.y + reach));
      for (let y = y0; y <= y1; y++) {
        for (let x = x0; x <= x1; x++) {
          const rx = x - e.x;
          const ry = y - e.y;
          const g = (-e.gain * scale * Math.exp(-(rx * rx + ry * ry) / (2 * e.radius * e.radius))) / e.radius;
          out[(y * width + x) * 2] += g * rx;
          out[(y * width + x) * 2 + 1] += g * ry;
        }
      }
    }
    for (let y = Math.max(0, source.y - columnHeight - 20); y < Math.min(height, source.y); y++) {
      const h = source.y - y;
      const w = 7 + 0.05 * h;
      const along = (1 - ramp(columnHeight - 30, columnHeight + 20, h)) * ramp(0, 12, h) * scale * -1.1;
      for (let x = Math.max(0, source.x - 60); x < Math.min(width, source.x + 60); x++) {
        const rx = x - source.x;
        out[(y * width + x) * 2] += (along * rx * Math.exp(-(rx * rx) / (2 * w * w))) / w;
      }
    }
    return out;
  }

  /** Inside the cone the eddies travel in (grown by `margin` pixels)? */
  const inPlume = (x, y, margin = 0) => {
    const h = source.y - y;
    return h > -margin && h < span + margin && Math.abs(x - source.x) <= halfWidth(Math.max(0, h)) * 0.8 + 22 + margin;
  };

  return { peak, source, rise, span, columnHeight, displacement, fieldAt, inPlume, lit };
}

function makePlumeScene(kind) {
  const width = 640;
  const height = 360;
  const fps = 30;
  const seconds = 8;
  const field = plumeField(kind);
  const lcg = (seed) => { let s = seed >>> 0; return () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296; }; };

  // The background as luma, with a margin so a shifted read stays inside.
  const M = 4;
  const bw = width + 2 * M;
  const bh = height + 2 * M;
  const background = new Float32Array(bw * bh);
  if (kind === 'plume-wall') {
    const wall = textureCanvas(bw, bh, 55, [118, 110, 100]);
    const data = wall.getContext('2d').getImageData(0, 0, bw, bh).data;
    // A fine grain over the blotches: per-pixel roughness, softened over 3x3.
    const random = lcg(808);
    const rough = Float32Array.from({ length: bw * bh }, () => (random() - 0.5) * 90);
    const grain = (x, y) => {
      let sum = 0;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) sum += rough[Math.min(bh - 1, Math.max(0, y + dy)) * bw + Math.min(bw - 1, Math.max(0, x + dx))];
      return sum / 9;
    };
    for (let p = 0; p < bw * bh; p++) {
      const x = p % bw;
      background[p] = x - M >= 345 ? 120 : 0.2126 * data[p * 4] + 0.7152 * data[p * 4 + 1] + 0.0722 * data[p * 4 + 2] + grain(x, Math.floor(p / bw));
    }
  } else {
    // Random 3 px squares, softened as a lens would.
    const random = lcg(4711);
    const cols = Math.ceil(bw / 3);
    const cells = Uint8Array.from({ length: cols * Math.ceil(bh / 3) }, () => (random() < 0.5 ? 1 : 0));
    const sharp = new Float32Array(bw * bh);
    for (let y = 0; y < bh; y++) for (let x = 0; x < bw; x++) sharp[y * bw + x] = cells[Math.floor(y / 3) * cols + Math.floor(x / 3)] ? 205 : 50;
    for (let y = 0; y < bh; y++) {
      for (let x = 0; x < bw; x++) {
        const xa = Math.max(0, x - 1), xb = Math.min(bw - 1, x + 1), ya = Math.max(0, y - 1), yb = Math.min(bh - 1, y + 1);
        background[y * bw + x] = (sharp[y * bw + x] * 4 + sharp[y * bw + xa] * 2 + sharp[y * bw + xb] * 2 + sharp[ya * bw + x] * 2 + sharp[yb * bw + x] * 2
          + sharp[ya * bw + xa] + sharp[ya * bw + xb] + sharp[yb * bw + xa] + sharp[yb * bw + xb]) / 16;
      }
    }
  }
  const read = (x, y) => {
    const fx = Math.min(bw - 1.001, Math.max(0, x + M));
    const fy = Math.min(bh - 1.001, Math.max(0, y + M));
    const x0 = Math.floor(fx), y0 = Math.floor(fy);
    const tx = fx - x0, ty = fy - y0;
    const a = background[y0 * bw + x0], b = background[y0 * bw + x0 + 1];
    const c = background[(y0 + 1) * bw + x0], d = background[(y0 + 1) * bw + x0 + 1];
    return a + (b - a) * tx + (c - a + (a - b - c + d) * tx) * ty;
  };

  /** How far the camera has wandered at time t, in pixels. */
  const camera = (t) => (kind === 'plume-drift'
    ? [0.4 * (t / seconds) + 0.08 * Math.sin(2 * Math.PI * 1.3 * t), 0.05 * Math.sin(2 * Math.PI * 0.9 * t + 1)]
    : [0, 0]);

  function truth(frame) {
    const t = frame / fps;
    return { t, plume: kind, peak: field.peak, source: field.source, rise: field.rise, heading: 270, lit: +field.lit(t).toFixed(3), camera: camera(t) };
  }

  function draw(ctx, frame) {
    const t = frame / fps;
    const shift = field.fieldAt(t, width, height);
    const [cx, cy] = camera(t);
    const rnd = lcg(977 + frame * 7919);
    const img = ctx.createImageData(width, height);
    const d = img.data;
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const p = y * width + x;
        // The background is seen shifted by the field (and by the camera).
        const value = read(x - shift[p * 2] - cx, y - shift[p * 2 + 1] - cy) + (rnd() - 0.5) * 6;
        d[p * 4] = value;
        d[p * 4 + 1] = value * 0.97 + 3;
        d[p * 4 + 2] = value * 0.92 + 8;
        d[p * 4 + 3] = 255;
      }
    }
    ctx.putImageData(img, 0, 0);
  }

  return { width, height, fps, seconds, draw, truth };
}
