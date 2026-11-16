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
   Transformers.js from the CDN and the model from Hugging Face, picks
   **WebGPU** where the browser has it and **wasm** otherwise, and says
   which it picked. (`?detdtype=fp32` forces full precision for triage if
   fp16 ever draws nonsense on some GPU.)
2. **Look**: a few times a second — self-throttled, **one request in
   flight at a time**, never faster than the model answers — the current
   frame is snapshotted (scaled to ≤ 960 px wide) and sent to the worker
   with the tracker's boxes *as they stood at that moment*. The result
   arrives late by one inference; it is matched against that snapshot,
   never against "the current frame".
3. **Match**: greedy IoU (`core/boxmatch.js`, unit-tested) between the
   model's boxes and the snapshot's track boxes. A matched pair votes the
   model's label onto the track id (majority over the last five looks, as
   before). Per id the last look's outcome is kept: **both** or **motion
   only**. The model's unmatched boxes are kept as the **model-only**
   finds of that look, with its time.
4. **Show**: the id plate carries the settled name, marked as an estimate
   (`7 · 93 px/s · ≈car`). Track boxes keep the accent colour when the
   model agrees and turn dashed-amber when motion alone found them; the
   model-only finds are drawn as grey dashed boxes with `≈label` and fade
   as they age (they are where the model last looked, not where the thing
   is now). The readings margin names the backend, the model's load and
   inference times and its cadence, with a **Copy model readings** button
   so the numbers can be pasted back into a report.

## What it will and will not do (help text)

- The detector names things as one of COCO's 80 everyday classes (vehicles,
  people, animals, street furniture). A synthetic square or rain gets no
  name; the score says how sure it was.
- Everything from the model is an estimate and marked `≈`. Model-only boxes
  are where the model saw something at its last look — up to a second or
  two old — not a track.
- A model-only find is not automatically a missed mover: it sees parked
  cars motion rightly ignores. A motion-only box is not automatically a
  model miss: the mask boxes clumps and part-boxes the model does not
  recognise. The disagreement is the measurement.
- Names run beside the pipeline: the picture never waits for them.

## Acceptance (M-1, registered before building)

See docs/verdicts.md, Session 8.
