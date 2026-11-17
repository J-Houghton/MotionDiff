# How it is built

MotionDiff is a static web app: plain JavaScript modules built with Vite,
unit-tested with Vitest, and type-checked from JSDoc by TypeScript. Its one
runtime dependency is Tweakpane, for the parameter panel. Video is
processed in the browser and never uploaded.

## Layers

Imports go one way only. Third-party packages may be imported anywhere.

| Layer | Holds | May import |
|---|---|---|
| [`src/core/`](../../src/core/) | Pure, unit-tested functions: the maths of every mode, the time base, tracking, export rows | nothing, not even other core modules |
| [`src/app/`](../../src/app/) | The session, the pipeline, the renderers, the modes, the workers | `core/` |
| [`src/ui/`](../../src/ui/) | The DOM, the panel, the keys, and what is drawn over the picture | `app/` |
| [`src/main.js`](../../src/main.js) | Wiring | all three |

## The path of a frame

1. [`Session`](../../src/app/session.js) owns the video element, the frame
   loop and all interface state. It stamps each frame with its media time.
2. [`Pipeline.process`](../../src/app/pipeline.js) stores the frame in the
   frame history and calls the active mode's `render(frame)`, which draws
   the mode's picture and its data.
3. The renderer composites the picture for the chosen display (diff,
   overlay, glow or data) onto one canvas.
4. `ui/` draws boxes, the count line and the readings over or beside the
   canvas, from what the mode published in `pipeline.readings`. One DOM
   ([`ui/shell.js`](../../src/ui/shell.js)) serves both layouts, the Plate
   and the Viewfinder.

**Time base** ([`core/timebase.js`](../../src/core/timebase.js)). Old frames
are found by media time, never by counting processed frames, so a gap means
the same at any frame rate, playback speed or frame cap. Each frame is
classified against the previous stamp: a jump clears history, a rewind
drops later frames, a repeat (a redraw while paused) stores nothing.
Camera frames are stamped with the session's own clock.

**Frame history** ([`core/buffer.js`](../../src/core/buffer.js)). On WebGL
past frames live in a texture array on the GPU, sized from a 192 MiB budget
(64 MiB on phones) and capped at 120 frames: 120 at 640×360, 24 at
1920×1080. When it is too short for the lookback, fewer frames are stored.

**Shared stages** ([`app/stages.js`](../../src/app/stages.js)). A
measurement several views need (the motion mask, the background model, the
flow field, the camera's own motion, the tracked boxes) is a stage on
`frame.stages`: computed on first request, reused for the rest of the
frame. Only this module wires one measurement into another.

## Two render paths

WebGL2 ([`app/renderer.webgl.js`](../../src/app/renderer.webgl.js)) is
preferred. Without it, a worker
([`app/pipeline.worker.js`](../../src/app/pipeline.worker.js)) does the
pixel work and [`app/renderer.js`](../../src/app/renderer.js) composites
with Canvas 2D. Posy, Raw diff and Magnify's brightness variant run on
either path. Motion mask needs WebGL2. Everything else, and Magnify on the
WebGL path, needs WebGL2 with float render targets. The app says so when a
mode cannot run.

Every algorithm exists twice: plain JavaScript in `core/`, which is the
reference, and a GLSL shader, compared by the
[parity probes](developing.md#tests-and-parity-probes).

## Display and data

Measurement happens at the processing width (640 px by default). The canvas
is backed at display resolution, up to 2048 px wide on desktop and 1280 on
phones; flow traces and arrows are drawn last at that resolution, so lines
stay thin on a large screen. A recording captures this canvas.

Every mode also writes its result as [data](how-the-modes-work.md), with
an unsigned magnitude in the first channel. Anything that asks "how much
motion, where", such as the readings column, pools that magnitude and
never a mode's signed output, where a moving edge cancels to zero.

## Modes and effects

A mode is one module in [`app/modes/`](../../src/app/modes/) and one entry
in `MODES`. Its `params` schema generates the panel and its `help` fills
the help sheet. Settings live on `pipeline.params` and change through
`Session.setParams`. [`app/effects.js`](../../src/app/effects.js) folds the
eight modes into the six effects the interface presents; each variant is a
visible choice that sets one or more params.

## The experimental model options

*Name the movers* and *Depth the scene* each run a model in a worker of
their own (`app/detect.worker.js`, `app/depth.worker.js`), beside the
pipeline. The code is imported when an option is first switched on; the
worker then fetches Transformers.js and the model from their public hosts.
[`core/ladder.js`](../../src/core/ladder.js) picks the backend: WebGPU with
16-bit weights, then 32-bit, then WebAssembly on the CPU, stepping down
when one fails to load or to complete a look.
