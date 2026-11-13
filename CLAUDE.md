# MotionDiff

Browser-based motion extraction from video (temporal differencing, Eulerian
magnification, motion sonification). Vite + vanilla ES modules. Deployed to GitHub
Pages by `.github/workflows/deploy.yml` on push to `master`.

## Commands
- `npm run dev` — dev server at http://localhost:5173/MotionDiff/
- `npm test` — vitest run (node environment, no DOM/WebGL)
- `npm run build` — production build (must pass before any PR)
- `npm run filmstrip` — visual tooling against the running dev server: reference
  clips, filmstrips, numeric guard, screenshots (see `scripts/README.md`)

## Architecture — layer rules are strict, never violate them
```
core/  <- imports nothing (pure functions + ring buffers; all unit-testable in node)
app/   <- imports core/ only (Session, Pipeline, the mode registry in app/modes/, WebGL renderer, Canvas2D worker fallback, audio)
ui/    <- imports app/ only (DOM bindings)
main.js <- app/ + ui/, and core/ directly for pure helpers (wiring + render loop)
```
These rules govern imports between `src/` layers only. Third-party npm packages may be
imported at any layer (`ui/panel.js` imports `tweakpane`, `app/loader.js` imports
`hls.js`, `app/audio.js` lazy-imports `tone`). Test files are also exempt —
`core/__tests__/core.test.js` imports `app/source-profile.js` and `app/clips.js`.

Core modules do not import each other either: each is self-contained, and a constant
two of them need (`REFERENCE_FPS`, the luma weights) is repeated with a comment.

`core/` and `app/` stay framework-free whatever the UI is built with.

## Modes
`pipeline.params.algorithm` selects the mode. Modes are a registry: one module in
`app/modes/` plus one entry in `MODES` (`app/modes/index.js`, which documents the
shape of a mode). The pipeline calls its `render`, the panel builds its controls from
its `params`, the help sheet prints its `help`.

| id | what it is | fallback |
|---|---|---|
| `posy`, `raw` | frame differencing with trails and diff/overlay/glow | worker |
| `magnify` | Eulerian magnification; shows the amplified frame, no trails | worker; needs float targets on WebGL |
| `mask` | motion mask: three-frame differencing, pre-blur, 3×3 vote | WebGL only |
| `history` | motion history: age and direction of what moved | WebGL with float targets |
| `background` | background model: running mean and variance, gated by motion | WebGL with float targets |

Every mode also exposes its result as data (a mask, a scalar field or a vector
field) in the renderer's data target: `pipeline.readData()`, display mode `data`.
Next: optical flow (`docs/optical-flow.md`).

## Key conventions
- **Core is the source of truth.** Every visual algorithm exists twice: pure JS in
  `core/` (tested) and a GLSL mirror. Posy, Raw, trails and Magnify have theirs in
  `app/renderer.webgl.js`; a mode added through the registry keeps its shaders in its
  own module (`app/modes/mask.js`, `history.js`, `background.js`). The shader must
  match the core, exactly where the data is 8-bit: the diff, blur and mask shaders
  work on whole 0..255 values for that reason. Dev builds expose parity probes that
  run the same synthetic frames through both (`app/probes.js`):
  `__motionDiffDiffParity()`, `__motionDiffTrailParity()`,
  `__motionDiffEnergyParity()`, `__magnifyParityHarness()`,
  `__motionDiffMaskParity()`, `__motionDiffHistoryParity()`,
  `__motionDiffBackgroundParity()`. Run them after touching a shader or its core
  function. A new mode gets a core function with tests first, then its shader mirror
  and a probe. State kept in half floats cannot match a Float32 core bit for bit: such
  a probe counts mismatches (background: under 0.1% of decisions) instead of
  demanding none.
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
  frame re-rendered while paused is recomputed from the state before it. Colour-by-age
  has two styles: `latest` (time since the pixel last moved) and `mixed`, which also
  tracks the age and typical strength of the current burst of motion to give the
  new-and-old look the old ring had.
- **Mode feedback state.** A mode with state of its own (history, background) follows
  the trail's pattern: two targets from `renderer.target()`, a per-renderer record of
  which is current, recompute rather than advance when `frame.step === 'repeat'`
  (use `frame.stepMs`, which keeps its value on a repeat), and start over when
  `renderer.epoch` changes (it counts every seek, source change, mode change and
  resize).
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
  diff cancels a moving edge to zero. The built-in modes have a fill function in
  `core/magnitude.js` and set `_magnitudeSource`; a registry mode draws its data into
  `renderer.dataFramebuffer()` itself, with the magnitude in R.
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
- **UI, as built** (`ui/shell.js`, `ui/panel.js`, `ui/ruler.js`, `ui/keys.js`,
  `styles/main.css`): Tweakpane is the parameter panel, generated from each mode's
  schema, with the ARIA/focus patch from `docs/research.md` §5 and a key for
  everything. One output stage with split compare against the original. Light and
  dark only. Plain DOM shell (no Lit): one DOM, two layouts chosen by
  `#app[data-layout]`. **Plate** is the desktop default, with its time ruler and the
  dark "cyanotype" theme; **Viewfinder** is fullscreen and every touch or narrow
  device, where the phone camera is the main source. All interface state lives in
  `app/session.js`; the shell calls its methods and redraws on its events.
