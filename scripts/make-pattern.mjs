// Writes public/schlieren-pattern.svg: an A4 landscape sheet of random black
// and white 2 mm squares, the background the schlieren mode works best
// against (docs/schlieren.md). Seeded, so the file is the same every time.
//   node scripts/make-pattern.mjs
import { writeFileSync } from 'node:fs';

const SQUARE = 2;          // mm
const WIDTH = 297;         // A4 landscape, mm
const HEIGHT = 210;
const cols = Math.ceil(WIDTH / SQUARE);
const rows = HEIGHT / SQUARE;

let seed = 20261113;
const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 4294967296; };

// One path of horizontal runs keeps the file small.
let path = '';
for (let y = 0; y < rows; y++) {
  let run = -1;
  for (let x = 0; x <= cols; x++) {
    const black = x < cols && random() < 0.5;
    if (black && run < 0) run = x;
    if (!black && run >= 0) { path += `M${run * SQUARE} ${y * SQUARE}h${(x - run) * SQUARE}v${SQUARE}h${-(x - run) * SQUARE}z`; run = -1; }
  }
}
const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}mm" height="${HEIGHT}mm" viewBox="0 0 ${WIDTH} ${HEIGHT}" shape-rendering="crispEdges">
<title>MotionDiff schlieren background: random 2 mm squares, A4 landscape. Print at 100%.</title>
<rect width="${WIDTH}" height="${HEIGHT}" fill="#fff"/><path fill="#000" d="${path}"/></svg>
`;
writeFileSync(new URL('../public/schlieren-pattern.svg', import.meta.url), svg);
console.log(`${cols}x${rows} squares, ${(svg.length / 1024).toFixed(0)} kB`);
