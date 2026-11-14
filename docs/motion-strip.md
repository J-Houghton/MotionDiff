# Motion-over-time strip: design note

Status: **designed** (session 5, Session A); not yet built. Roadmap: "A
motion-over-time strip from the pooled grid."

## What it is
A narrow strip along the time axis, under the scrub bar, showing how much motion
the picture carried at each recent moment: the seek bar learns where the action is.
The source is the pooled magnitude grid every mode already publishes
(`core/magnitude.js`, read back as `pipeline.getEnergyGrid` — the sonification's
feed), so the strip works in every mode and adds no new measurement.

## What the picture means (fixed before building)
| Part | Is it a measurement? |
|---|---|
| A column's **brightness** | Yes: the mean pooled magnitude of that moment's frame, 0..1 against the active mode's own scale |
| A column's **vertical profile** | Yes: the row-pooled magnitudes top-to-bottom — motion high in the picture draws high in the strip |
| The **x axis** | Media time, newest at the right, over the visible window (the clip's length when seekable, else the last 30 s) |
| Colour | Not a measurement: the theme's ink at varying strength |

A column is written when its moment is processed: scrubbing fills what it crosses,
and a paused video adds nothing (repeat frames are not re-measured). Gaps the
playhead never visited stay empty rather than interpolated — an empty place means
"not measured", exactly as elsewhere in the project.

## How it works
- `ui/strip.js` owns a small canvas (CSS-sized, device-pixel backed). Per processed
  frame the shell's session listener asks `pipeline.getEnergyGrid(1, rows)` (one
  column, a handful of rows — the readback already exists and is tiny), stamps it
  with the frame's media time, and paints that column.
- Seekable sources map time → x directly; live sources scroll.
- Clicking or dragging the strip seeks, like the scrub bar; it sits directly under
  the scrub so the two read as one instrument. Phone: same strip, 44 px touch rule
  on the hit area.
- State clears when the source changes. No core/ or app/modes changes; one small
  read in the shell, everything else in ui/.

## Acceptance (verdict VA4, expectation before building)
- On `truth` (the square stops from 3.5 s to 8.5 s): after one playthrough the strip
  shows bright at both ends and a visibly dimmer middle — a blind judge, told only
  "this shows motion over time", points at the quiet spell within about a second.
- On `traffic`, the strip is continuously bright; on `sunset` (slow drift) it is
  faint but not empty.
- The vertical profile: on `truth` before 3.5 s the square's row band and the discs'
  are distinguishable as separate bright rows in the strip.
- Interface rules: contrast, no overlap, 44 px touch targets, audit at both sizes.
