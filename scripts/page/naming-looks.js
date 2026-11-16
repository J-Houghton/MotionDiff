// Runs inside the app page: `node scripts/filmstrip.mjs eval --run scripts/page/naming-looks.js --args '{"clip":"traffic.mp4"}' > looks.json`.
// Records real looks for scripts/naming-replay.mjs: the tracker's boxes at the
// moment a frame is sent and what the detector returned for that frame, both in
// sent pixels — the same snapshot app/detect.js matches. It runs a detector
// worker of its own, so the app's naming option stays off.
// `args`: { clip (a file in ref-clips/), seconds = 40, device = 'wasm', dtype = 'q8' }.
const md = window.__motionDiff;
const { session } = md;
const blob = await (await fetch(new URL(`ref-clips/${args.clip}`, location.href))).blob();
await md.load(blob, args.clip);
md.video.loop = true;
md.setParams({ algorithm: 'mask', maskTrack: true });
await new Promise((r) => setTimeout(r, 2500));

const w = new Worker(new URL('src/app/detect.worker.js', location.href), { type: 'module' });
const once = () => new Promise((resolve) => { w.onmessage = (e) => resolve(e.data); });
w.postMessage({ type: 'load', device: args.device || 'wasm', dtype: args.dtype || 'q8' });
const ready = await once();
if (ready.type !== 'ready') return { error: ready };

const looks = [];
const end = performance.now() + (args.seconds || 40) * 1000;
while (performance.now() < end) {
  const r = session.pipeline.readings;
  const video = md.video;
  if (!r?.objects || !video.videoWidth) { await new Promise((res) => setTimeout(res, 100)); continue; }
  const scale = Math.min(1, 960 / video.videoWidth);
  const sendW = Math.round(video.videoWidth * scale);
  const sendH = Math.round(video.videoHeight * scale);
  const k = sendW / r.width;
  const tracks = r.objects.map((o) => ({ id: o.id, x: +(o.x * k).toFixed(1), y: +(o.y * k).toFixed(1), w: +(o.w * k).toFixed(1), h: +(o.h * k).toFixed(1), coasting: !!o.coasting, speed: +(o.speed * k).toFixed(1) }));
  const time = video.currentTime;
  const bitmap = await createImageBitmap(video, { resizeWidth: sendW, resizeHeight: sendH, resizeQuality: 'low' });
  w.postMessage({ type: 'frame', bitmap, time }, [bitmap]);
  const out = await once();
  if (out.type !== 'result') return { error: out, looks };
  looks.push({ time: +time.toFixed(2), sendW, sendH, inferMs: out.inferMs, tracks, detections: out.detections.map((d) => ({ label: d.label, score: d.score, x: +d.x.toFixed(1), y: +d.y.toFixed(1), w: +d.w.toFixed(1), h: +d.h.toFixed(1) })) });
  await new Promise((res) => setTimeout(res, 150));
}
w.terminate();
return { clip: args.clip, looks };
