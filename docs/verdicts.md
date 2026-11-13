# Verdicts

The log the acceptance rules in `CLAUDE.md` ask for. Every change is tagged
**visual**, **performance** or **robustness**. For a visual change the expectation
is written here *before* it is built; the result is filled in after a blind judge
(a fresh subagent given two unlabeled filmstrips in random order) has looked.

Filmstrips are rendered with `npm run filmstrip` on the reference clips
(`scripts/README.md`) and kept in `filmstrips/` (not tracked in git).

---

## Session 3

### V1. Colour-by-age: a "mixed" look from the feedback buffer — visual
**Background.** Replacing the 20-frame trail ring with one feedback buffer
(`a0d84f9`) changed colour-by-age: a pixel that keeps moving stayed the "new"
colour, where the ring mixed new and old channels into purple. The owner wants
both looks, selectable, with the old one rebuilt from the feedback buffer if possible.

**Why the ring looked mixed.** It took, per colour channel, the maximum over the
window of `colour(age) × strength`. With the default red-to-blue gradient the red
channel is won by the newest motion and the blue channel by the oldest motion still
in the window. Two ages are enough to reproduce that: time since the last motion
(already kept) and time since the current burst of motion began.

**Expected effect, written before building:**
- *Mixed vs the ring (reference: commit `0c5f36c`, the last with the ring), on
  `trees`:* hard to tell apart. Where branches move continuously both read
  magenta/purple; edges that only just started moving read red-orange; places where
  motion has stopped read blue.
- *Mixed vs latest-only, on `trees`:* clearly different. Latest-only is mostly
  red-orange with blue only at trailing edges; mixed has broad purple/magenta areas.
- *On `truth`:* behind the moving square both styles show a gradient from the new
  colour at the square to the old colour at the tail; mixed is slightly bluer.
  Static background stays black in every style.
- No regression: Posy and Raw trails without colour-by-age are untouched.

**Result: accepted, with a known difference from the ring.**

What was built: `ageColorStyle` on Posy, `mixed` (default) or `latest`. Mixed adds
two values per pixel to the trail state: the age of the current burst of motion and
the burst's typical strength (`core/trails.js`). The old colour is drawn at
`TRAIL_OLD_PEAK_SHARE` of the strongest recent frame plus the rest of the typical
strength. Shader parity 1/255 for both styles; the Canvas2D fallback uses the same
core function.

| Check | Clips | Judge (blind, unlabeled, random order) | Numeric guard |
|---|---|---|---|
| Mixed vs latest: visible | trees, river, truth | Told apart at a glance on all three; grouped all six images correctly | 52% / 26% / 6% of pixels differ by more than 4/255 |
| Mixed vs latest: intended | truth | Described both rules unprompted: "only the most recent motion counts" against "new and old colours superimposed... magenta where both edges have swept" | |
| No regression | all | No motion missing in either style, no flicker, no banding; static background black on `truth` | Flicker in static areas: mixed 2.2 / 1.0 / 0.9, latest 2.7 / 1.1 / 1.1 |
| Mixed vs the old ring | trees, river | Three rounds, each a fresh judge: "yes with a caveat" every time (below) | Mean colour within 2% on blue, 6% on red; flicker 2.2 vs 2.6 (trees), 1.0 vs 1.1 (river) |

The three rounds against the ring:
1. *Burst age only, old colour at the strongest frame's brightness.* Same shape,
   coverage and stability; too magenta and brighter. Cause: the ring tints each past
   frame by that frame's own strength; one strong frame was being painted as if the
   motion had been that strong all along.
2. *Old colour at the burst's typical strength.* Overcorrected: pinker, less blue.
3. *A quarter of the strongest, three quarters typical* (chosen by matching the mean
   colour of the ring strips). River: "same look", the shift "only just visible".
   Trees: "same look with a noticeable shift": the ring keeps clear orange where
   motion has just restarted, the feedback version turns most of it pink.

