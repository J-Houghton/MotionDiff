// Checks a mode's data output against the known positions in the synthetic
// `truth` scenes (scripts/page/scene.js). Reads what `filmstrip render` wrote
// for a scene with "readData": true.
//
//   node scripts/truth-check.mjs --dir filmstrips --tag mask --scene truth-mask --gap 5
//   node scripts/truth-check.mjs --dir filmstrips --tag history --scene truth-direction --history 1
//
// Prints, for the last captured frame: how many pixels the mode marks (data
// R > 0.5 for a mask, > 0 otherwise), and where they lie:
//   current   inside an object's outline now (grown by 2 px for blur)
//   ghost     inside its outline `gap` frames ago, outside the current one
//   elsewhere anywhere else (noise)
// and how much of each region is covered. With --box x,y,w,h (scene pixels)
// it also says how much of that box is marked: for a place where something
// used to stand.
//
// For a vector field (motion history) it prints instead, per object: the mean
// heading over its trail against the known heading, and the age sampled along
// the path behind it, which should only rise.
//
// With --flow 1 (optical flow: data G, B = velocity in pixels per second) it
// prints, per mover of the `flow` scene, the heading and speed measured
// against the truth, and for any scene how much of the still background reads
// under 5 px/s.
//   node scripts/truth-check.mjs --dir filmstrips --tag flow --scene flow-colour --flow 1
import fs from 'node:fs';
import path from 'node:path';

const args = {};
for (let i = 2; i < process.argv.length; i += 2) args[process.argv[i].replace(/^--/, '')] = process.argv[i + 1];
const dir = args.dir || 'filmstrips';
const tag = args.tag ? `${args.tag}-` : '';
const gap = Number(args.gap || 5);

const meta = JSON.parse(fs.readFileSync(path.join(dir, `${tag}meta.json`), 'utf8'))[args.scene];
const data = JSON.parse(fs.readFileSync(path.join(dir, `${tag}${args.scene}.data.json`), 'utf8'));
if (!meta?.truth) throw new Error(`Scene "${args.scene}" has no truth: it must use a synthetic clip`);
const now = meta.truth[meta.truth.length - 1];

// The scenes are 640x360; the data field may be smaller.
const scale = data.width / 640;
const fps = 30;
const back = gap / fps;

/** Outlines at a time offset: the objects move in straight lines. */
function outlines(state, dt, grow) {
  const shapes = [];
  const move = (o) => {
    if (o.moving === false) return [0, 0];
    const a = (o.angle * Math.PI) / 180;
    return [-Math.cos(a) * o.speed * dt, -Math.sin(a) * o.speed * dt];
  };
  if (state.square) {
    const [dx, dy] = move(state.square);
    const s = state.square;
    shapes.push((x, y) => x >= s.x + dx - grow && x < s.x + dx + s.size + grow && y >= s.y + dy - grow && y < s.y + dy + s.size + grow);
  }
  for (const key of ['disc', 'disc2']) {
    const d = state[key];
    if (!d) continue;
    const [dx, dy] = move(d);
    shapes.push((x, y) => Math.hypot(x - (d.cx + dx), y - (d.cy + dy)) <= d.r + grow);
  }
  return (x, y) => shapes.some((inside) => inside(x, y));
}

