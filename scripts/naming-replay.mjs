#!/usr/bin/env node
// Dev-only: replays recorded looks (scripts/page/naming-looks.js) through the
// box matcher and reports how many motion boxes found a partner and how many
// detections were left as model-only finds — so a change to core/boxmatch.js can
// be judged on the same real looks before and after (records/verdicts.md, C-1).
//
//   node scripts/naming-replay.mjs looks.json [more.json ...] [--matcher path/to/boxmatch.js]
//
// --matcher runs another copy of the matcher (an older commit's, saved with
// `git show <commit>:src/core/boxmatch.js > old.mjs`) over the same looks.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const argv = process.argv.slice(2);
const at = argv.indexOf('--matcher');
const matcherPath = at >= 0 ? argv.splice(at, 2)[1] : path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'core', 'boxmatch.js');
const files = argv;
const M = await import(pathToFileURL(path.resolve(matcherPath)).href);
const area = (b) => b.w * b.h;
function inter(a, b) {
  const l = Math.max(a.x, b.x), t = Math.max(a.y, b.y);
  const r = Math.min(a.x + a.w, b.x + b.w), bt = Math.min(a.y + a.h, b.y + b.h);
  return r > l && bt > t ? (r - l) * (bt - t) : 0;
}

for (const file of files) {
  const { looks, clip } = JSON.parse(fs.readFileSync(file, 'utf8'));
  let tracks = 0, paired = 0, dets = 0, stranded = 0, strandedTouching = 0, shared = 0;
  let bigTracks = 0, bigPaired = 0;
  const hist = { inside: [0, 0, 0, 0, 0], iou: [0, 0, 0, 0, 0] };
  let noTouch = 0;
  for (const look of looks) {
    const out = M.matchBoxes(look.tracks, look.detections);
    tracks += look.tracks.length;
    paired += out.pairs.length;
    dets += look.detections.length;
    stranded += out.detectionOnly.length;
    // A stranded detection that still overlaps a motion box is the case that
    // shows in the picture: a dashed box beside a mover that went unnamed.
    strandedTouching += out.detectionOnly.filter((d) => look.tracks.some((t) => inter(t, d) > 0)).length;
    const perDet = new Map();
    for (const p of out.pairs) perDet.set(p.detection, (perDet.get(p.detection) || 0) + 1);
    shared += [...perDet.values()].filter((n) => n > 1).length;
    const pairedTracks = new Set(out.pairs.map((p) => p.track));
    for (const t of look.tracks) {
      // Plates show from 1800 px² at picture scale; looks are in sent px.
      const k = look.sendW / 640;
      if (area(t) / (k * k) >= 1800) { bigTracks++; if (pairedTracks.has(t)) bigPaired++; }
      let bestInside = 0, bestIou = 0;
      for (const d of look.detections) {
        const i = inter(t, d);
        if (!i) continue;
        bestInside = Math.max(bestInside, i / area(t));
        bestIou = Math.max(bestIou, i / (area(t) + area(d) - i));
      }
      if (!bestInside) { noTouch++; continue; }
      hist.inside[Math.min(4, Math.floor(bestInside * 5))]++;
      hist.iou[Math.min(4, Math.floor(bestIou * 5))]++;
    }
  }
  console.log(JSON.stringify({
    clip, looks: looks.length,
    motionBoxes: tracks, paired, pairedShare: +(paired / tracks).toFixed(3),
    plateSized: bigTracks, plateSizedPaired: bigPaired,
    detections: dets, modelOnly: stranded, modelOnlyOverlappingAMotionBox: strandedTouching,
    detectionsNamingSeveralBoxes: shared,
    motionBoxesTouchingNoDetection: noTouch,
    // Each motion box's best detection: share of the box inside it, and IoU, in fifths.
    bestInsideHistogram: hist.inside, bestIouHistogram: hist.iou,
  }));
}
