# Development

How the project is laid out, the conventions that keep it maintainable, and how a change is checked before it is accepted.

The rule behind every choice: **lightweight, and easy to maintain and debug by hand.** Few dependencies, plain modules, no clever abstractions.

- [Commands](#commands) · [Layout](#layout) · [Layer rules](#layer-rules)
- [Conventions](#conventions) · [Adding a mode](#adding-a-mode)
- [Tests and parity probes](#tests-and-parity-probes)
- [How changes are accepted](#how-changes-are-accepted)
- [Gotchas](#gotchas) · [Deployment](#deployment)

## Commands
```bash
npm run dev        # dev server at http://localhost:5173/MotionDiff/
npm test           # unit tests (vitest, node environment, no DOM or WebGL)
npm run build      # production build
npm run filmstrip  # visual tooling against the running dev server, see scripts/README.md
```

Useful URL switches in a dev build: `?renderer=canvas2d` forces the Canvas 2D fallback, `?nofloat` pretends the GPU has no float render targets. The console logs which renderer is active.

## Layout
```text
.
├── .github/workflows/deploy.yml    Tests, build and GitHub Pages deploy on push to master
├── public/                         Favicon, icon sheet, fonts
├── scripts/                        Dev-only visual tooling (scripts/README.md)
├── docs/                           This folder
├── src/
│   ├── core/                       Pure functions, unit-tested
│   │   ├── diff.js                 Posy and Raw pixel maths
│   │   ├── blur.js                 3×3 box blur
│   │   ├── trails.js               Trails: one decaying feedback state per pixel
│   │   ├── mask.js                 Motion mask: three-frame differencing, clean-up vote
│   │   ├── history.js              Motion history: age per pixel, heading from its slope
│   │   ├── background.js           Background model: running mean and variance
│   │   ├── magnify.js              Eulerian magnification maths
│   │   ├── magnitude.js            Shared unsigned motion magnitude, grid pooling
│   │   ├── timebase.js             Media-time base: stamps, seek and loop detection, lookback
│   │   ├── buffer.js               Frame ring bookkeeping, memory budget
│   │   ├── analyze.js              Auto-configure: noise floor, threshold and gap
│   │   └── energy.js               Motion grid to pitch and pan, for sonification
│   ├── app/
│   │   ├── modes/                  The mode registry: one module per mode, index.js, shared params
│   │   ├── session.js              Everything the interface drives: sources, transport, recording
│   │   ├── pipeline.js             Per-frame orchestration, renderer selection
│   │   ├── renderer.webgl.js       WebGL2 renderer and the built-in shaders
│   │   ├── pipeline.worker.js      Canvas 2D fallback: diff, blur, trails, magnify in a worker
│   │   ├── renderer.js             Canvas 2D compositing for the fallback
│   │   ├── probes.js               Dev-only shader-versus-core parity probes
│   │   ├── loader.js               URL source detection, HLS
│   │   ├── source-profile.js       Per-source capture settings
│   │   ├── clips.js                Sample clips and parameter presets
│   │   ├── exporter.js             WebM export (MediaRecorder)
│   │   └── audio.js                Sonification engine (Tone.js, loaded lazily)
│   ├── ui/
│   │   ├── shell.js                The DOM: stage, split compare, caption, transport, sheets
│   │   ├── panel.js                Parameter panel (Tweakpane), built from each mode's schema
│   │   ├── ruler.js                The time ruler
│   │   └── keys.js                 The keyboard map
│   ├── styles/main.css             Both layouts, both themes
│   └── main.js                     Wiring
├── ROADMAP.md
└── index.html                      A minimal shell; the DOM is built in ui/shell.js
```

## Layer rules
Strict, and worth keeping:

```text
core/   imports nothing
app/    imports core/ only
ui/     imports app/ only
main.js imports app/ and ui/, and core/ for pure helpers
```

- The rules are about imports between `src/` layers. Third-party packages may be imported at any layer (`ui/panel.js` uses Tweakpane, `app/loader.js` hls.js, `app/audio.js` lazy-loads Tone.js). Test files are exempt.
- Core modules do not import each other either. Each is self-contained; a constant two of them need (the reference frame rate, the luma weights) is repeated with a comment.
- `core/` and `app/` stay free of any UI framework.

## Conventions

**Core is the source of truth.** Every visual algorithm exists twice: plain JavaScript in `core/`, with tests, and a GLSL mirror. Posy, Raw, trails and Magnify have their shaders in `app/renderer.webgl.js`; a mode added through the registry keeps its shaders in its own module. The shader must match the core, exactly where the data is 8-bit: the diff, blur and mask shaders work on whole 0..255 values for that reason.

**Baselines.** In Posy space 128 means "no motion" (`128.0 / 255.0` in shaders, never `0.5`) and motion is the deviation from it. In Raw space the baseline is 0. New maths must respect the baseline of the space it writes to.

**Threshold** is the mean absolute channel difference between two frames, 0..255, in every mode. (Posy stores half-differences, so `posyBlend` doubles before comparing.)

**Time base** (`core/timebase.js`). Frames are stamped with media time (`requestVideoFrameCallback`'s `mediaTime`, else `video.currentTime`) and old frames are found by time, never by counting processed frames. Gap, spread, trail and history lengths are all in 1/30 s of media time. Each frame is classified against the previous stamp (`classifyStep`): a `jump` clears history, a `rewind` drops only frames at or after the new position, a `repeat` (the same frame rendered again while paused) stores nothing new. Do not add a path that pushes a frame without a stamp, and do not count processed frames for anything a user sets.

**Frame history** (`core/buffer.js`). `FrameRing` tracks slots and stamps, not pixels. On WebGL the video element is uploaded straight to a texture and past frames live in a `TEXTURE_2D_ARRAY` (slot = layer); nothing is read back or kept on the JS heap. On the fallback the worker owns the ring and the pixel buffers. The ring is sized from a 192 MiB budget and capped at 120 frames: 120 at 640×360, 54 at 1280×720, 24 at 1920×1080. When it is too short for the lookback, `storeInterval` thins what is kept. Phones get a 64 MiB budget and a 480 px processing width.

**Trails** (`core/trails.js`). One feedback state per pixel and channel: the strongest recent value and its age in trail windows, shown under a hold-then-fade envelope. There is no ring of past diffs. Two states are ping-ponged so a frame rendered again while paused is recomputed from the state before it, not stacked on its own result.

**Feedback state in a mode.** A mode with state of its own (history, background) follows the trail's pattern: two targets from `renderer.target()`, a per-renderer record of which is current, recompute rather than advance when `frame.step === 'repeat'` (use `frame.stepMs`, which keeps its value on a repeat), and start over when `renderer.epoch` changes (it counts every seek, source change, mode change and resize).

**Shared motion magnitude** (`core/magnitude.js`). Every mode reduces its result to one unsigned value per pixel, 0..1. Anything that wants "how much motion, where" (the sonification grid today) pools from that, never from a mode's own signed output: pooling a signed difference cancels a moving edge to zero. A registry mode draws its data into `renderer.dataFramebuffer()` with the magnitude in R.

**Two render paths.** WebGL2 is preferred; Canvas 2D with `pipeline.worker.js` is the fallback. Posy, Raw and Magnify must keep working on both. A new mode may be WebGL-only, but must then report that through the status line on the fallback.

**Params.** Every runtime setting lives on `pipeline.params`, defined by the modes' schemas. The interface changes them through `Session.setParams`. Saved presets carry a version (`PRESET_VERSION` in `app/clips.js`); changing what a param means needs a `migratePresetParams` step.

**Uniforms.** `createProgram` caches uniform locations and binds samplers to texture units once. Use `program.u.name`; never look a location up per frame.

**Interface.** One DOM, two layouts chosen by `#app[data-layout]` in CSS: *Plate* (desktop) and *Viewfinder* (fullscreen, and any touch or narrow device). Light and dark themes only. All interface state lives in `app/session.js`; the shell calls its methods and redraws on its events. `index.html` stays a minimal shell.

## Adding a mode
1. Write the algorithm as pure functions in `core/<name>.js`, with tests in `src/core/__tests__/`.
2. Add `app/modes/<name>.js` (the shape of a mode is documented at the top of `app/modes/index.js`) with its shaders, and one entry in `MODES`.
3. Add a parity probe in `app/probes.js` that runs the same synthetic frames through both.
4. Write down in [verdicts.md](verdicts.md) what the mode should show, and on which clip, **before** judging it; then render filmstrips and check them (below).

The panel, the help sheet, the key for the mode and the data view follow from the registry entry.

## Tests and parity probes
Unit tests cover the pure functions under `src/core/`. Run them with `npm test`.

The shaders are checked against those functions in a real browser. In a dev build, call these in the console on an idle page:

```text
__motionDiffDiffParity()        __motionDiffMaskParity()
__motionDiffTrailParity()       __motionDiffHistoryParity()
__motionDiffEnergyParity()      __motionDiffBackgroundParity()
__magnifyParityHarness()
```

Each runs the same synthetic frames through core and GPU and reports the difference. 8-bit and Float32 results are expected to agree within about 2/255. State kept in half floats cannot match a Float32 core bit for bit, so the background probe counts mismatched decisions (under 0.1%) instead of demanding none. Run the probes after touching a shader or its core function.

## How changes are accepted
Every change is tagged **visual**, **performance** or **robustness**.

- **Performance** is accepted on measured numbers: before and after, same machine, interleaved runs.
- **Robustness** is accepted on a demonstration of the case that broke before and works now.
- Unit tests stay for logic the eye cannot check.

**Visual changes** are judged blind, so that nobody who built the change decides whether it worked:

1. Before building, write down the expected effect and the reference clip that should show it, in [verdicts.md](verdicts.md).
2. Render before and after filmstrips (several frames in a row from fixed moments) on the reference clips: `npm run filmstrip`.
3. A reviewer who has not seen the work (in this project, a fresh AI agent) gets the two filmstrips unlabeled and in random order, plus the criteria.
4. **Visible:** the reviewer can tell them apart and describes the difference correctly. If not, the change has no visible effect: defer it and log it.
5. **Intended:** the difference matches what was written down beforehand.
6. **No regression** on the other clips: static areas stay at baseline, no new flicker, banding or clipping, no motion lost.
7. **Numeric guard:** if fewer than about 0.5% of pixels change by more than 4/255, treat it as invisible whatever the reviewer says. Flicker in static areas must not rise.

**New modes** are also checked against synthetic clips whose motion is known exactly (`scripts/truth-check.mjs`), and each must show something the existing modes do not on at least one clip, as named by the blind reviewer.

**Interface** changes are judged from screenshots at desktop and phone sizes in every state (`scripts/page/audit.js` measures the first four):
- The picture is the largest element: at least half the viewport in the Plate layout with 16:9 footage, all of it in the Viewfinder.
- Text contrast at least 4.5:1; nothing overlapping or clipped; focus visible; touch targets at least 44 px.
- Overlays hide when idle in the Viewfinder.
- A fresh reviewer critiques it against the brief: distinct, not a generic dashboard.

Clarifications made along the way, with their reasons:
- Picture share in the Plate is measured with 16:9 footage; a wider clip gets slightly under half, which is the footage's shape and not the layout.
- In the Viewfinder a clip that would lose more than half its picture to cropping (landscape footage on an upright phone) is shown whole; a double tap switches to filling.
- "Age rises steadily along a path" is measured on the median across the trail, not on single pixels.

## Gotchas
- Web Audio cannot start without a user gesture: audio initialisation must happen inside a click handler.
- Rendering to float textures in WebGL2 needs `EXT_color_buffer_float` (or the half-float variant). Feature-detect, never assume.
- `UNPACK_FLIP_Y_WEBGL` is on for the whole context: textures are stored bottom-up. A shader that indexes texels with `texelFetch` and cares about image rows must flip explicitly. `texSubImage3D` rejects that flag for array buffers, so pixels reach a ring layer through `uploadPixels` and `storeCurrent`.
- The WebGL canvas has `preserveDrawingBuffer: false`: read it back in the same task that rendered it, or you get a cleared buffer.
- Creating a texture binds it. A mode asks for all its `renderer.target()`s and the `dataFramebuffer()` before binding textures for a draw, or the first frame draws from the wrong texture.
- Do not hold a GLSL `bool` computed from a variable that is reassigned later in the shader: one GPU compiler evaluated it after the reassignment. Compute a float instead.
- `gl.finish()` does not wait for the GPU in Chrome. To time a frame, read one pixel back after it.
- Video decoders start slowly: give playback two or three seconds before counting frames. Browser-recorded WebM cannot be seeked frame-accurately, which is why the filmstrip tool draws its synthetic scenes itself.

## Deployment
`.github/workflows/deploy.yml` runs the tests, builds, and publishes `dist/` to GitHub Pages on every push to `master` (a merged pull request). The repository's Pages source must be set to "GitHub Actions". The site is served under `/MotionDiff/` (`base` in `vite.config.js`).