// ── Optical flow: velocity against the truth ─────────────────────
if (args.flow) {
  // Velocity in scene pixels per second at a data pixel.
  const unit = 1 / scale;
  const regions = {};
  const add = (name, vx, vy, tx, ty) => {
    const r = (regions[name] ||= { n: 0, sumX: 0, sumY: 0, tX: 0, tY: 0, speed: 0, truth: 0, angle: 0, within10: 0, within20pct: 0 });
    const speed = Math.hypot(vx, vy);
    const truth = Math.hypot(tx, ty);
    const error = Math.abs((((Math.atan2(vy, vx) - Math.atan2(ty, tx)) * 180) / Math.PI + 540) % 360 - 180);
    r.n++; r.sumX += vx; r.sumY += vy; r.tX += tx; r.tY += ty; r.speed += speed; r.truth += truth; r.angle += error;
    if (error <= 10) r.within10++;
    if (Math.abs(speed / truth - 1) <= 0.2) r.within20pct++;
  };
  const still = { n: 0, slow: 0 };
  const movers = now.band ? null : outlines(now, 0, 14);
  for (let y = 0; y < data.height; y++) {
    for (let x = 0; x < data.width; x++) {
      const i = (y * data.width + x) * 4;
      const vx = data.values[i + 1] * unit;
      const vy = data.values[i + 2] * unit;
      const sx = (x + 0.5) / scale;
      const sy = (y + 0.5) / scale;
      if (now.band) {
        const { band, block, disc } = now;
        const rx = sx - disc.cx;
        const ry = sy - disc.cy;
        const radius = Math.hypot(rx, ry);
        const dir = (o) => [Math.cos((o.angle * Math.PI) / 180) * o.speed, Math.sin((o.angle * Math.PI) / 180) * o.speed];
        const margin = 10;
        if (sy >= band.y + margin && sy < band.y + band.h - margin) add('band', vx, vy, ...dir(band));
        else if (sx >= block.x + margin && sx < block.x + block.w - margin && sy >= block.y + margin && sy < block.y + block.h - margin) add('block', vx, vy, ...dir(block));
        else if (radius <= disc.r - margin && radius >= 20) add(radius >= disc.r * 0.6 ? 'discOuter' : 'discInner', vx, vy, -disc.omega * ry, disc.omega * rx);
        else if (!(sy >= band.y - 14 && sy < band.y + band.h + 14) && radius > disc.r + 14
          && !(sx >= block.x - 14 && sx < block.x + block.w + 14 && sy >= block.y - 14 && sy < block.y + block.h + 14)) {
          still.n++;
          if (Math.hypot(vx, vy) < 5) still.slow++;
        }
      } else if (!movers(sx, sy)) {
        still.n++;
        if (Math.hypot(vx, vy) < 5) still.slow++;
      }
    }
  }
  const report = { scene: args.scene, t: now.t, stillUnder5: +((100 * still.slow) / still.n).toFixed(2), regions: {} };
  for (const [name, r] of Object.entries(regions)) {
    report.regions[name] = {
      meanAngleError: +(r.angle / r.n).toFixed(1),
      within10deg: +((100 * r.within10) / r.n).toFixed(1),
      speed: +(r.speed / r.n).toFixed(1),
      knownSpeed: +(r.truth / r.n).toFixed(1),
      speedRatio: +(r.speed / r.truth).toFixed(3),
      within20pct: +((100 * r.within20pct) / r.n).toFixed(1),
      meanVectorHeadingError: +Math.abs((((Math.atan2(r.sumY, r.sumX) - Math.atan2(r.tY, r.tX)) * 180) / Math.PI + 540) % 360 - 180).toFixed(1),
    };
  }
  console.log(JSON.stringify(report, null, 1));
  process.exit(0);
}

