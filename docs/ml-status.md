# The two model options: where they stand (parked 2026-11-16)

MotionDiff has two options that run a neural network beside the pipeline.
Both are marked **experimental** in the panel and both are parked here:
this page is everything needed to pick them up again without the history.

| Option | What it does | Design note | Verdicts |
|---|---|---|---|
| *Name the movers* (`maskNames`) | An object detector looks at the whole frame a few times a second; tracked boxes take its labels, and the picture shows where motion and the model disagree | [naming-poc.md](naming-poc.md) | M-1, F-1, C-1, "M-1 again" |
| *Depth the scene* (`maskDepth`) | A depth model's latest map rides the frame as a stage; tracked speeds are made comparable across depth | [depth-stage.md](depth-stage.md) | E-1 |

Both sit on the same backend ladder ([model-ladder.md](model-ladder.md),
verdict L-1). All verdicts are in [verdicts.md](verdicts.md), sessions 8
and 9. Neither model nor runtime is in the repository or the bundle: they
are fetched when an option is first switched on.

## The parts

```text
src/core/ladder.js        the ladder: order of backends, step-down decision, the words (pure)
src/core/boxmatch.js      which motion box takes which detection's name (pure)
src/core/finds.js         how long a model-only find may be shown (pure)
src/core/depth.js         sampling the depth map, the speed factor (pure)
src/app/modelladder.js    drives a model worker down the ladder; shared by both
src/app/detect.js         naming, main thread: throttle, snapshot, match, votes, finds
src/app/detect.worker.js  RT-DETR v2 r18vd through Transformers.js 4.3.2
src/app/depthstage.js     depth, main thread: throttle, the latest map
src/app/depth.worker.js   Depth Anything V2 Small through Transformers.js 3.8.1
src/ui/boxes.js           draws boxes, plates and the model-only finds
src/ui/depthview.js       draws the depth overlay
src/ui/readings.js        the "naming model" / "depth model" rows and the copy buttons
```

## What works where

| Machine | Naming | Depth |
|---|---|---|
| The development laptop: Windows 11, Intel Xe-LPG integrated GPU, headless Chrome 157, real WebGPU adapter with `shader-f16`. **Verified here, this build.** | `Naming is on (webgpu/fp16)`, 0.43 s a look, 2.2 looks/s; about a quarter of drawn boxes named on `traffic`; 24 fps against 30 with it off | `Depth is on (webgpu/fp16)`, 0.39 s a look, 2.4 looks/s; its frame-rate cost on this GPU was not measured |
| The same machine with the GPU rungs made to fail (`?modelfault=webgpu:load`) | `Naming is running on the CPU (wasm/q8) because the GPU backend would not load it`, 1.5–1.8 s a look; about 2% of boxes named; no model-only finds drawn | not re-measured this session (wasm/q8, about 1.2–2 s a look in E-1 and L-1) |
| The same machine with no WebGPU at all (`navigator.gpu` hidden) | wasm/q8 with the plain sentence | wasm/q8 with the plain sentence |
| **The owner's desktop** (a GPU; the deployed build before the ladder fix) | Failed every look: `using ceil() in shape computation is not yet supported for AveragePool`. **Not re-tested since.** | Loads and works (owner's report, 2026-11-16). **Not re-tested on this build**; its worker is unchanged |
| **The owner's laptop** (integrated GPU; the build with the ladder fix, before the rest) | Landed on the CPU: "the GPU backend would not load it"; dashed boxes in empty space, few names — the report that prompted F-1 and C-1. **Not re-tested since.** | not reported |
| Phones, Firefox, Safari | never run | never run |

## Not verified

- Any GPU other than the one Intel integrated adapter above. In particular
  whether Transformers.js 4.3.2's WebGPU rungs load on the owner's laptop,
  where 3.8.1's would not. The status line answers it in one look.
- The frame-rate cost of naming on a discrete GPU (measured only on an
  integrated one, where the detector shares the GPU with the picture).
