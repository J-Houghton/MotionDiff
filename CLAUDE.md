# MotionDiff

Browser-based motion extraction from video (temporal differencing, Eulerian
magnification, motion sonification). Vite + vanilla ES modules. Deployed to GitHub
Pages by `.github/workflows/deploy.yml` on push to `master`.

## Commands
- `npm run dev` — dev server at http://localhost:5173/MotionDiff/
- `npm test` — vitest run (node environment, no DOM/WebGL)
- `npm run build` — production build (must pass before any PR)

## Architecture — layer rules are strict, never violate them
```
core/  <- imports nothing (pure functions + ring buffers; all unit-testable in node)
app/   <- imports core/ only (Pipeline orchestration, WebGL renderer, Canvas2D worker fallback, audio)
ui/    <- imports app/ only (DOM bindings)
main.js <- app/ + ui/, and core/ directly for pure helpers (wiring + render loop)
```
These rules govern imports between `src/` layers only. Third-party npm packages may be
imported at any layer (`ui/controls.js` imports `@simonwep/pickr`, `app/loader.js`
imports `hls.js`, `app/audio.js` lazy-imports `tone`). Test files are also exempt —
`core/__tests__/core.test.js` imports `app/source-profile.js` and `app/clips.js`.

Core modules do not import each other either: each is self-contained, and a constant
two of them need (`REFERENCE_FPS`, the luma weights) is repeated with a comment.

`core/` and `app/` stay framework-free whatever the UI is built with.

## Modes
`pipeline.params.algorithm` selects the mode: `posy`, `raw` (frame differencing with
trails and diff/overlay/glow compositing) or `magnify` (Eulerian magnification, shows
the amplified frame directly, no trails/compositing). Planned modes: three-frame
differencing, motion history, background subtraction, optical flow.

## Key conventions
- **Core is the source of truth.** Every visual algorithm exists twice: pure JS in
  `core/` (tested) and a GLSL mirror in `app/renderer.webgl.js`. The shader must match
  it, exactly where the data is 8-bit: the diff and blur shaders work on whole 0..255
  values for that reason. Dev builds expose parity probes that run the same synthetic
  frames through both: `__motionDiffDiffParity()`, `__motionDiffTrailParity()`,
  `__motionDiffEnergyParity()`, `__magnifyParityHarness()`. Run them after touching a
  shader or its core function. A new mode gets a core function with tests first, then
  its shader mirror and a probe.
- **Posy space:** 128 (`128.0 / 255.0` in shaders, never `0.5`) = "no motion" baseline.
  Motion = deviation from 128. Raw mode baseline is 0. New math must respect the
  mode's baseline.
- **Threshold** is the mean absolute channel difference between the two frames, 0..255,
  in every mode. (Posy stores half-differences, so `posyBlend` doubles before comparing.)
- **Time base** (`core/timebase.js`). Frames are stamped with media time —
  `requestVideoFrameCallback`'s `metadata.mediaTime`, else `video.currentTime` — and
  old frames are found by time, never by counting processed frames. `frameOffset` and
  `channelSpread` are multiples of 1/30 s. Each processed frame is classified against
  the previous stamp (`classifyStep`): a `jump` clears history, a `rewind` (loop,
  backward seek or step) drops only frames at or after the new position, a `repeat`
  (re-render while paused) stores nothing new. Don't add a code path that pushes a
  frame without a stamp, and don't count processed frames for anything a user sets:
  `frameOffset`, `channelSpread` and `trailLength` are all in 1/30 s of media time.
- **Trails** (`core/trails.js`). One feedback state per pixel and channel: the
  strongest recent diff value and its age in trail windows, shown under a
  hold-then-fade envelope. No ring of past diffs. Two states are ping-ponged so a
  frame re-rendered while paused is recomputed from the state before it.
- **Frame history** (`core/buffer.js`). `FrameRing` tracks slots and stamps, no pixels.
  WebGL: the video element is uploaded straight to a texture and past frames live in a
  `TEXTURE_2D_ARRAY` (slot = layer); nothing is read back or kept on the JS heap.
  Fallback: the worker owns the ring and the pixel buffers; the main thread transfers
  one frame per message. `ringCapacity` sizes the ring from a 192 MiB budget, capped
  at 120 frames: 120 at 640x360, 54 at 1280x720, 24 at 1920x1080. When the ring is
  too short for the lookback, `storeInterval` thins what is kept. Don't raise the
  budget, the cap or the 640px default (`DEFAULT_PROCESS_WIDTH`) without a reason.
