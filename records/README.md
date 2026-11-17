# Project records

The working record of MotionDiff: what was decided, what was measured, and
what was read before building. These files are kept in the repository for
anyone extending the project. They are not published on the documentation
site. The documentation for people using or running the app is in
[`docs/`](../docs/index.md).

## What is here

| File | What it holds |
|---|---|
| [verdicts.md](verdicts.md) | The verdict log: for each change, the effect expected beforehand and the measured or judged result |
| [acceptance.md](acceptance.md) | The rules a change had to pass to be accepted |
| [model-options.md](model-options.md) | Where the two experimental model options (naming, depth) stand: what works where, known limits, open issues, next steps |
| [known-gaps.md](known-gaps.md) | What is known not to work well, in detail, and ideas that were set aside with the reason |
| [engineering-notes.md](engineering-notes.md) | The file-by-file layout, code conventions, the shader parity probes, and traps met while building |
| [research.md](research.md) | How other tools and papers do each thing, with sources, and what was taken from them. Includes the licence and patent notes |

Design notes, one per feature, each written before the feature was built and
opening with its status:

| File | Feature | Status |
|---|---|---|
| [design/optical-flow.md](design/optical-flow.md) | The flow solver and the Optical flow mode | built |
| [design/particles.md](design/particles.md) | Particle traces over a flow field | built |
| [design/schlieren.md](design/schlieren.md) | Reveal heat & air (background-oriented schlieren) | built; confirmed on recorded clips only |
| [design/display-layer.md](design/display-layer.md) | Traces and arrows drawn at display resolution | built |
| [design/readings-panel.md](design/readings-panel.md) | The readings column beside the picture, and its pen line | built |
| [design/combined-modes.md](design/combined-modes.md) | Options that combine measurements, and changes for hard footage | built |
| [design/pipeline-stages.md](design/pipeline-stages.md) | Measurements as stages computed once per frame | built |
| [design/camera-compensation.md](design/camera-compensation.md) | Subtracting the camera's own motion | built |
| [design/tracking.md](design/tracking.md) | Boxes with identities, and calibration to real units | built |
| [design/motion-magnify.md](design/motion-magnify.md) | Magnifying measured motion | built |
| [design/data-out.md](design/data-out.md) | Export of tracks and readings, and the count line | built |
| [design/naming.md](design/naming.md) | Naming tracked movers with a detector | built, experimental, parked |
| [design/depth-stage.md](design/depth-stage.md) | A depth model's map as a stage | built, experimental, parked |
| [design/model-ladder.md](design/model-ladder.md) | How a model worker chooses and proves a backend | built |

## How to read the verdict log

- Each entry has an ID (`V5`, `IA4`, `V-6T`, `M-1`). The letter groups are
  historical: V for visual changes, I for interface, and later prefixes for
  the area of work. Code comments and design notes cite entries by ID.
- An entry states the **expected effect** first. It was written before the
  change was built. The **result** follows: accepted, partly accepted, or
  failed, with the numbers or the judge's words.
- "Blind judge" means a reviewer who had not seen the work and was given
  unlabeled before and after pictures. The method is in
  [acceptance.md](acceptance.md).
- Clip names in backticks (`truth`, `traffic`, `kitten`) are the reference
  clips of the visual tooling ([scripts/README.md](../scripts/README.md)).
  `truth` and the other synthetic scenes have known motion, so results on
  them are checked against exact answers.
- Sections are in the order the work was done and are headed by topic and
  date. The log's opening says where the numbers were measured. The last
  section records what has been confirmed in use.
- Entries are not rewritten when a later change supersedes them. Read
  forward from an entry to find what replaced it.

## The documentation site

The public pages in `docs/` are built into `dist/docs/` by
`scripts/build-docs.mjs`, a small script on top of `markdown-it`, and served
beside the demo.

**Why not VitePress.** When checked in November 2026, the stable VitePress
(1.6.4, August 2025) bundled Vite 5 beside this project's Vite 8, added 173
packages and carried 3 audit advisories. The VitePress line built on Vite 8
was still alpha (2.0.0-alpha.21). `markdown-it` is 7 packages with no
advisories.

**Why there is no search.** The site is 17 short pages with every page in the
sidebar. A search box would need either a client-side search library with an
index generated in the build, or a hosted service. The browser's find-in-page
and GitHub's code search cover the need at this size. Revisit both choices if
the documentation grows.

## Removed features

Removed features and superseded material are not kept in an archive folder.
They live in git history. To read a removed file, use
`git show <commit>^:<path>`.

| Removed | Commit that removed it |
|---|---|
| HLS stream support, and the hls.js dependency | `2374faf` HLS support removed, and hls.js with it |
| Screen capture as a source | `dc71519` Screen capture archived |
| Schlieren's experimental Traces view | `cc501ae` Schlieren's experimental Traces view removed |
| Sonification (`src/app/audio.js`, `src/core/energy.js`), and the Tone.js dependency | `57cf9e6` Sonification archived, and Tone.js with it |
| The first naming approach, a classifier over box crops (`src/app/naming.js`, `src/app/imagenet-labels.js`) | `506cced` Naming by a detector: RT-DETR v2 in a worker, matched to tracks, disagreement drawn |
| A face clip among the samples | `14eeeff` Take the face clip out of the samples; Magnify has no sample yet |
| The first interface (`src/ui/controls.js`, `timeline.js`, `presets.js`, `help.js` and others) | `2414314` Step 1: mode registry, session module, new interface; old UI removed |
| The 20-frame trail ring, replaced by one decaying feedback buffer | `a0d84f9` Time-based trails: one decaying feedback buffer instead of a 20-frame ring |
| Three interface mockups (`docs/design/mockups/`) | `ba002a6` (removes the superseded mockups) |
| The original feature specifications (`specs/`), an instruction file for coding agents (`CLAUDE.md`) and four early screenshots | `998e965` Polish the README, move the detail to docs, add the MIT licence |
| Deployment through a `gh-pages` branch, replaced by GitHub Pages from the build output | `54cb9f4` Deploy to GitHub Pages from the build output on merge to master |

Designed but never built: the **motion-over-time strip** under the scrub bar
(verdict VA4). Its measurement became the readings panel's pen line, defined
in [design/readings-panel.md](design/readings-panel.md). Its design note,
`docs/motion-strip.md` (added in `48bc6dc`), was removed when these records
were moved into this folder.

Superseded documents are also in history under their old paths: the long
`ROADMAP.md` with its numbered items, and `docs/modes.md`,
`docs/development.md` and `docs/examples/`, which were rewritten as the
public pages in `docs/` (the engineering detail of `development.md` is kept
in [engineering-notes.md](engineering-notes.md)).