- Naming's first load on a slow connection: the 4.x runtime is a separate
  download of roughly 27 MB (the size is from reading the package, not
  measured on the wire) on top of the 41 MB fp16 weights.
- E-1's fourth check (the depth speed correction) on a GPU, where looks
  are fast and its margin was expected to widen.
- No blind judge has looked at the reworked naming picture; steps F-1 and
  C-1 were accepted on numbers and tests, and on screenshots read by the
  agent that built them.

## Known limits

- **Names are sparse.** On `traffic` at GPU look rates about a quarter of
  drawn boxes carry a name (a third of those large enough for a plate).
  More than half of all motion boxes touch nothing the detector found:
  far field, clutter, coasting boxes. No matcher names those.
- **On a CPU rung naming is thin.** A look takes one to two seconds, the
  answer names the boxes of a picture that long gone, and most track ids
  on a busy road do not live that long (V-6T). About 2% of boxes named.
- **Model-only finds need fast looks.** A find is shown for at most three
  look periods or 1.5 s of media time. Where a look takes longer than
  about a second none are drawn at all, parked cars included.
- **Naming costs frame rate on an integrated GPU**: 24 fps against 30.
- **The model misreads**: a lorry as "train"; the synthetic disc of the
  `truth` clip as "toilet". Faster looks show misreads more often. The
  score floor is 0.45 (`SCORE_FLOOR` in `detect.worker.js`).
- **A clump takes one name.** One motion box over a queue of cars is
  called after the car that fits it best; the others are counted as found
  by both and not drawn.
- Small motion boxes inside a very large detection (under a twentieth of
  its area) are not named after it — on purpose, see C-1.
- Depth: relative inverse depth with unknown scale; albedo can pass for
  distance (E-1 addendum); the correction is clamped at four to one.

## Open issues

1. **A look that hangs is not detected.** After a model has said ready, a
   look that never answers (no result, no error) leaves that option
   silently doing nothing; only load-and-prove has a timeout (180 s).
2. **Two runtime versions load when both options are on**: Transformers.js
   4.3.2 for naming and 3.8.1 for depth, each with its own onnxruntime
   build. They run side by side (verified, both on webgpu/fp16 at about
   two looks a second each) at the cost of a second download.
3. On this GPU the detector's fp16 rung crashed at load on 3.8.1 with a
   bare number (`94952944`). Undiagnosed; moot for naming since 4.3.2,
   where fp16 loads and runs. Depth's fp16 on 3.8.1 is fine here.
4. After a seek while paused no look is taken until playback resumes, so
   the new frame has no names or finds (the stale ones are dropped).
5. `scripts/page/audit.js` reports 3.38:1 for every box plate in the dark
   theme: it reads SVG text's CSS `color`, the overlay paints with `fill`.
   A fault of the tool; light theme reads 4.65.

## Triage switches

Both work on any build, the deployed one included, and do nothing unless
present in the URL.

| Switch | Effect |
|---|---|
| `?modelfault=<rung>:<stage>[,…]` | Makes a backend fail on purpose. `<rung>`: `all`, `webgpu`, `wasm`, or one rung such as `webgpu/fp16`. `<stage>`: `load` (will not load), `prove` (loads, cannot run), `look` (every real look fails after ready). `?modelfault=webgpu:load` is the quickest way onto the CPU rung |
| `?detdtype=fp32` | Pins the detector's WebGPU rung to one precision (the CPU rung stays below it) |