// ── Vector fields: heading and age along each object's path ──────
if (data.kind === 'vector') {
  const historySeconds = Number(args.history || 1);
  const at = (x, y, channel) => {
    const px = Math.round(x * scale - 0.5);
    const py = Math.round(y * scale - 0.5);
    if (px < 0 || py < 0 || px >= data.width || py >= data.height) return null;
    return data.values[(py * data.width + px) * 4 + channel];
  };
  const report = { scene: args.scene, kind: data.kind, t: now.t, objects: {} };
  for (const key of ['square', 'disc', 'disc2']) {
    const o = now[key];
    if (!o || o.moving === false) continue;
    const half = o.size ? o.size / 2 : o.r;
    const cx = o.size ? o.x + half : o.cx;
    const cy = o.size ? o.y + half : o.cy;
    const a = (o.angle * Math.PI) / 180;
    const ux = Math.cos(a);
    const uy = Math.sin(a);
    const reach = o.speed * historySeconds;

    // Mean heading over the trail: every live pixel in the corridor behind it.
    let sumX = 0;
    let sumY = 0;
    let n = 0;
    for (let back = half; back < half + reach; back += 2) {
      for (let side = -half + 2; side <= half - 2; side += 2) {
        const x = cx - ux * back - uy * side;
        const y = cy - uy * back + ux * side;
        if (!(at(x, y, 0) > 0)) continue;
        sumX += at(x, y, 1);
        sumY += at(x, y, 2);
        n++;
      }
    }
    const heading = ((Math.atan2(sumY, sumX) * 180) / Math.PI + 360) % 360;
    const error = Math.abs(((heading - o.angle + 540) % 360) - 180);

    // Age along the path, from just behind the object: at each distance the
    // median across the middle of the trail, so one stray pixel does not count.
    const ages = [];
    for (let back = half + 6; back < half + reach - 8; back += 8) {
      const across = [];
      for (let side = -half / 2; side <= half / 2; side += 2) {
        const recent = at(cx - ux * back - uy * side, cy - uy * back + ux * side, 0);
        if (recent !== null) across.push(1 - recent);
      }
      across.sort((p, q) => p - q);
      if (across.length) ages.push(+across[across.length >> 1].toFixed(3));
    }
    let falls = 0;
    for (let i = 1; i < ages.length; i++) if (ages[i] < ages[i - 1] - 0.005) falls++;
    report.objects[key] = {
      knownHeading: o.angle,
      heading: +heading.toFixed(1),
      error: +error.toFixed(1),
      agreement: n ? +(Math.hypot(sumX, sumY) / n).toFixed(2) : 0,
      pixels: n,
      agesAlongPath: ages,
      risesSteadily: ages.length > 3 && falls === 0,
    };
  }
  console.log(JSON.stringify(report));
  process.exit(0);
}

const inNow = outlines(now, 0, 2);
const inOld = outlines(now, back, 2);
const isMask = data.kind === 'mask';

const count = { marked: 0, current: 0, ghost: 0, elsewhere: 0 };
const area = { current: 0, ghost: 0, elsewhere: 0 };
for (let y = 0; y < data.height; y++) {
  for (let x = 0; x < data.width; x++) {
    const value = data.values[(y * data.width + x) * 4];
    const marked = isMask ? value > 0.5 : value > 0;
    const sx = (x + 0.5) / scale;
    const sy = (y + 0.5) / scale;
    const region = inNow(sx, sy) ? 'current' : inOld(sx, sy) ? 'ghost' : 'elsewhere';
    area[region]++;
    if (marked) { count.marked++; count[region]++; }
  }
}
const pct = (a, b) => (b ? +((100 * a) / b).toFixed(2) : 0);

// How much of each object's own outline is marked (shrunk by 2 px: its inside).
const filled = {};
for (const key of ['square', 'disc', 'disc2']) {
  if (!now[key]) continue;
  const inside = outlines({ [key]: now[key] }, 0, -2);
  let area = 0;
  let marked = 0;
  for (let y = 0; y < data.height; y++) {
    for (let x = 0; x < data.width; x++) {
      if (!inside((x + 0.5) / scale, (y + 0.5) / scale)) continue;
      area++;
      const value = data.values[(y * data.width + x) * 4];
      if (isMask ? value > 0.5 : value > 0) marked++;
    }
  }
  if (area) filled[key] = pct(marked, area);
}
let box;
if (args.box) {
  const [bx, by, bw, bh] = args.box.split(',').map(Number);
  let area = 0;
  let marked = 0;
  for (let y = Math.floor(by * scale); y < (by + bh) * scale; y++) {
    for (let x = Math.floor(bx * scale); x < (bx + bw) * scale; x++) {
      if (x < 0 || y < 0 || x >= data.width || y >= data.height) continue;
      area++;
      const value = data.values[(y * data.width + x) * 4];
      if (isMask ? value > 0.5 : value > 0) marked++;
    }
  }
  box = pct(marked, area);
}
console.log(JSON.stringify({
  scene: args.scene,
  kind: data.kind,
  t: now.t,
  marked: count.marked,
  shareOfMarks: { current: pct(count.current, count.marked), ghost: pct(count.ghost, count.marked), elsewhere: pct(count.elsewhere, count.marked) },
  coverage: { current: pct(count.current, area.current), ghost: pct(count.ghost, area.ghost), elsewhere: pct(count.elsewhere, area.elsewhere) },
  filled,
  box,
}));