- **Shared motion magnitude** (`core/magnitude.js`). Every mode reduces its result to
  one unsigned value per pixel, 0..1. Anything that wants "how much motion, where"
  (the sonification grid today) pools from that with `poolMagnitude` /
  `renderer.readEnergyGrid`, never from a mode's own signed output: pooling a signed
  diff cancels a moving edge to zero. A new mode adds one fill function in
  `core/magnitude.js`, its GLSL mirror, and sets `_magnitudeSource` in its render path.
- **Magnify** pools with a true box average into float (`boxPool` → `emaStep` →
  `addBand`) on both paths. Don't route the pooled frame through an 8-bit target.
- **Dual render paths:** WebGL2 preferred, Canvas2D + `pipeline.worker.js` fallback.
  The existing modes must keep working on both. New modes may be WebGL-only, but must
  then show a `setStatus()` message on the fallback path. Console logs which renderer
  is active; `?renderer=canvas2d` forces the fallback for testing.
- **Params.** All runtime knobs live on `pipeline.params` (see `app/pipeline.js`). UI
  emits param changes through `initControls` → `emitParamChange` → `main.js` →
  `pipeline.params`. Saved presets carry a version (`PRESET_VERSION` in `app/clips.js`);
  changing what a param means needs a `migratePresetParams` step.
- **Uniforms.** `createProgram` caches uniform locations and binds samplers to texture
  units once. Use `program.u.name`; never call `getUniformLocation` per frame.
- **Tests** live in `src/core/__tests__/`, vitest, node env. Use the existing
  `makePixels([R,G,B,A], ...)` helper style for pixel buffers. New core modules get
  their own describe blocks in `core.test.js` or a sibling `*.test.js`.

## Working agreements
- **The governing rule for every choice: lightweight, and easy for the owner to
  maintain and debug by hand.** Few dependencies, no clever abstractions, plain
  modules over frameworks unless a framework clearly earns its place.
- **[ROADMAP.md](ROADMAP.md) is the plan.** Update it at the end of every session:
  one status per item (done, in progress, planned, deferred).
- **Research before design:** [docs/research.md](docs/research.md) records what other
  implementations do and which of their ideas we adopted. Borrow ideas, not code,
  unless the licence allows it and the source is noted.
- **UI decisions (made, not yet built):** Tweakpane is the parameter panel, generated
  from each mode's schema, with the ARIA/focus patch from `docs/research.md` §5 and
  keyboard shortcuts for everything. One output stage with split compare against the
  original. Light and dark only, no accent themes. Lit only if it earns its place
  over plain DOM. The design direction is chosen from `docs/design/`.
- **Modes will be a registry:** one module plus one entry per mode, and each mode
  exposes its result as data (a mask, a scalar field or a vector field), not only
  display colours. Posy and Raw stay as they are.
- **Audio engine is low priority**: keep it working, do not extend it.
- Stop and report when something needs the owner's decision, especially anything
  that changes how existing output looks; show a before/after.

## Gotchas
- Web Audio / Tone.js cannot start without a user gesture — audio init must happen
  inside a click handler, never on page load.
- Rendering to float textures in WebGL2 requires the `EXT_color_buffer_float` extension —
  feature-detect, never assume. Magnify is disabled without it (or the half-float
  variant); the magnitude targets fall back to 8-bit.
- `UNPACK_FLIP_Y_WEBGL` is on for the whole context: textures are stored bottom-up.
  A shader that indexes texels with `texelFetch` and cares about image rows (pooling,
  block anchoring) must flip explicitly. `texSubImage3D` rejects that flag for array
  buffers, so pixels reach a ring layer via `uploadPixels` + `storeCurrent`.
- The WebGL canvas has `preserveDrawingBuffer: false`: read it back in the same task
  that rendered it, or you get a cleared buffer.
- `index.html` is a single hand-written shell. Keep additions to it minimal: one
  container div per feature, build the rest of the DOM from a JS module.
- `specs/` holds the specs the sonification and magnification features were built
  from. Both have shipped; they are history, not a to-do list. Where a convention
  above contradicts a spec, the convention wins.
- Don't push or deploy without being asked: a push to `master` publishes the site.
