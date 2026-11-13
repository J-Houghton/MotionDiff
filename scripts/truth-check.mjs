// Checks a mode's data output against the known positions in the synthetic
// `truth` scenes (scripts/page/scene.js). Reads what `filmstrip render` wrote
// for a scene with "readData": true.
//
//   node scripts/truth-check.mjs --dir filmstrips --tag mask --scene truth-mask --gap 5
//
// Prints, for the last captured frame: how many pixels the mode marks (data
// R > 0.5 for a mask, > 0 otherwise), and where they lie:
//   current   inside an object's outline now (grown by 2 px for blur)
//   ghost     inside its outline `gap` frames ago, outside the current one
//   elsewhere anywhere else (noise)
// and how much of each region is covered.
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
console.log(JSON.stringify({
  scene: args.scene,
  kind: data.kind,
  t: now.t,
  marked: count.marked,
  shareOfMarks: { current: pct(count.current, count.marked), ghost: pct(count.ghost, count.marked), elsewhere: pct(count.elsewhere, count.marked) },
  coverage: { current: pct(count.current, area.current), ghost: pct(count.ghost, area.ghost), elsewhere: pct(count.elsewhere, area.elsewhere) },
}));