- **Colour-by-age keeps both looks, selectable.** Magnify band-gain normalisation is deferred.
- **Modes are a registry** (see Modes above), and each exposes its result as data,
  not only display colours. Posy and Raw stay as they are.
- **`docs/verdicts.md` is the log** the acceptance rules ask for: the expectation
  before building, the judge's result after.
- **Audio engine is low priority**: keep it working, do not extend it.
- Stop and report when something needs the owner's decision, especially anything
  that changes how existing output looks; show a before/after.

## Acceptance rules
The owner does not judge visual results. The agent does, under these rules, and only
brings the owner things that need permission (pushing, deploying) or that remove an
existing look. Tune the numbers below if they prove wrong, and record the change and
the reason under "Changes to these rules".

Tag every change as **visual**, **performance** or **robustness**.
- **Performance** is accepted on measured numbers (before and after, same machine,
  interleaved runs).
- **Robustness** is accepted on a demonstration of the case that broke before and
  works now.
- Unit tests stay for logic the eye can't check. Shader parity passes at about 2/255.

**Visual changes**
1. Before building, write down the expected effect and which reference clip should
   show it (in `docs/verdicts.md`).
2. Prototype cheaply, then render before/after filmstrips (several frames in a row)
   on the reference clips: `npm run filmstrip` (see `scripts/README.md`).
3. Judging is done by a fresh subagent that has not seen the work. Give it the two
   filmstrips unlabeled and in random order, at normal viewing size, plus the criteria.
4. **Visible:** the judge can tell them apart and describes the difference correctly.
   If it can't on any clip, the change has no visible effect: stop, defer it, log it.
5. **Intended:** the difference matches what was written down beforehand.
6. **No regression on the other clips:** static areas stay at baseline, no new
   flicker, banding or clipping, no motion lost that was visible before.
7. **Numeric guard:** if fewer than about 0.5% of pixels change by more than 4/255,
   treat it as invisible whatever the judge says. Flicker in static areas must not rise.

**New modes**, checked on the synthetic clip (known truth) and the reference clips:
- **Motion mask:** marks the object at its current position only, no ghost at the old
  one, and visibly fewer speckles than Raw at the same threshold on the noisy clip.
- **Motion history:** direction hue within about 20 degrees of the known direction;
  age rises steadily along the path.
- **Background model:** filled silhouette where frame differencing gives an outline;
  a stopped object is absorbed in roughly the set time; no permanent ghost.
- Each mode must show something Posy and Raw don't on at least one clip, as named by
  the blind judge. If not, report that instead of shipping it.

**Interface**, from screenshots at desktop and phone sizes in every state:
- The picture is the largest element (at least half the viewport in the Plate layout,
  all of it in the Viewfinder layout).
- Text contrast at least 4.5:1, nothing overlapping or clipped, focus visible, touch
  targets at least 44 px, overlays hide when idle in the Viewfinder layout.
- A fresh subagent critiques it against the brief: distinct, not a generic dashboard.

**Changes to these rules** (session 3):
- *Picture share in the Plate layout is measured with 16:9 footage.* A wider clip
  (1366×720) gets 49% with the panel open; that is the footage's shape, not the layout.
- *"All of the viewport" in the Viewfinder means the frame.* A clip that would lose
  more than half its picture to cropping (landscape footage on an upright phone) is
  shown whole inside it; a double tap switches to filling.
- *"Age rises steadily along the path" is measured on the median across the trail,*
  not on single pixels: a flat synthetic object leaves stray specks that say nothing
  about the trail.
- *Parity "at about 2/255" applies to 8-bit and Float32 data.* For decisions made from
  half-float state the probe allows a mismatch rate under 0.1%.
- *A judge's "same look, with a caveat" counts as a match* for the purpose of the
  colour-by-age decision (ring only if it does not match): three rounds gave that
  verdict, and the caveat is recorded in `docs/verdicts.md`, V1.

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
- Do not hold a GLSL `bool` computed from a variable that is reassigned later in the
  shader: one GPU compiler here evaluated it after the reassignment (53/255 off in
  the trail probe). Compute a float instead.
- Creating a texture binds it. A mode asks for all its `renderer.target()`s and the
  `dataFramebuffer()` before binding textures for a draw, or the first frame draws
  from the wrong texture.
- `gl.finish()` does not wait for the GPU in Chrome. To time a frame, read one pixel
  back after it.
- Video decoders start slowly: give playback two or three seconds before counting
  frames. Browser-recorded WebM cannot be seeked frame-accurately, which is why the
  filmstrip tool draws synthetic scenes itself (`scripts/page/scene.js`).
- `index.html` is a single hand-written shell. Keep additions to it minimal: one
  container div per feature, build the rest of the DOM from a JS module.
- `specs/` holds the specs the sonification and magnification features were built
  from. Both have shipped; they are history, not a to-do list. Where a convention
  above contradicts a spec, the convention wins.
- Don't push or deploy without being asked: a push to `master` publishes the site.
  The workflow uploads `dist/` to Pages directly (no `gh-pages` branch), runs the
  tests first, and needs the repository's Pages source set to "GitHub Actions".
