// Runs inside a blank page (injected by scripts/filmstrip.mjs). Numeric guard
// for visual changes: how many pixels differ between two filmstrips, and how
// much each flickers where the scene itself is still.
//
// `args`: { a, b, original, meta } — data URLs and the strip geometry.
function load(url) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const c = Object.assign(document.createElement('canvas'), { width: img.width, height: img.height });
      const x = c.getContext('2d', { willReadFrequently: true });
      x.drawImage(img, 0, 0);
      resolve(x.getImageData(0, 0, c.width, c.height));
    };
    img.onerror = () => reject(new Error('image failed to load'));
    img.src = url;
  });
}

const A = await load(args.a);
const B = args.b ? await load(args.b) : null;
const O = args.original ? await load(args.original) : null;
const { cellW, cellH, columns, count } = args.meta;
const W = A.width;

// 1. Share of pixels that differ by more than 4/255 on any channel.
let changed = 0;
let maxDiff = 0;
if (B) {
  for (let i = 0; i < A.data.length; i += 4) {
    const d = Math.max(Math.abs(A.data[i] - B.data[i]), Math.abs(A.data[i + 1] - B.data[i + 1]), Math.abs(A.data[i + 2] - B.data[i + 2]));
    if (d > 4) changed++;
    if (d > maxDiff) maxDiff = d;
  }
}

// 2. Flicker in static areas: mean change between consecutive strip frames
//    over pixels the original video did not change at (within 3/255).
function flicker(img) {
  if (!O) return null;
  let sum = 0;
  let n = 0;
  for (let k = 0; k + 1 < count; k++) {
    const ax = (k % columns) * cellW, ay = Math.floor(k / columns) * cellH;
    const bx = ((k + 1) % columns) * cellW, by = Math.floor((k + 1) / columns) * cellH;
    for (let y = 0; y < cellH; y++) {
      for (let x = 0; x < cellW; x++) {
        const i = ((ay + y) * W + ax + x) * 4;
        const j = ((by + y) * W + bx + x) * 4;
        const still = Math.abs(O.data[i] - O.data[j]) <= 3 && Math.abs(O.data[i + 1] - O.data[j + 1]) <= 3 && Math.abs(O.data[i + 2] - O.data[j + 2]) <= 3;
        if (!still) continue;
        sum += (Math.abs(img.data[i] - img.data[j]) + Math.abs(img.data[i + 1] - img.data[j + 1]) + Math.abs(img.data[i + 2] - img.data[j + 2])) / 3;
        n++;
      }
    }
  }
  return { meanChange: n ? +(sum / n).toFixed(3) : 0, staticShare: +(n / ((count - 1) * cellW * cellH)).toFixed(3) };
}

// 3. Clipping: share of pixels at pure black or pure white.
function clipped(img) {
  let n = 0;
  for (let i = 0; i < img.data.length; i += 4) {
    const lo = img.data[i] === 0 && img.data[i + 1] === 0 && img.data[i + 2] === 0;
    const hi = img.data[i] === 255 && img.data[i + 1] === 255 && img.data[i + 2] === 255;
    if (lo || hi) n++;
  }
  return +((n / (img.data.length / 4)) * 100).toFixed(2);
}

// 4. Mean colour, for telling a hue or brightness shift from a change of shape.
function meanColour(img) {
  const sum = [0, 0, 0];
  for (let i = 0; i < img.data.length; i += 4) { sum[0] += img.data[i]; sum[1] += img.data[i + 1]; sum[2] += img.data[i + 2]; }
  return sum.map((v) => +(v / (img.data.length / 4)).toFixed(2));
}

return {
  changedPct: B ? +((changed / (A.data.length / 4)) * 100).toFixed(3) : null,
  maxDiff: B ? maxDiff : null,
  flickerA: flicker(A),
  flickerB: B ? flicker(B) : null,
  clippedPctA: clipped(A),
  clippedPctB: B ? clipped(B) : null,
  meanA: meanColour(A),
  meanB: B ? meanColour(B) : null,
};
