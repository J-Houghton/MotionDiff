# Depth as a stage (session 8 design note)

A depth model's picture becomes a shared measurement stage like the others
(docs/pipeline-stages.md): any consumer asks `frame.stages.depth()` and
gets the **latest** estimate with **how old it is** — the model runs in a
worker beside the pipeline, never inside the frame loop, so its answer is
always one to a few looks behind the picture and says so. Everything from
it is an estimate and marked ≈.

## Licences, checked against this repo's MIT (2026-11-15)

| Piece | Licence | Compatible |
|---|---|---|
| Transformers.js (`@huggingface/transformers`, jsDelivr CDN, pinned) | Apache-2.0 | yes |
| Depth Anything V2 **Small** (`onnx-community/depth-anything-v2-small`; ~25 MB quantised) | Apache-2.0 | yes — fetched at runtime, never redistributed |
| Depth Anything V2 Base / Large | CC-BY-NC-4.0 | **no — never fetch these**; only Small is Apache |

Nothing enters the repository or the bundle; the model loads when the
option is first switched on and the browser caches it. Offline, the
switch fails with a plain sentence and turns itself back off.

## The method

1. **Switch on**: *Depth the scene* (`maskDepth`), beside *Box the
   movers* on the tracking modes. First enable dynamically imports
   `app/depthstage.js`, whose worker loads the runtime and model down a
   ladder — WebGPU fp16, WebGPU fp32, wasm q8 — until one loads, saying
   which it landed on (the status line) and why it stepped down (the
   console).
2. **Look**: a few times a second, one request in flight, the frame
   (scaled to ≤ 518 px wide — the model's own working size) goes to the
   worker stamped with its media time. The answer — relative **inverse**
   depth, larger = nearer, scale unknown — comes back pooled to a coarse
   grid (~80×45) with its min, max and median.
3. **The stage**: the latest map rides the frame as
   `frame.stages.depth()` → `{grid, cols, rows, min, max, median, time,
   age}`; `age` is media seconds between the picture and the look the map
   came from. Consumers read the heap-resident grid freely; nothing
   waits.
4. **Show it**: *Show the depth estimate* draws the grid over the picture
   (near warm, far cool, pixelated on purpose — it is an 80-cell
   estimate, not a measurement), with a chip naming its age. The readings
   margin carries the backend, the time per look and the map's age, with
   a copy button.

## The one use built: speeds comparable across depth

Calibration is true at the marked line's depth only (a named gap since
V-6K), and raw px/s makes the far carriageway read slower than the near
one. With a depth estimate the tracker's speeds can be made comparable:
each box samples its median inverse depth from the stage, and its shown
speed is scaled by `median(scene) / depth(box)`, clamped to ×/÷4 and
declined entirely (raw speed, no ≈) where the map is too flat or the box
too near the far tail to trust. The factor is smoothed per id (successive
maps renormalise themselves, and a map is a look or two old against a
mover's current box), and a coasted box samples nothing — its position is
a prediction — but keeps the factor it had, as it keeps its speed. The plate then reads `7 · ≈112 px/s`: an
estimate of what the mover's speed would read at the scene's median
depth. The absolute scale stays anchored where you calibrated; what the
correction buys is comparability between near and far.

This is relative inverse depth with an unknown shift, so the ratio is an
approximation on principle — the acceptance test below asks the clip, not
the theory, whether it helps.

## What it will and will not do (help text)

- The depth picture is a model's estimate of relative depth, one to a few
  looks old (it says how old); nothing in it is measured, and flat or
  unusual scenes (synthetic clips, rain) can fool it entirely.
- ≈ speeds are raw speed scaled to the scene's median depth by that
  estimate, clamped at four to one; where the map declines, the plain
  measured px/s shows unmarked.
- The stage serves any consumer; only the speed comparison is built.

## Acceptance (E-1, registered before building)

See docs/verdicts.md, Session 8.
