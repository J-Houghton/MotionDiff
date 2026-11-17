# How changes are accepted

The rules every change to MotionDiff was accepted under. The results are in
the [verdict log](verdicts.md). They apply again if work resumes.

Every change is tagged **visual**, **performance** or **robustness**.

- **Performance** is accepted on measured numbers: before and after, same
  machine, interleaved runs.
- **Robustness** is accepted on a demonstration of the case that broke before
  and works now.
- Unit tests stay for logic the eye cannot check.

## Visual changes

Visual changes are judged blind, so that nobody who built the change decides
whether it worked.

1. Before building, write down the expected effect and the reference clip that
   should show it, in the [verdict log](verdicts.md).
2. Render before and after filmstrips (several frames in a row from fixed
   moments) on the reference clips: `npm run filmstrip`
   ([scripts/README.md](../scripts/README.md)).
3. A reviewer who has not seen the work gets the two filmstrips unlabeled and
   in random order, plus the criteria.
4. **Visible:** the reviewer can tell them apart and describes the difference
   correctly. If not, the change has no visible effect: defer it and log it.
5. **Intended:** the difference matches what was written down beforehand.
6. **No regression** on the other clips: static areas stay at baseline, no new
   flicker, banding or clipping, no motion lost.
7. **Numeric guard:** if fewer than about 0.5% of pixels change by more than
   4/255, treat it as invisible whatever the reviewer says. Flicker in static
   areas must not rise.

## New modes

A new mode is also checked against synthetic clips whose motion is known
exactly (`scripts/truth-check.mjs`), and it must show something the existing
modes do not on at least one clip, as named by the blind reviewer. What the
mode should show, and on which clip, is written in the verdict log **before**
it is judged. The build steps are in
[Developing](../docs/technical/developing.md).

## Interface changes

Interface changes are judged from screenshots at desktop and phone sizes in
every state. `scripts/page/audit.js` measures the first four rules.

- The picture is the largest element: at least half the viewport in the Plate
  layout with 16:9 footage, all of it in the Viewfinder.
- Text contrast at least 4.5:1.
- Nothing overlapping or clipped.
- Focus visible; touch targets at least 44 px.
- Overlays hide when idle in the Viewfinder.
- A reviewer who has not seen the work critiques it against the design brief:
  distinct, not a generic dashboard.

## Clarifications made along the way

- Picture share in the Plate is measured with 16:9 footage; a wider clip gets
  slightly under half, which is the footage's shape and not the layout.
- In the Viewfinder a clip that would lose more than half its picture to
  cropping (landscape footage on an upright phone) is shown whole; a double
  tap switches to filling.
- "Age rises steadily along a path" is measured on the median across the
  trail, not on single pixels.
- A synthetic scene rendered after a real-clip scene in the same filmstrip
  run can differ slightly from the same scene rendered alone: compare strips
  rendered by runs with the same scene order (found under V-6C).
