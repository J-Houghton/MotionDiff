# Data out (session 7 design note)

Tracking and calibration exist, but the numbers stay on screen. This piece
lets them leave: export what was measured, and count movers crossing a line
the user draws. Everything sits beside the pipeline — nothing in the render
path changes.

## What it is

**Collect and export.** A *Collect data* toggle in the panel's Export folder.
While it is on, every processed frame appends:
- one **readings row** — media time plus the frame's `pipeline.readings`
  summary (peak, share, heading, rose, speed bins, camera; schlieren's setup
  numbers in that mode; the crossing counts below), and
- one **track row per tracked box** — `t, id, cx, cy, w, h, vx, vy, speed`,
  plus `speed_mps` when a calibration is set.

Two export buttons write files the way the WebM exporter does (a Blob and a
click): **tracks as CSV** (one row per box per frame) and **readings as
JSON** (a meta header — clip size, params snapshot, calibration, app
version — and the per-frame rows). Collection is capped at 100,000 track
rows (about 10 minutes of a busy scene); the status line says when it is
full. A new source clears the log.

**The count line.** Press **X** (or the margin link beside the counts) and
click twice to draw a line across the picture, the same two-click
interaction and SVG picture-space overlay as calibration. From then on,
every born track whose centre steps across the segment is counted, by
direction: the step from the track's previous centre to its current one is
intersected with the drawn segment (proper segment–segment intersection, so
movers passing beyond the line's ends do not count). Each track id counts
once per actual crossing; crossing back counts the other way. The two
cumulative counts live in the readings margin as an instrument row
(⟶ and ⟵ along the line's own normal), reset when the line is redrawn or
cleared (X, then Escape), and ride along in both exports; the JSON also
carries the event list (`t, id, dir`).

## Where it lives

- `core/dataout.js` — pure, unit-tested: the segment-crossing test, the
  per-id counter state machine, the CSV and JSON serialisers.
- `app/session.js` — owns the log and the counter (interface state lives in
  the session); steps them per processed frame from `pipeline.readings`.
- `ui/countline.js` — draws and edits the line (calibrate.js's pattern);
  `ui/readings.js` gains the counts row with the "Count line (X)" link
  (the calibration discoverability lesson: the key alone is not an entry);
  `ui/panel.js` gains the three Export-folder controls.

Counting needs boxes, so the counts row appears in the mask and background
modes with *Movers: boxed & numbered* on; the margin link turns it on the
way the Movers pill does. Collection works in every mode (readings rows
only, where no boxes exist).

## What it will and will not do (help text)

- Counts are of tracked boxes: merged clumps count as one (the V-6T limit),
  and a track that dies before reaching the line never counts.
- The line lives in picture coordinates: it survives layout changes, but a
  new source clears line and counts (a different camera, a different scene).
- Speeds in the CSV are the tracker's smoothed values, picture px/s;
  `speed_mps` is true at the calibrated depth only, as calibration is.

## Acceptance (D-1, registered before building)

Numbers first, in the manner of V-6T; this is data, not a look, so the
judge is arithmetic and the interface audit, not a blind strip pair.

1. **Unit tests** (core/dataout.js): a step across the segment counts once,
   with the right direction from the line's orientation; a step crossing
   the infinite line beyond either end counts nothing; a track that crosses
   and returns counts one each way; a track id seen for the first time
   already past the line counts nothing; CSV and JSON round-trip their
   rows (parse → same numbers), and `speed_mps` appears exactly when a
   scale is given.
2. **Known truth** (`truth` clip, headless, normal playback, mask mode,
   maskTrack on, a vertical line from (320, 0) to (320, 360)): the square
   crosses left→right near t = 2.1 s and the first disc near t = 2.9 s;
   the second disc crosses right→left near t = 9.4 s. Expected: counts
   exactly 2 and 1, each event within 0.4 s of those times, and nothing
   counted from the noise background or while the square stands still.
3. **Export, same run with calibration set to 0.1 m/px** (the V-6K scale):
   the tracks CSV parses; the square's speed column reads within 20% of
   120 px/s while it moves, and `speed_mps` within 20% of 12; the readings
   JSON's frames carry monotonic t, cumulative counts that match the event
   list, and the meta carries the calibration and the version stamp.
4. **Interface**: the audit stays clean with the line overlay up and the
   counts row showing (the V-6K rule for SVG overlays); the counts row
   appears only when a line is set in a tracking mode.
5. **No regression**: with no line drawn and collection off, one guard
   scene (truth-mask) is byte-identical to master — the feature is beside
   the pipeline, not in it.
