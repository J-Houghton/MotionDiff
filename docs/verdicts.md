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

### V3. Motion history mode — visual (new mode)
**What it is.** One feedback buffer holds, per pixel, the time since the motion mask
(V2) last fired there, as a share of the history length. Two views: *age* (a colour
gradient from new to old along each mover's path) and *direction* (hue from the
direction of travel, found from the slope of the age field, averaged over a
neighbourhood because the slope at a single pixel follows the shape of the object's
edge, not its heading).

**Expected effect, written before building:**
- *Age view on `truth`:* behind each object a band along its path, new colour at the
  object, old colour at the tail, changing steadily in between, ending where the
  history length says. Static background black. Measured on the data output: age
  sampled along the known path rises monotonically with distance behind the object.
- *Direction view on `truth`:* the square's trail is one hue and the disc's another;
  the hue matches the known heading (0° and 30°) within about 20°, measured as the
  mean direction over each trail. In the second half of the clip the disc heading
  left (180°) has the opposite hue to the square.
- *Against Posy and Raw with trails:* those show that something passed; this shows
  which way and how long ago, also for a single still frame.
- *On a real clip (`highway`):* traffic in the two directions gets two different
  hues.
- *Known limits for the help text:* direction is the heading of the object's
  outline, so it is only reliable averaged over a patch; things that move back and
  forth (foliage) give mixed hues; a flat-coloured object's own footprint is uneven
  because only its edges register.
- No regression: other modes untouched.

**Result: accepted.**

Built as `app/modes/history.js` on `core/history.js` (11 unit tests); shader parity
`__motionDiffHistoryParity()`: age exact, pooled heading within 0.0005. WebGL with
float render targets only; elsewhere the mode reports that it cannot run.

| Check | Clip | Result |
|---|---|---|
| Direction within about 20° | truth | Known headings 0°, 30°, 180°: measured **0°, 31.7°, 177°** (mean over each trail, `scripts/truth-check.mjs`) |
| Age rises steadily along the path | truth | Square, disc and second disc: age (median across the trail) rises at every sample from the object to the tail, 0.33 → 1.0 |
| Blind judge, age view | truth, traffic | "Orange end is now, purple is the middle, blue is oldest. Age is the easiest to read of the four"; bands "change steadily from head to tail, with no stripes along the length" |
| Blind judge, direction view | truth, traffic | Opposite movers: "square red, disc cyan"; traffic: told the carriageways apart "immediately. The near side is green to yellow-green... The far side is magenta/pink" |
| Shows something Posy and Raw don't | all | Named by the judge: "the only one giving direction per object in a single cell"; with Posy and Raw trails heading is "by inference" and age "barely readable" |
| Grouping | all | All ten images assigned to the right four methods |

Changes made during the check:
- The pre-blur leaves a hairline on a flat object's trailing edge. In the mask that
  is harmless; integrated over time it reset the history in stripes. History now
  uses a stricter clean-up vote (seven of nine, `MASK_VOTES_STRICT`).
- The averaging patch for direction grew from 24 px to 56 px (and became a cheaper
  two-step sum): at 24 px the 44 px disc trail showed two hues, one per side.
- The reference clip for direction became `traffic` (fixed camera). On `highway` the
  camera pans, so everything has a heading and the picture is confetti.

Defects the judge found, all left as they are and listed in the mode's help:
- Hue drifts across a band wider than the patch.
- A hatched patch at the very tail of the disc's trail: leftover specks of the
  hairline that survive the stricter vote on a curved edge.
- Where the square restarts after standing still, its band has a seam: for a second
  the place it stood counts as moving (the mask's second gap still sees it there).

### V4. Background model mode — visual (new mode)
**What it is.** Per pixel, a running mean and variance of what is usually there. A
pixel is foreground when it differs from the mean by more than the threshold and
more than 2.5 standard deviations. The model learns with a time constant set by
"Absorb after", but not where the motion mask (V2) fired within the last half
second: moving things neither blur into the background nor inflate its variance.

**Expected effect, written before building:**
- *Filled silhouette, on `truth` while the square moves:* the whole square is marked
  (most of its outline covered), where Raw marks two strips at its edges and the
  motion mask one.
- *Stopped object, on `truth` (the square stops at 3.5 s), with "Absorb after" 2 s:*
  still fully marked half a second after stopping; gone by 3 s after. Raw and the
  motion mask lose it the moment it stops.
- *No permanent ghost:* when the square moves on at 8.5 s, the place it stood shows
  as foreground at first (the model had learnt the square there) and is gone again
  by 3 s later.
- *On real footage (`traffic`):* cars as filled shapes in their own colours.
- *Known limits for the help text:* whatever is in the picture when the model starts
  is taken for background and leaves a ghost for one absorb time when it moves; a
  slow, flat-coloured object is partly absorbed and leaves a fading trail; a change
  of lighting or exposure marks everything until it is absorbed; a moving camera
  marks everything.
- No regression: other modes untouched.

**Result: accepted.**

Built as `app/modes/background.js` on `core/background.js` (12 unit tests); shader
parity `__motionDiffBackgroundParity()`: 22 of 39,936 decisions differ (0.06%: the
GPU keeps the model in half floats, so a pixel exactly on the threshold can fall the
other way), strength within 1/255, and the test object is absorbed on both sides.
WebGL with float render targets only; elsewhere the mode reports that it cannot run.

All checks with "Absorb after" at 2 s, on `truth` (`scripts/truth-check.mjs`):

| Check | When | Result |
|---|---|---|
| Filled silhouette | square moving (3.0 s) | **100%** of the square's and the disc's outline marked, nothing elsewhere. Raw marks 32% of the square and 47% of the disc (two strips), the motion mask 34% and 50% (one) |
| Stopped object is kept… | 0.5 s and 1.5 s after it stops | 100% marked |
| …and absorbed in roughly the set time | 2.0 s after | 21% left |
| | 2.5 s after | 0% |
| The place it stood, after it moves on | 0.5 s to 2.0 s after | ghost, 100% marked |
| No permanent ghost | 2.5 s after | 11% left |
| | 3.0 s after | 0% |

| Blind judge | Clip | Result |
|---|---|---|
| Filled where differencing gives an outline | truth | "One whole filled white square, drawn once, at its true position"; Raw and Posy: "two vertical bars... parts only"; the mask: "one bright white leading strip" |
| Stopped object | truth | Visible in the three moments after stopping, "gone in 5 and 6"; in Raw, Posy and the mask "not visible in any of moments 2 to 6" |
| Ghost | truth | A block of bare background at the vacated place for about three moments; "in moment 6 nothing remains" |
| Real footage | traffic | "Whole filled blobs in their own colours... the most complete image" |
| Shows something Posy and Raw don't | all | "The only method giving whole filled shapes in true colour, the only one that shows a stopped object... and the only one without doubling" |
| Grouping | all | All ten images assigned to the right four methods |

Changes made during the check:
- The time constant went from half to a third of "Absorb after": with a half, the
  stopped square took 2.3 to 3.0 s to go at a setting of 2 s.
- Learning is gated by plain two-frame motion, not by the three-frame mask. For
  gating, the place an object has just left should count as moving too, but only for
  one gap; the mask's second gap kept it frozen a second longer for no benefit. The
  mode has no "Second gap" control as a result.

Defects the judge found, left as they are and listed in the mode's help: the ghost
itself (inherent: the model had learnt the object); ragged edges while something is
being absorbed (pixels cross the threshold one by one); on `traffic`, soft blobby
edges and faint patches on the road beside the cars (their shadows and reflections
are not background either).