What to read: the status line (where the ladder landed and why), the
console (`naming model stepped down: …`, each rung's own failure), and
the readings margin's *Copy model readings* / *Copy depth readings*
(backend, load, look times, cadence, and a "stepped down" line).

## Decisions, and why

- **A rung must prove a look** (L-1). A backend can build its session and
  still be unable to run the model; only a run finds out.
- **Route (a): the detector's worker alone on Transformers.js 4.3.2.**
  The 3.x WebGPU backend (JavaScript) rejects RT-DETR's three ceil-mode
  AveragePool nodes at run time and is no longer maintained upstream; 4.x
  replaced it with one that runs them. One URL changed. Not taken:
  (b) patched weights — needs somewhere to host a file, against "nothing
  in the repository or the bundle", and stays on the dead backend;
  (c) another detector — none of D-FINE, RF-DETR runs on 3.x WebGPU
  either, so it needed (a) anyway.
- **Depth stays on 3.8.1.** It is the configuration the owner verified;
  nothing here needed it to move.
- **Licences** (checked 2026-11-15/16): Transformers.js Apache-2.0;
  onnxruntime-web MIT; RT-DETR v2 r18vd weights Apache-2.0; Depth
  Anything V2 **Small** Apache-2.0. **Never fetch** Depth Anything V2
  Base or Large (CC-BY-NC). **Ultralytics YOLO stays rejected**
  (AGPL-3.0). From this session's research, not re-checked: for RF-DETR
  only Nano to Large are Apache-2.0, and for D-FINE the COCO-only
  checkpoints are the safe ones.
- **Matching is containment as well as IoU, many boxes to one detection**
  (C-1), with thresholds set on recorded real looks: IoU ≥ 0.15, or
  ≥ 0.6 of the smaller box inside the larger between boxes within a
  factor of twenty in area.
- **Model-only finds age in media time** and are dropped (F-1), because a
  stale estimate drawn as a box reads as a claim about now.

## Next steps, in order

1. **Read the owner's machines.** Desktop and laptop on this build: the
   status line for each option, the copied readings, any console
   warning. Everything below depends on whether 4.3.2's GPU rungs load
   there.
2. **A watchdog for a hung look** (open issue 1): a per-look timeout in
   `app/modelladder.js` that feeds `stepLadder` a failed look. Small; the
   decision logic and its tests already exist.
3. **One runtime** (open issue 2): move the depth worker to 4.3.2 too.
   Needs depth re-verified first — same map and timing on both versions —
   because depth is the owner's verified baseline. (Researched: 4.x
   returns an array from depth-estimation only when given an array; the
   worker passes one image.)
4. **Frame-rate cost on integrated GPUs**, if it matters in use: a longer
   pause between looks (`EVERY_MS` in `app/detect.js`) or one that adapts
   to the measured frame time. Measure before and after, interleaved.
5. **Names at slow look rates**: a name dies with its track id and
   arrives a look late. Ideas, none built: carry a late answer to the
   box now standing where the named box was heading; remember names by
   place for a short while. Needs a design note and registered
   expectations — it changes what a name means.
6. **Model-only finds for things that stand still**: a find the model
   sees in the same place look after look is not stale however slow the
   looks. Would bring parked cars back on a CPU rung honestly.
7. **A smaller detector**: `onnx-community/dfine_s_coco-ONNX` (Apache-2.0,
   21 MB fp16, 11 MB quantised, COCO AP 48.5 against 48.1). In this
   session's research it ran on 4.3.2's WebGPU on the development laptop
   in a probe page, not in the app; M-1 would have to be re-run.
8. Fix the audit tool's reading of SVG text (open issue 5).
9. Phones, Firefox, Safari.

## Re-running the checks

With the dev server up (`npm run dev`) and the reference clips fetched
(`npm run filmstrip clips`):

```bash
# Where the ladder lands, names, agreement, model-only finds, frame rate on/off
node scripts/filmstrip.mjs eval --run scripts/page/naming-check.js --args '{"clip":"traffic.mp4","seconds":12}'
# The same on the CPU rung
node scripts/filmstrip.mjs eval --run scripts/page/naming-check.js --args '{"clip":"traffic.mp4","seconds":12}' \
  --url "http://localhost:5173/MotionDiff/?modelfault=webgpu:load"
# Record real looks, then replay them through the matcher (before and after a change)
node scripts/filmstrip.mjs eval --run scripts/page/naming-looks.js --args '{"clip":"traffic.mp4"}' > looks.json
node scripts/naming-replay.mjs looks.json
```

Headless Chrome on the development laptop has a real WebGPU adapter, so
the GPU rungs are exercised for real there. Check with
`navigator.gpu.requestAdapter()` before assuming either way.
