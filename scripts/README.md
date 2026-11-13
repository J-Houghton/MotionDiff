# Dev scripts

Visual tooling for the acceptance rules in `docs/development.md`. Dev-only: nothing here
ships. No dependencies beyond Node 22 and an installed Chrome or Edge
(`CHROME_PATH` overrides where to find it).

All commands drive the **running dev server** through headless Chrome, so start
`npm run dev` first.

## Reference clips
```bash
npm run filmstrip clips
```
Fills `ref-clips/` (git-ignored) from `scripts/reference-clips.json`: clips with a
`url` are downloaded, the synthetic ones are recorded in the browser.

| id | what it is for |
|---|---|
| `truth` | Known truth. A square that moves right at 120 px/s, **stops from 3.5 s to 8.5 s**, then moves on; a disc heading 30° down-right at 104 px/s; a disc heading left at 100 px/s from 6 s. Light noise. |
| `truth-noisy` | The same scene under heavy sensor noise. |
| `sixty` | A 60 fps source. |
| `pulse` | A still patch whose brightness swings about one level at 1.2 Hz. Invisible to the eye; for magnify. |
| `trees` | Fast motion: branches in strong wind, static camera. |
| `river` | Motion everywhere: flowing water. |
| `sunset` | Slow drift: clouds in a timelapse. |
| `night` | Low light: people walking by the water at night, moderate grain. |
| `handheld` | Handheld camera: a marching crowd, the whole frame wobbles (24 fps). |
| `face` | A face held nearly still on a locked camera, for magnify (25 fps). |
| `highway` | A real 60 fps source: fast vehicles, near-static camera. |

| `flow` | Known flow, synthetic: a textured band sliding right at 90 px/s, a block heading down-left at 60 px/s, a disc turning at 1 rad/s. |
| `plume`, `plume-weak`, `plume-wall`, `plume-drift` | Schlieren with a known answer, synthetic: a background warped by a simulated plume (lit at 1 s; typical shift 0.28 px, or 0.08 px for `-weak`), against print, against a rough surface with a plain strip, and from a camera that creeps and trembles. |
| `candle-dots` | Real schlieren footage: a candle plume against printed random dots (MIT, JPaonaskar/Background-Oriented-Schlieren). |
| `candle-screen` | Real schlieren footage: a candle against a monitor showing a fine checkerboard; needs a processing width of 1280 px or more (MIT, FinFetChannel/SyntheticSchlieren). |

| `weir`, `clouds`, `crossing`, `bees`, `gulls`, `flower` | The clips behind the app's samples, each with a static camera: water down a weir, a cloud timelapse over a ridge, an intersection from above (60 fps), bees on a plain wall, gulls against clear sky, a flower opening. |

Clips are test material only and are not redistributed with the repository.

The synthetic scenes are defined in `scripts/page/scene.js`, which also gives the
exact position of every object at every frame. Filmstrips of a synthetic clip do not
use the recorded file: the tool draws each frame and pushes it through the pipeline
with its exact timestamp (browser-recorded WebM cannot be seeked frame-accurately),
and the truth for each captured frame is written to the meta file. The recorded
files are for watching the scene in the app.

## Filmstrips
```bash
npm run filmstrip render -- --scenes scenes.json --out filmstrips --tag after
```
Renders one filmstrip per scene: several frames in a row from fixed moments of a
clip, at 480 px per frame. The clip is **stepped frame by frame** through the real
pipeline (not played), so the result is the same on a slow machine.

A scenes file:
```json
{ "scenes": [
  { "name": "trees-posy", "clip": "trees", "at": 4.0, "frames": 6, "every": 3,
    "display": "diff", "params": { "algorithm": "posy", "frameOffset": 10, "trailLength": 15 } }
] }
```
`"switch": { "at": 0.9, "params": { ... } }` changes settings from that moment on
(used to hold the schlieren reference just before the plume is lit), and
`"readTarget": "<name>"` saves one of a mode's own float targets beside the data.
`at` is where the strip starts (seconds), `every` how many source frames apart its
frames are, `warmup` (default 1.5 s) how much video is run through first so
history and trails are populated. `params` are `pipeline.params`.

Output per scene: `<tag>-<name>.png`, `<tag>-<name>.original.jpg` (the same moments
of the source video) and an entry in `<tag>-meta.json`.

To render a **before** from an older commit, check it out in a second worktree,
run its dev server on another port and pass `--url`. Builds older than the dev API
are driven through their old controls automatically.

## Numeric guard
```bash
npm run filmstrip compare -- --a before-x.png --b after-x.png \
  --original after-x.original.jpg --meta filmstrips/after-meta.json --scene x
```
Prints the share of pixels that differ by more than 4/255, each strip's flicker in
static areas (mean change between consecutive frames where the source did not
change), the share of clipped pixels, and each strip's mean colour (to tell a hue
or brightness shift from a change of shape).

The scenes used for this session's verdicts are in `scripts/scenes/` (`age-colour`,
`mask`, `history`, `background`, `flow`, `schlieren`): re-render them after touching those modes.

## Checks against known truth
```bash
node scripts/truth-check.mjs --dir filmstrips --tag mask --scene truth-mask --gap 5
```
For a scene on a synthetic clip rendered with `"readData": true`: reads the mode's
data output for the last frame and reports where its marks lie relative to the known
object outlines (current position, the position one gap ago, elsewhere) and how much
of each outline is filled. `--box x,y,w,h` adds the share marked inside a box, for a
place where something used to stand. For a vector field (motion history) it reports
instead the mean heading over each object's trail against the known heading, and the
age along the path behind it (`--history` is the history length in seconds).

For optical flow, `--flow 1` compares the velocity in the data output with the known
motion of the `flow` scene (heading and speed per mover, and how much of the still
background reads under 5 px/s). For schlieren, `--schlieren 1` compares the measured
shift with the known field of a `plume` scene (correlation, size, and how quiet the
picture is beside the plume); add `--target 1` to check the saved eddy velocity
instead (heading and speed).

`node scripts/make-pattern.mjs` regenerates `public/schlieren-pattern.svg`, the
printable background for schlieren.

## Interface screenshots and one-off checks
```bash
npm run filmstrip shot -- --out shot.png --w 390 --h 844 --mobile --dpr 2
npm run filmstrip eval -- --run check.js
```
`--run` evaluates a file as an async function body in the page (`args` comes from
`--args '{"k":1}'`), `--keys p,f` presses keys afterwards.

Note for timing measurements: give playback two or three seconds to warm up before
counting frames. Decoders start slowly, and a short window right after load looks
like a stall.