**The known difference.** A burst only ends when a pixel's trail has fully expired.
In the ring an old frame drops out on its own after one window, so a pixel that
paused briefly and moved again goes back to orange; here it keeps some blue and
reads pink. Closing that gap needs either a third per-pixel value (when the current
unbroken run began) with gap detection, or a budgeted ring of past diff frames
(about 22 MB at 640x360 for 24 frames, and one more shader). Neither was built: the
judge calls it the same look, and the owner's instruction was to use a ring only if
the judge says it does not match.

Filmstrips: `filmstrips/ring-*-mixed.png` (the old ring look, from `0c5f36c`),
`filmstrips/age-*-mixed.png`, `filmstrips/age-*-latest.png`.

Also in this change (tooling, no visual effect): the filmstrip tool steps synthetic
scenes directly (`scripts/page/scene.js`), because browser-recorded WebM cannot be
seeked frame-accurately; the numeric guard reports mean colour.

### V2. Motion mask mode — visual (new mode)
**What it is.** Causal three-frame differencing: a pixel is moving when the current
frame differs from an earlier frame (the gap) *and* from a second, older one (the
second gap) by more than the threshold: `min(|cur − old1|, |cur − old2|) ≥ T`. The
frames are box-blurred before differencing and the mask is cleaned with a 3×3
majority vote. The picture is either the moving object cut out in its own colours
on black, or a solid mask; the data output is the mask.

**Expected effect, written before building:**
- *Against Raw at the same gap and threshold, on `truth`:* Raw draws every mover
  twice, at its current position and at the position it had one gap ago. The mask
  draws it once, at its current position. Measured against the known positions:
  nearly all mask pixels lie inside the objects' current outlines and almost none
  inside the outlines of one gap ago (outside the current ones). A uniform object
  shows as its leading part, not filled: differencing cannot see inside a flat
  colour.
- *On `truth-noisy` at the same threshold:* Raw is covered in speckle; the mask has
  visibly less (two independent differences must both exceed the threshold, and
  the blur and the vote remove what is left), while the objects are still marked.
- *On a real clip (`highway`):* vehicles appear once, in their own colours, where
  Raw shows a doubled outline.
- *Known limits to state in the help text:* an object must move by more than its own
  width between the two gaps or part of its ghost survives; a stopped object
  disappears; the cut-out of a uniform object is only its leading edge.
- No regression: Posy, Raw and Magnify are untouched (parity probes unchanged).

**Result: accepted.**

Built as `app/modes/mask.js` on `core/mask.js` (13 unit tests); the shader matches
the core exactly (`__motionDiffMaskParity()`: 0 mask mismatches, picture identical,
in all four blur / clean-up combinations). WebGL only; the fallback reports that.

| Check | Clip | Result |
|---|---|---|
| Current position only | truth | Known positions (`scripts/truth-check.mjs`): **100%** of mask pixels inside the objects' current outlines, **0%** in the outlines of one gap ago, 0 elsewhere. Raw at the same gap and threshold: 56% current, 44% ghost |
| Fewer speckles than Raw | truth-noisy | Mask: **0** marked pixels outside the objects. Raw: 15.4% of the still background marked (88% of all its marks) |
| Blind judge, three unlabeled methods per clip | truth, truth-noisy, highway | Grouped all nine images correctly. Mask: "drawn once, at the current position only... no copy behind"; Raw and Posy: "two copies". Noisy: mask background "pure black", the others "fine grain across the whole frame" |
| Shows something Posy and Raw don't | all | Named by the judge: current position only; the object's true colour; noise-free background; solid, bright vehicles on the highway |
| Defects the judge found | highway | Blobby patches in the tree band and nibbled lane markings: that camera is not quite still, so the scenery itself is "moving", and the blur and vote turn its fine texture into blobs. No flicker on the synthetic clips |

Tuning during the check: the default second gap went from 20 to 30 (1 s). At 20 the
`truth` square happened to move exactly its own width between the two gaps, the
borderline case, and a hairline of ghost survived (4.6% of marks).

Not built: a per-frame automatic threshold from a noise model. Auto-configure (A)
already measures the noise floor and sets the threshold for this mode too; a
per-frame estimate needs a statistics pass on the GPU and is on the roadmap.
