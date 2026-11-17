# Roadmap

**MotionDiff is paused at version 1.0.** Nothing is in progress. This page
says what exists, what is known not to work well, and what would be worth
doing if work resumes.

## What exists

- **Six effects** built from eight modes: Highlight motion, Cut out the
  movers, Leave trails, Map speed & direction, Magnify the invisible, Reveal
  heat & air. Each is described in the [documentation](docs/index.md).
- **Sources**: a file, a video address, the camera, a mirror mode, and
  twelve samples. Two layouts (desktop and phone), light and dark.
- **Measurement**: a readings column, boxes that follow each mover,
  calibration to metres, a count line, export of tracks (CSV) and readings
  (JSON), and recording to WebM.
- **Camera compensation** ("Steady camera") for a shaking or drifting camera.
- **Two experimental options** that load a neural network: naming the
  movers and estimating depth. Their status is in
  [records/model-options.md](records/model-options.md).
- **Tooling**: unit tests for the pure maths, shader parity probes, and
  filmstrip rendering through headless Chrome ([scripts/](scripts/README.md)).

Tested in Chrome on a desktop GPU and on a phone. Firefox and Safari are
untested. Naming, mirror mode and pinch zoom are confirmed working. Reveal
heat & air is confirmed on recorded clips only, not on a live camera.

## Known limits

- **Counting miscounts packed traffic.** On the *Motorway* sample a line
  across the near carriageway gave 18 crossings one way and 2 the other in
  nine seconds, on a road where nothing travels the other way. Boxes over
  touching vehicles merge and split, and their centres jump across the line.
  Counts are right when movers stay apart.
- **Counting has no way in on a phone.** The count line is started with the
  X key or a link in the readings column, and the phone layout has neither.
- **Reveal heat & air on a live phone camera** has given a flat grey picture
  (nothing measurable). Not diagnosed.
- **Naming on a processor** (no usable graphics card) names about 2% of
  boxes; on a graphics card about a quarter.
- **Frame rates on phones have not been measured.**
- Per-effect limits are listed on each effect's documentation page.

## Ideas, if work resumes

- **A moving-camera view for footage shot while driving.** Driving forward
  makes the whole scene stream outwards from a point ahead. Estimate that
  pattern and remove it, so that only things with their own movement show
  (other vehicles, people crossing). From the same estimate, show how fast
  things ahead are growing in the picture, which is how quickly they are
  being approached. *Steady camera* already fits a shift, zoom and rotation
  of the whole picture; this needs a fit that allows for depth.
- **Counting that survives crowding**: split a merged box by the direction
  its parts are moving, and count a mover once per pass of the line.
- **A count line and readings on a phone**: an on-screen control to draw
  the line, and the counts shown in the phone layout.
- **A frozen reference** ("difference from this moment"): everything that
  has changed since a chosen frame stays lit, however slowly it changed.
- **Several gaps at once**, so slow and fast movers both show at one
  setting.
- **Magnify, cleaner**: amplify each level of detail separately, so that a
  pulse shows without amplified edges and noise.
- **Plume speed for Reveal heat & air**, from a slice of the picture over
  time.
- **A real-time stabiliser** built on the camera compensation.
- **Model options**: the next steps are listed in
  [records/model-options.md](records/model-options.md).
- **Housekeeping**: `npm audit` reports advisories in the development
  tools (Vite, Vitest and their dependencies; none in the shipped app).
  Update them before new work.

## Records

Design notes, the log of what each change was expected to do and what was
measured, and the features that were removed are in
[records/](records/README.md).
