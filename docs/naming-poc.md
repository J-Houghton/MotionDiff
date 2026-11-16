# Naming what is tracked: a detector beside the pipeline (session 8 design note)

Tracking draws boxes with numbers; this names them — and now also answers a
question the first take could not: **where do motion and a model disagree?**
A small object detector looks at the **whole original frame** a few times a
second, in a worker **beside the pipeline and never inside the frame loop**.
Its boxes are matched to the tracker's boxes, so each track carries a label,
and the picture shows three kinds of find: by motion and the model **both**,
by **motion only**, and by the **model only**.

This supersedes the session-7 take (MobileNetV2 over box crops, verdict
N-1): a crop classifier could only name what motion had already found. The
first take is in git history under this same file name.

## Licences, checked against this repo's MIT (2026-11-15)

| Piece | Licence | Compatible |
|---|---|---|
| Transformers.js (`@huggingface/transformers`, jsDelivr CDN, version pinned) | Apache-2.0 | yes |
| RT-DETR v2 r18vd (`onnx-community/rtdetr_v2_r18vd-ONNX` on Hugging Face; upstream weights PekingU/rtdetr_v2_r18vd, both Apache-2.0; 21 MB quantised, 41 MB fp16) | Apache-2.0 | yes — fetched at runtime, never redistributed with this repo |
| COCO class names | carried inside the model's own config, nothing in this repo | yes |
| Ultralytics YOLO (the obvious alternative) | AGPL-3.0 | **no — rejected**, as before |

Neither runtime nor model enters the repository or the bundle: both are
fetched when the option is first switched on, and the browser's cache keeps
them. Offline, the switch fails with a plain sentence and turns itself
back off.

## The method

1. **Switch on**: *Name the movers* (`maskNames`), the same toggle as
   before, shown only while boxes are on. The first enable dynamically
   imports `app/detect.js`, which starts a worker; the worker loads
   Transformers.js from the CDN and the model from Hugging Face, and
   works down a ladder — **WebGPU fp16, WebGPU fp32, wasm q8** — until
   one **loads and proves a look** (docs/model-ladder.md), saying where
   it landed and why on the status line and each rung's own failure in
   the console. **Each rung gets a fresh worker**: a crash out of the
   runtime (fp16 crashed outright on a real GPU the first time out)
   leaves that worker's wasm instance poisoned, and a retry inside it
   fails at the same spot whatever the backend.
   (`?detdtype=fp32` pins the WebGPU rung for triage.)
   **On the pinned runtime this model lands on the CPU even where there
   is a GPU**: its backbone's ceil-mode AveragePool is something that
   runtime's WebGPU backend cannot run (verdict L-1). Getting the GPU
   back is an open decision (ROADMAP).
2. **Look**: a few times a second — self-throttled, **one request in
   flight at a time**, never faster than the model answers — the current
   frame is snapshotted (scaled to ≤ 960 px wide) and sent to the worker
   with the tracker's boxes *as they stood at that moment*. The result
   arrives late by one inference; it is matched against that snapshot,
   never against "the current frame".
3. **Match** (`core/boxmatch.js`, unit-tested): the two do not box the
   same things the same way — the detector hugs an object, the mask boxes
   whatever moved together: a thin leading strip of a car, two clumps of
   one car, one clump over a queue of cars. So a motion box and a
   detection match when they overlap well (IoU ≥ 0.15) **or when most
   of the smaller lies inside the larger** (≥ 0.6, between boxes of
   comparable size: a speck inside a bus is not the bus, and a false
   detection the width of the frame names nothing). Each motion box
   takes the detection that fits it best, containment plus IoU, so of
   two that hold a strip the snugger wins; **several motion boxes may
   take one detection's name**. A matched pair votes the model's label
   onto the track id — one look is enough to name it, later looks vote
   the name steady by majority over the last five. Per id the last
   look's outcome is kept: **both** or **motion only**. A detection that
   fits no motion box is a **model-only** find of that look; one that
   fits a motion box which took another's name (the second car under a
   clump) is covered — motion found it too — and is not drawn.
4. **Show**: the id plate carries the settled name, marked as an estimate
   (`7 · 93 px/s · ≈car`). Track boxes keep the accent colour when the
   model agrees and turn dashed-amber when motion alone found them; the
   model-only finds are drawn as dashed blue boxes with `≈label`, **only
   while they are fresh** (`core/finds.js`). A find is where the model
   saw something in one frame: it does not move, and the answer arrives
   a look late. So it is drawn at full strength while young, fades to
   nothing, and is dropped at three look periods or 1.5 s of media time,
   whichever is less; one that arrives already in its fade is never
   drawn. Where a look takes longer than about a second — the CPU rung —
   that means **no model-only finds are drawn at all**: they would be
   boxes in empty space. Age is media time, so a paused picture keeps
   the finds that belong to it and a seek drops them. The readings margin names the backend, the model's load and
   inference times and its cadence, with a **Copy model readings** button
   so the numbers can be pasted back into a report.

## What it will and will not do (help text)

- The detector names things as one of COCO's 80 everyday classes (vehicles,
  people, animals, street furniture). A synthetic square or rain gets no
  name; the score says how sure it was.
- Everything from the model is an estimate and marked `≈`. Model-only boxes
  are where the model saw something at its last look — at most a second
  and a half old, then gone — not a track. On a slow backend they do not
  appear.
- A model-only find is not automatically a missed mover: it sees parked
  cars motion rightly ignores. A motion-only box is not automatically a
  model miss: the mask boxes clumps and part-boxes the model does not
  recognise. The disagreement is the measurement.
- Names run beside the pipeline: the picture never waits for them.

## Acceptance (M-1, registered before building)

See docs/verdicts.md, Session 8.
