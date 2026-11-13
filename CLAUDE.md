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
`core/__tests__/core.test.js` imports `app/source-profile.js`.

`core/` and `app/` stay framework-free whatever the UI is built with.

## Modes
`pipeline.params.algorithm` selects the mode: `posy`, `raw` (frame differencing with
trails and diff/overlay/glow compositing) or `magnify` (Eulerian magnification, shows
the amplified frame directly, no trails/compositing). Planned modes: three-frame
differencing, motion history, background subtraction, optical flow.

## Key conventions
- Posy space: 128 (0.5 in shaders) = "no motion" baseline. Motion = deviation from 128.
  Raw mode baseline is 0. Any new math must respect the mode's baseline.
- Every visual algorithm exists twice: pure JS in `core/` (tested) and a GLSL mirror in
  `app/renderer.webgl.js`. The core version is the source of truth; the shader must match it.
  Dev builds expose parity probes on `window` (`__magnifyParityHarness`,
  `__motionDiffEnergyParity`) that run the same synthetic frames through both.
- Dual render paths: WebGL2 preferred, Canvas2D + `pipeline.worker.js` fallback. The
  existing modes must keep working on both. New modes may be WebGL-only, but must then
  show a `setStatus()` message on the fallback path. Console logs which renderer is active.
- All runtime knobs live on `pipeline.params` (see `app/pipeline.js`). UI emits param
  changes through `initControls` → `emitParamChange` → `main.js` → `pipeline.params`.
- Tests live in `src/core/__tests__/`, vitest, node env. Use the existing
  `makePixels([R,G,B,A], ...)` helper style for pixel buffers. New core modules get their
  own describe blocks in `core.test.js` or a sibling `*.test.js` in the same folder.
- Processing resolution defaults to 640px wide (`DEFAULT_PROCESS_WIDTH`); the frame
  store holds at most 120 frames. Don't grow either without a reason.

## Decisions for the core refactor (branch `core-timebase-gpu-ring`)
Recorded up front; each becomes a convention above once the code lands.
1. **GPU frame ring.** The WebGL path uploads the video element straight to a texture
   and keeps past frames in a `TEXTURE_2D_ARRAY` ring. No per-frame `getImageData`, no
   frame history on the JS heap. Ring capacity comes from a memory budget, so it shrinks
   at 1280/1920px.
2. **Media-time base.** Frames are stamped with media time
   (`requestVideoFrameCallback` `metadata.mediaTime`, else `video.currentTime`) and old
   frames are selected by time, not by counting processed frames. `frameOffset` and
   `channelSpread` keep their names and preset values but mean multiples of 1/30 s, so
   they no longer change meaning with source fps, fps cap, playback rate or dropped
   frames. Seeks and loops are detected from the timestamps and clear the store, trails
   and magnify state. Time-base and selection logic is pure and lives in `core/`.
3. **Shared motion magnitude.** Every mode produces an unsigned per-pixel motion
   magnitude (0..1). Anything that consumes "how much motion, where" (the sonification
   energy grid today, future modes later) pools from that, never from a signed diff.
4. **Worker-owned store.** On the Canvas2D fallback the frame store lives inside the
   worker; the main thread transfers one frame per message.
5. **Auto-configure from bursts.** Samples short bursts of consecutive frames, takes the
   noise floor from the median gap-1 difference and derives gap and threshold from it.
6. **Magnify precision.** Spatial pooling is a true box average into a float target
   (GPU) / Float32Array (worker) before the EMAs.
7. **One threshold unit.** `threshold` is the mean absolute channel difference between
   the two frames (0..255) in every mode. Posy presets saved before this change are
   migrated on load.
8. **UI replacement comes after the core work** and needs explicit approval of the
   design first. Modes will be a registry: one module plus one entry per mode.
9. **Audio engine is low priority**: keep it working, do not extend it.

## Gotchas
- Web Audio / Tone.js cannot start without a user gesture — audio init must happen
  inside a click handler, never on page load.
- Rendering to float textures in WebGL2 requires the `EXT_color_buffer_float` extension —
  feature-detect, never assume.
- `index.html` is a single hand-written shell. Keep additions to it minimal: one
  container div per feature, build the rest of the DOM from a JS module.
- `specs/` holds the specs the sonification and magnification features were built
  from. Both have shipped; they are history, not a to-do list. Where a decision above
  contradicts a spec, the decision wins.
- Don't push or deploy without being asked: a push to `master` publishes the site.
