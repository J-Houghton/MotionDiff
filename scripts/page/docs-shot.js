// Runs inside the app page, for the screenshots in the documentation:
//   node scripts/filmstrip.mjs shot --out shot.png --run scripts/page/docs-shot.js \
//     --args '{"clip":"traffic.mp4","params":{"algorithm":"mask","maskTrack":true},"countLine":[150,250,470,250],"seconds":8}'
// `args`: { clip (a file in ref-clips/), params, display, countLine [x1,y1,x2,y2] in
// picture pixels, calibration (metres per pixel), collect (bool), seconds = 4,
// pause = true, theme ('light' | 'dark') }.
// Returns what the page showed, so a caption can quote real numbers.
const md = window.__motionDiff;
const { session } = md;
if (args.theme) document.documentElement.dataset.theme = args.theme;
const blob = await (await fetch(new URL(`ref-clips/${args.clip}`, location.href))).blob();
await md.load(blob, args.clip);
md.video.loop = false;
if (args.params) md.setParams(args.params);
if (args.display) md.setDisplay(args.display);
if (args.calibration) session.calibration = { metresPerPixel: args.calibration };
// Let the tracker find its boxes before a line starts counting them.
await new Promise((r) => setTimeout(r, 1500));
if (args.countLine) {
  const [x1, y1, x2, y2] = args.countLine;
  session.setCountLine({ x1, y1, x2, y2 });
}
if (args.collect) session.toggleCollect();
await new Promise((r) => setTimeout(r, (args.seconds ?? 4) * 1000));
if (args.pause !== false) await md.pause();
await new Promise((r) => setTimeout(r, 400));
return {
  time: Number(md.video.currentTime.toFixed(2)),
  status: session.status.message,
  counts: session.counts,
  boxes: session.pipeline.readings?.objects?.length ?? null,
  rows: session.dataRowCount,
  // Each crossing of the count line: when, which box, which way.
  crossings: (session._counter?.events ?? []).map((e) => ({ t: Number(e.t.toFixed(2)), id: e.id, dir: e.dir })),
};
