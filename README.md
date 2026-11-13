# MotionDiff
MotionDiff is a browser-based temporal frame differencing tool for revealing subtle motion in video.

## Algorithm

### Posy Blend (default)
Posy Blend compares the current frame against an older frame after inverting the old one:

`blend = (current + invert(old)) / 2`

For a static pixel, the math always collapses to the same midpoint:

`static pixel: (V + (255 - V)) / 2 = 128`

That is true for every possible input value `V`. The consequence is the signature MotionDiff look: the background cancels to gray, and motion glows away from gray. With RGB time-shift enabled, the color of that glow depends on which channel is comparing against which moment in time, so direction and speed become visible as colored fringes instead of plain luminance.

### Raw Diff
Raw Diff uses absolute channel difference:

`diff = |current - old|`

Static regions go to black, and brighter pixels mean larger motion between the two samples. It is the more literal mode: high contrast, easy to read, and good for simple motion detection when you do not need Posy mode's gray-centered directional color.

### Frame offset (k)
The frame offset chooses how far back in time the comparison reaches. One unit is 1/30 s of video time: frames are stamped with their media time and the comparison frame is looked up by time, so `k` means the same thing at any source frame rate, playback speed or processing fps cap.

| k value | Best for |
|---------|----------|
| 1-3 | Fast motion, people walking, hand gestures |
| 5-15 | General nature footage, moderate motion |
| 20-40 | Slow drift, clouds, fog, rising steam |
| 50-90 | Imperceptibly slow motion, moonrise, tide |

### RGB channel time-shift
Instead of comparing all channels to the same old frame, MotionDiff can offset them in time:

- Red samples `k`
- Green samples `k + spread`
- Blue samples `k + spread x 2`

That stagger turns time into color. When an edge moves, each channel sees it at a slightly different temporal position, so the merged result becomes a directional smear rather than a white outline.

```text
time:     now  <- current frame
R old:    t - k
G old:    t - (k + spread)
B old:    t - (k + spread x 2)
```

### Trails
A trail keeps a pixel's motion on screen for a while after it happened. For every pixel and channel MotionDiff remembers the strongest recent diff value and how long ago it was written, holds it at full strength for the first half of the trail length, then fades it out.

- Posy mode measures strength as deviation from 128 and fades back to grey.
- Raw Diff measures it as the channel value and fades to black.

Trail length is in the same 1/30 s units as the frame offset and is measured in video time, so a trail lasts the same at any frame rate, playback speed or processing fps cap. Short trails show immediate movement. Long trails turn motion into persistent streaks and ghosted silhouettes.

### Threshold
Threshold suppresses noise before accumulation. It is the mean absolute channel difference between the two frames (0-255) and means the same in Posy and Raw mode.

- Low threshold: more sensitive, more noise.
- High threshold: cleaner image, but subtle motion can disappear.

### Display modes
| Mode | Description |
|------|-------------|
| Diff | Raw algorithm output only |
| Overlay | Motion screen-blended onto original frame |
| Glow | Original + amplified additive bloom from motion |

## Project structure
```text
.
├── .github/workflows/deploy.yml    Build and GitHub Pages deploy on push to master.
├── public/                         Favicon and shared SVG icon sheet.
├── specs/                          Specs the sonification and magnification features were built from.
├── src/
│   ├── app/
│   │   ├── audio.js                Sonification engine (Tone.js, loaded lazily).
│   │   ├── clips.js                Built-in preset clips and parameter presets.
│   │   ├── exporter.js             MediaRecorder-based WebM export helper.
│   │   ├── loader.js               URL source detection and HLS attachment.
│   │   ├── pipeline.js             Runtime orchestration for capture, buffering, and renderer selection.
│   │   ├── pipeline.worker.js      Canvas fallback worker for diff, blur, trails, and magnify.
│   │   ├── renderer.js             Canvas 2D compositing for the fallback path.
│   │   ├── renderer.webgl.js       WebGL2 renderer and shader pipeline.
│   │   └── source-profile.js       Per-source capture settings (file, URL, HLS, camera, screen).
│   ├── core/
│   │   ├── __tests__/              Unit tests (vitest, node).
│   │   ├── analyze.js              Auto-configuration: noise floor, threshold and gap from frame bursts.
│   │   ├── blur.js                 3 x 3 box blur.
│   │   ├── buffer.js               Frame ring bookkeeping and memory budgeting.
│   │   ├── diff.js                 Posy Blend and Raw Diff pixel math.
│   │   ├── energy.js               Motion energy grid and pitch/pan mapping for sonification.
│   │   ├── magnify.js              Eulerian magnification math.
│   │   ├── magnitude.js            Shared unsigned motion magnitude and grid pooling.
│   │   ├── timebase.js             Media-time base: frame stamps, seek/loop detection, lookback.
│   │   └── trails.js               Trails: one decaying feedback state per pixel.
│   ├── styles/main.css             Application stylesheet and theme variables.
│   ├── ui/                         DOM bindings: controls, timeline, presets, audio panel, help, theme, status.
│   └── main.js                     App wiring and render loop control.
├── docs/                           Examples, parameter recipes, research notes, design mockups.
├── ROADMAP.md                      What is done, in progress, planned and deferred.
├── index.html                      Single-page shell.
└── vite.config.js                  Vite base-path configuration.
```

Layer dependencies are intentionally strict:

```text
core/ <- no imports
app/  <- core/ only
ui/   <- app/ only
main.js <- app/ + ui/ (and core/ for pure helpers)
```

## Development
```bash
git clone <repo>
cd motiondiff
npm install
npm run dev     # http://localhost:5173/MotionDiff/
npm test        # run core unit tests
npm run build   # production build
```

## Renderer
MotionDiff detects WebGL2 at runtime and uses it when available; otherwise it falls back to a Canvas 2D + Worker pipeline. The console logs which renderer is active, so you can confirm the path immediately on load.

On the WebGL path frames never leave the GPU: the video element is uploaded with `texImage2D`, scaled to the processing size, and past frames are kept in a `TEXTURE_2D_ARRAY` ring. Diff, blur, accumulation, and composite passes all run as shaders. The ring is sized from a memory budget (192 MiB), so it holds 120 frames at 640px, 54 at 1280x720 and 24 at 1920x1080. The Canvas 2D fallback still captures through `getImageData`, but keeps its frame history inside the worker. Append `?renderer=canvas2d` to the URL to run the fallback on a machine that has WebGL2.

## Magnify mode and patents
Magnify implements the simplest real-time variant of Eulerian video magnification (Wu et al., SIGGRAPH 2012) from the published description; it contains no MIT code. The method itself is covered by MIT patents (US 9,811,901 and related), which MIT licenses for commercial use. This project is a personal, non-commercial demo. If you want to use magnify mode commercially, ask MIT's Technology Licensing Office or a lawyer first. See `docs/research.md`.

## Tests
Tests cover the pure functions under `src/core/`: diff math, blur, ring buffers, the time base, trails, analysis, the shared motion magnitude, the sonification grid mapping, and the magnification math. Run them with `npm test`.

The shaders are checked against those functions in a real browser: in a dev build, `__motionDiffDiffParity()`, `__motionDiffTrailParity()`, `__motionDiffEnergyParity()` and `__magnifyParityHarness()` in the console run the same synthetic frames through core and GPU and report the largest difference.
