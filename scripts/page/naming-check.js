// Runs inside the app page: `node scripts/filmstrip.mjs eval --run scripts/page/naming-check.js --args '{"clip":"traffic.mp4","seconds":12}'`.
// The naming check (records/verdicts.md, "M-1 again"; records/model-options.md):
// plays a reference clip with boxes and names on and reports where the backend
// ladder landed, how many boxes carry a name, what the settled tracks are called
// and whether the model agrees, the model-only finds and their ages, and the
// frame rate with names off and on in interleaved windows.
// `args`: { clip (a file in ref-clips/), seconds = 12, fpsWindows = 3 (0 skips the frame-rate part) }.
// Add `--url "http://localhost:5173/MotionDiff/?modelfault=webgpu:load"` to check the CPU rung.
const md = window.__motionDiff;
const { session } = md;
const statuses = [];
session.on((event) => {
  if (event !== 'status') return;
  const s = session.status;
  if (statuses.at(-1) !== `[${s.type}] ${s.message}`) statuses.push(`[${s.type}] ${s.message}`);
});
const blob = await (await fetch(new URL(`ref-clips/${args.clip}`, location.href))).blob();
await md.load(blob, args.clip);
md.video.loop = true;
md.setParams({ algorithm: 'mask', maskTrack: true });
await new Promise((r) => setTimeout(r, 2500));
const mediaAtSwitch = md.video.currentTime;
const wallAtSwitch = performance.now();
md.setParams({ maskNames: true });
while (!session.modelStatus?.() && performance.now() - wallAtSwitch < 180000 && session.params.maskNames) await new Promise((r) => setTimeout(r, 100));
if (!session.modelStatus?.()) return { error: 'naming did not start', statuses };
const loadWall = (performance.now() - wallAtSwitch) / 1000;
// Media time is modulo the clip while it loops: count wraps by watching it.
const mediaAtReady = md.video.currentTime;
await new Promise((r) => setTimeout(r, 3000));

const VEHICLE_OR_PERSON = new Set(['car', 'truck', 'bus', 'motorcycle', 'bicycle', 'person', 'train', 'boat', 'airplane']);
const lived = new Map();
const ages = [];
const opac = [];
const findLabels = {};
const nameLabels = {};
let samples = 0, withFinds = 0, boxSamples = 0, named = 0, big = 0, bigNamed = 0;
const end = performance.now() + (args.seconds || 12) * 1000;
while (performance.now() < end) {
  const now = performance.now();
  const objects = session.pipeline.readings?.objects || [];
  const finds = session.modelFinds?.() || [];
  samples++;
  if (finds.length) withFinds++;
  for (const f of finds) { ages.push(Math.round(f.ageMs)); opac.push(f.opacity); const key = `${f.label} ${f.score.toFixed(2)} ${Math.round(f.w)}x${Math.round(f.h)}`; findLabels[key] = (findLabels[key] || 0) + 1; }
  for (const o of objects) {
    const name = session.nameFor(o.id);
    const agree = session.agreeFor(o.id);
    boxSamples++;
    if (name) { named++; const key = `${name.label} on ${Math.round(o.w)}x${Math.round(o.h)}`; nameLabels[key] = (nameLabels[key] || 0) + 1; }
    if (o.w * o.h >= 1800) { big++; if (name) bigNamed++; }
    let e = lived.get(o.id);
    if (!e) lived.set(o.id, (e = { first: now, last: now, label: null, agree: null }));
    e.last = now;
    if (name) e.label = name.label;
    if (agree) e.agree = agree;
  }
  await new Promise((r) => setTimeout(r, 100));
}
ages.sort((a, b) => a - b);
const settled = [...lived.values()].filter((e) => e.last - e.first >= 2000);
const labelled = settled.filter((e) => e.label);
const labels = {};
for (const e of labelled) labels[e.label] = (labels[e.label] || 0) + 1;
const looks = session.modelStatus();

// Frame rate, names off and on, interleaved windows in the same page.
const orig = session.pipeline.process.bind(session.pipeline);
let frames = 0;
session.pipeline.process = (...a) => { frames++; return orig(...a); };
const fps = { off: [], on: [] };
for (let i = 0; i < (args.fpsWindows ?? 3) * 2; i++) {
  const on = i % 2 === 1;
  md.setParams({ maskNames: on });
  await new Promise((r) => setTimeout(r, 1500));
  frames = 0;
  const t = performance.now();
  await new Promise((r) => setTimeout(r, 8000));
  fps[on ? 'on' : 'off'].push(+(frames / ((performance.now() - t) / 1000)).toFixed(1));
}
session.pipeline.process = orig;
md.setParams({ maskNames: true });

return {
  clip: args.clip,
  statuses,
  backend: `${looks.backend}/${looks.dtype}`, medianInferMs: looks.medianInferMs, looksPerSecond: looks.looksPerSecond, steps: looks.steps,
  load: { wallSeconds: +loadWall.toFixed(1), mediaAtSwitch: +mediaAtSwitch.toFixed(2), mediaAtReady: +mediaAtReady.toFixed(2), duration: +md.video.duration.toFixed(2) },
  samples, boxSamples, namedShare: +(named / Math.max(1, boxSamples)).toFixed(3), plateSizedNamedShare: +(bigNamed / Math.max(1, big)).toFixed(3),
  settledTracks: settled.length,
  settledLabelled: labelled.length,
  vehicleOrPerson: labelled.filter((e) => VEHICLE_OR_PERSON.has(e.label)).length,
  labels,
  labelledReadingBoth: labelled.filter((e) => e.agree === 'both').length,
  settledReadingBoth: settled.filter((e) => e.agree === 'both').length,
  settledMotionOnly: settled.filter((e) => e.agree === 'motion').length,
  finds: { samplesWithFinds: withFinds, findSamples: ages.length, ageMs: { min: ages[0] ?? null, median: ages[ages.length >> 1] ?? null, max: ages.at(-1) ?? null }, olderThan1500: ages.filter((a) => a > 1500).length, minOpacity: opac.length ? +Math.min(...opac).toFixed(2) : null },
  fps,
  findLabels: Object.keys(findLabels).length > 12 ? Object.keys(findLabels).length + ' kinds' : findLabels,
  nameLabels: Object.keys(nameLabels).length > 12 ? Object.keys(nameLabels).length + ' kinds' : nameLabels,
  logs: (window.__logs || []).filter((l) => /model|stepped|REJECTION|UNCAUGHT/i.test(l)).slice(-6),
};
