# Verdicts

The log the acceptance rules in [development.md](development.md#how-changes-are-accepted) ask for. Every change is tagged
**visual**, **performance** or **robustness**. For a visual change the expectation
is written here *before* it is built; the result is filled in after a blind judge
(a reviewer that has not seen the work, here a fresh AI agent, given two unlabeled
filmstrips in random order) has looked.

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

### I1. Interface — judged from screenshots
Rules from [development.md](development.md#how-changes-are-accepted). Measured by `scripts/page/audit.js` on 23 states (desktop
1440×900 and 1280×720, light and dark, every mode family, split, empty, keys sheet;
fullscreen, awake and idle; phone 390×844 with a clip, with the fake camera, with
the parameter sheet, the source sheet, empty and idle; tablet 820×1180), then by a
fresh critic given the screenshots and the brief.

| Rule | Measured | Critic |
|---|---|---|
| Picture is the largest element | Plate 51–54% of the viewport with 16:9 footage (49% with a 1366×720 clip); Viewfinder 100% | Pass, "thin margin in Plate" |
| Text contrast at least 4.5:1 | Lowest 5.6 (light), 7.0 (dark), 10.7 (Viewfinder) | Pass |
| Nothing overlapping or clipped | None in any state | Pass, bar a half-cut row at the foot of the phone sheet (since anchored to the edge) |
| Focus visible | 2 px accent outline on every stop of the tab order | — |
| Touch targets at least 44 px | None smaller on phone or tablet (a slider's target is its 44 px row) | Pass for buttons, "borderline" for slider thumbs (since widened) |
| Overlays hide when idle in the Viewfinder | `data-idle` true after 2.5 s of playback, all chrome at opacity 0 | Pass, "cleanly" |
| Distinct, not a generic dashboard | — | Pass: "neither layout looks like a component-library dashboard"; "the dark theme is a navy blueprint grid with a coral accent, not an inversion" |

The first critique (before the fixes in `d524b4c`) failed the phone layout: solid bars
top and bottom made it "a conventional player", and slider thumbs, mode arrows and
the scrub handle were too small. The second passed all seven. Its remaining points:
the two layouts share little beyond type and square corners (roadmap item 12), and a
landscape clip on an upright phone was cropped to a quarter (now shown whole).

### Robustness — accepted on a demonstration of the case that broke
| Change | The case | Before | After |
|---|---|---|---|
| Stale frame-callback time after a paused seek | Step or scrub while paused | The callback could deliver the previous frame's time; it read as a rewind and wiped the history | Metadata more than 0.25 s from `currentTime` is ignored; history survives (filmstrip stepping depends on it) |
| Timer firing in the middle of a seek | Scrub while paused | A frame processed mid-seek with the old picture and the new time | Skipped while `video.seeking` |
| Frame driver | A browser that stops delivering frame callbacks | Processing stopped | Falls back to the display clock after 120 ms without one, counted by decoded frames |
| Modes that cannot run | `?renderer=canvas2d`; `?nofloat` | — (new modes) | Mask, history and background say "needs WebGL2"; history, background and magnify say "needs float render targets"; the mask still runs without float |
| Target creation order | First frame of a mode with its own targets | The data target's first frame was drawn from the wrong texture (mask probe: 234 mismatches in the first case, none after) | Targets are requested before textures are bound |

### Performance — accepted on measured numbers
Per-frame cost during playback of `traffic` (1920×1080, 30 fps), one pixel read back
after each frame to make the GPU finish; median of about 75 frames; one machine
(Windows, Intel GPU, headless Chrome), modes measured in turn in the same run.

| Mode | 640×360 | 1920×1080 | Frames per second |
|---|---|---|---|
| Posy | 3.6 ms | 6.1 ms | 30 |
| Raw | 4.5 ms | 6.1 ms | 30 |
| Magnify | 5.1 ms | 6.3 ms | 30 |
| Motion mask | 4.2 ms | 9.8 ms | 30 |
| Motion history | 4.2 ms | 10.9 ms | 30 |
| Background model | 4.5 ms | 12.8 ms | 30 |

Every mode keeps the source's frame rate at both sizes. No before/after here: the new
modes have no earlier version, and the session's other changes were not made for
speed. The comparison against master is in the session 2 report (1080p: about 53 ms
to 12.5 ms a frame; JS heap 851 MB to 6 MB).

### Deferred for having no visible effect
Nothing built this session was dropped by the "no visible effect" rule: every visual
change was told apart by its judge. Deferred before building, for the same reason
(see `ROADMAP.md`): the luma-only branch.

---

## Session 4

Two ideas from the owner: wind-map particles as a display for motion, and schlieren
(making hot air visible). Both stand on dense optical flow, so that is built first.
Research in `research.md` §6 and §7; designs in `optical-flow.md`, `particles.md`
and `schlieren.md`.

### V5. Optical flow mode — visual (new mode)
**What it is.** Between two frames one gap apart, how far and which way each small
patch of the picture moved: pyramidal Lucas–Kanade on luma (`core/flow.js`), with a
confidence beside every vector. Shown as colour (hue = heading, brightness = speed)
or as particle traces (V6).

**Expected effect, written before building** (the numbers are those set in advance
in `optical-flow.md`, checked on a new synthetic scene `flow` with textured movers,
because the flat objects of `truth` carry flow only at their rims):
- *Heading, on `flow`:* within 10° of the truth, as the mean over each mover: a
  band sliding right (0°), a block sliding down-left (135°), and around a turning
  disc the heading at each point square to its radius. From one frame pair; no trail
  is needed, unlike motion history.
- *Speed, on `flow`:* within 20% of the truth (band 90 px/s, block 60 px/s, the
  disc's rim 75 px/s falling to zero at its centre).
- *Still background:* speed under 5 px/s over 99% of it; with the heavy noise of
  `truth-noisy`, over 95%.
- *Flat areas:* the inside of a flat object (`truth`'s square) reads as "nothing
  measured" (dark), not as noise. Its rim carries the flow.
- *On real footage:* `traffic` shows the two carriageways in two opposite hues;
  `river` one dominant hue along the water's course.
- *Blind judge* names what it shows that motion history does not: speed, and a
  heading without waiting for a trail.
- *Known limits for the help text:* nothing is measured where the picture is flat;
  along a straight edge only the motion across the edge is seen; motion of more than
  about a twentieth of the picture width per gap is beyond its reach and comes out
  wrong, so fast things need a short gap; a moving camera colours everything.
- No regression: other modes untouched.

**Result: accepted.**

Built as `core/flow.js` (22 unit tests), its shader mirror `app/flow.js` and the mode
`app/modes/flow.js`. Parity `__motionDiffFlowParity()`: largest difference between
core and GPU vectors 0.033 px, no trusted vector more than 0.05 px apart, at two sizes,
one of which does not halve evenly. WebGL with float targets only.

On `flow`, from the data output (`scripts/truth-check.mjs --flow 1`), gap 67 ms:

| Mover | Heading error (mean) | Within 10° | Speed measured / known | Within 20% |
|---|---|---|---|---|
| Band, right at 90 px/s | 1.1° | 99.9% | 87.9 / 90 | 96.6% |
| Block, down-left at 60 px/s | 3.3° | 95.4% | 59.1 / 60 | 96.2% |
| Disc, outer part | 2.8° | 97.5% | 55.9 / 55.6 | 98.8% |
| Disc, inner part | 3.3° | 95.9% | 34.2 / 34.2 | 98.6% |

| Still background under 5 px/s | Result | Target |
|---|---|---|
| `flow` | 99.35% | 99% |
| `truth` | 99.32% | 99% |
| `truth-noisy` | 98.77% | 95% |

| Other checks | Result |
|---|---|
| Flat areas | On `truth` the inside of the square and the centre of the disc are dark; flow shows at the square's corners and the disc's rim, in the right hues (my own reading of the strip, not a judge's) |
| Real footage, `traffic` | Two carriageways in opposed hues: the judge read "right-lane cars go down to down-right… the far carriageway goes up-right" from one moment |
| Real footage, `river` | **Not as expected.** The clip's camera moves forward, which no earlier mode had revealed: the flow fans out from the upper centre, and the judge named it "an expansion pattern: the camera moving forward (or zooming in)". True to the footage; the expectation of one hue along the water was wrong |
| Shows what motion history does not | Speed: "T-m is clearest. Strokes lengthen steadily towards the near car… T-q [history] barely shows it". A heading without a trail was checked by the numbers above only (two frames 67 ms apart, averaged over 200 ms); a judge cannot see that in stills |

Changes made during the check:
- Confidence gained two factors beyond texture. Without the test for "nothing moved",
  9% of the still background within 40 px of a mover read as moving (the coarse sizes
  smear motion outwards); with it, 0.65%.
- Smoothing weights by confidence without shrinking the vectors: the first version read
  speeds 8% to 14% low.
- The mode has its own Gap (67 ms), not the shared one.

Defects left as they are: ragged outlines on movers (the judge: "ragged square edges
with a few stray dots"); faint traces over an empty stretch of road at the bottom of
`traffic` in the first moments (not traced to a cause); nothing measured along the
middle of a straight edge.

### V6. Particle traces — visual (new display)
**What it is.** A wind-map display for a velocity field: a few thousand particles,
each carried along by the measured flow for a second or two and drawing its path.
Stepped on media time in plain JavaScript (`core/particles.js`), drawn as lines on
the GPU with a fading trail. Used by the optical flow mode and by schlieren (V7).

**What the picture means, fixed before building.** Each trace is the path a point of
the picture followed while the particle lived; its direction and (at gain 1) its
length are the measured movement. Where traces start is random, and how many there
are in a place is not a measurement: particles that land where nothing is measured
are re-seeded at once, so traces gather on whatever moves.

**Expected effect:**
- *On `flow`:* straight level traces along the band, slanted ones on the block,
  arcs around the disc's centre that are longer towards its rim; under 2% of all
  trace brightness on the still background.
- *Direction readable from one still frame:* with heading colours, the band, block
  and the two sides of the disc are in visibly different hues; without colour, a
  judge can still say which way each region moves from the traces' bright heads.
- *Length means speed:* on the disc, traces near the rim are about three times as
  long as those a third of the way out.
- *The same at any frame rate:* `sixty` (60 fps) gives traces as long as the same
  motion at 30 fps.
- *On real footage:* `river` reads as streams along the current; `traffic` as two
  opposed streams; `trees` as short traces that swing back and forth. A judge shown
  one frame of each of Raw, motion history and particles says the particles show
  direction and speed at a glance and names the picture as the pleasantest to watch,
  or the display has not earned its place.
- *Known limits for the help text:* the density of traces is not a measurement; a
  flat surface carries no traces even when it moves; at gain above 1 the lengths are
  exaggerated; traces are drawn at the processing size, so they are soft when shown
  large.
- **Performance** (its own tag): the flow passes, the readback of the field and the
  particle step measured per frame on this machine, on both a desktop and a throttled
  phone profile; the target is 30 frames a second at the phone's 480 px processing
  width. A real phone cannot be measured here and will be reported as such.

**Result: accepted, with one part that failed and is logged as such.**

Built as `core/particles.js` (11 unit tests; no shader copy) and `app/particles.js`.

| Check | Result |
|---|---|
| On `flow`, plain traces | Judge: band "horizontal streaks… rightward, moderately sure"; block "down and to the left, fairly sure"; disc "concentric arcs, so it is turning"; outside the regions "plain black" |
| Length means speed | Judge: "strokes near the rim are long and bright; towards the centre they get shorter and fainter". The 3:1 ratio was not measured on the picture; the step being exactly velocity × time is a unit test |
| Heading colours | Judge: band red, block green, a full hue wheel on the disc, which "resolves the disc as clockwise" |
| **Direction from a still without colour** | **Failed.** Two judges could give the line of travel but not which way along it for the disc, and only from comparing moments for the others. A tinted tail (white head, blue tail) was tried and a third judge still could not tell: removed again. The help text now says so. Heading colours are the default |
| The same at any frame rate | Unit test only (equal distance in equal media time at 30 and 60 steps a second). Not rendered on `sixty`, whose flat objects carry almost no flow |
| `traffic` | Judge ranked particles first of three (with Raw and motion history) for direction, for speed, and as "the pleasantest (delicate, and reads like motion)" |
| `trees` | Particles first "narrowly (refined, but too dark)". The floor on trace brightness was raised from 0.3 to 0.45 afterwards; not re-judged |
| `river` | The expansion pattern of V5; the judge also found the traces "heavily obscure the picture" in the glow display |
| Still background | 99.35% of it has no flow to carry a trace (V5); judges saw at most "a few faint isolated specks just outside the region borders" |

**Performance**, this machine (Intel integrated GPU, headless Chrome), median per frame
with one pixel read back, two interleaved rounds, `river` at 25 fps:

| | 480 px | 640 px | 1280 px |
|---|---|---|---|
| Raw (for scale) | 3.1 ms | 3.0–4.0 | 4.0–4.5 |
| Optical flow, colour | 3.8–6.5 | 4.0–4.6 | 4.7–5.5 |
| Optical flow, particles | 5.2–5.6 | 5.8–7.2 | 8.2–9.8 |

The particle step alone: 0.32 ms for 3,240 particles (480 px), 0.50 ms for 5,760
(640 px), 1.7 ms for 20,000. All frames were kept at every size. **A real phone was
not measured.**

### V7. Schlieren mode — visual (new mode)
**What it is.** Background-oriented schlieren: hot air bends light, so a textured
background seen through it appears shifted by a fraction of a pixel. The mode
measures that shift for every patch (the Lucas–Kanade solve of V5, one or two sizes,
against a reference picture of the background) and draws it. The reference is a
running average of the scene; "Hold reference" freezes it, so that everything that
changes afterwards is shown in full.

**What the picture means, fixed before building.** The shift is proportional to the
change of air density across the line of sight, summed along it: the picture shows
*where the air is unevenly hot*, not how fast it moves. With a held reference it is
the whole deflection; with a running reference only the part that changes over time
(a steady, smooth plume fades out of it). Particle traces in this mode follow the
movement of the *pattern* of hot air from frame to frame: a measurement of how the
eddies travel, which is slower than the air itself and absent where the flow is
smooth. Nothing in the mode is simulated.

**Expected effect, written before building.** Real flames cannot be filmed here, so
these are set on a new synthetic scene, `plume`: a printed-style random background
warped by a known field (a smooth column over a source plus eddies rising at
150 px/s; peak shift 0.3 px), with sensor noise. `plume-weak` has a peak of 0.08 px,
`plume-wall` a natural texture with a plain strip, `plume-drift` a camera that
creeps by 0.4 px and trembles.
- *Invisible in the source, visible in the mode:* a judge shown the original frames
  of `plume` sees nothing rising; shown the schlieren strip, describes a column
  above the source with moving structure. Raw at any threshold shows at most
  speckle there (numeric guard: under 0.5% of pixels differ between two Raw frames
  of the scene by more than 4/255 above its noise).
- *The measurement is right, with a held reference:* over the plume, the measured
  shift correlates with the true one above 0.8 and its size is within 25%; outside
  the plume the picture is quiet: the noise floor is under a fifth of the plume's
  typical shift.
- *Weak plume (`plume-weak`):* still visible to the judge with smoothing and a larger
  window; if not, that is reported as the sensitivity limit, with the number.
- *Running reference:* the eddies show, the smooth column near the source does not;
  the judge's description must match that, since it is the stated meaning.
- *Plain background (`plume-wall`):* nothing is drawn on the plain strip, and the
  setup view marks it as unusable; the plume shows where texture exists.
- *Camera drift (`plume-drift`):* with the global-shift correction the still
  background stays quiet (noise floor within 1.5 times that of `plume`); without it
  the whole frame lights up.
- *Traces:* over the eddies they head upwards within 20° of the truth, and their
  speed is reported against the known 150 px/s whatever it turns out to be (the
  literature expects an underestimate); none on the still background (under 2% of
  trace brightness).
- *Guidance:* the status line names a setup problem when there is one: a background
  too plain to measure against, a camera that is moving, a reference not yet settled.
- *Known limits for the help text:* needs a still camera and a textured background
  well behind the hot air; shows nothing where the background is plain; a shift is
  not a speed; lamp flicker, auto-exposure and focus hunting all read as signal;
  video compression smooths away the smallest shifts.
- **Not verifiable here, and said so in the result:** a real plume, a real phone
  camera's noise and compression, and the frame rate on a real phone.
- **Performance** (its own tag): measured per frame at the phone's 480 px processing
  width and at 640 px.

**Result: accepted on the synthetic scenes and on one real recording; traces accepted
on the synthetic scene only; several things not verifiable here, listed at the end.**

Built as `core/schlieren.js` (10 unit tests) and `app/modes/schlieren.js`. Parity
`__motionDiffSchlierenParity()`: the mode's shift against the core's, largest
difference 0.017 px, none over 0.02 px. WebGL with float targets only.

Against the known field (`scripts/truth-check.mjs --schlieren 1`), reference held from
before the plume is lit, window 9 px, smoothing 33 ms unless said:

| Scene | Typical true shift | Correlation | Size measured / true | Noise beside the plume | Target |
|---|---|---|---|---|---|
| `plume` | 0.28 px | 0.98 | 0.91 | 0.011 px (4% of typical) | >0.8, within 25%, under 20% |
| `plume-weak` (window 13 px, smoothing 67 ms, sensitivity 0.08 px) | 0.076 px | 0.93 | 0.82 | 0.006 px (7%) | visible |
| `plume-wall`, textured part | 0.31 px | 0.91 | 0.82 | 0.047 px (15%) | drawn only where textured |
| `plume-drift`, shift cancelled | 0.27 px | 0.985 | 0.92 | 0.016 px (1.45× `plume`) | within 1.5× |
| `plume-drift`, not cancelled | 0.27 px | 0.86 | 0.91 | 0.18 px: the whole frame | lights up |

The first version of the scene used 100 ms of smoothing and read 30% low; the default
went to 33 ms (0.91) on that evidence.

| Blind judge | Result |
|---|---|
| Source of `plume` | "Fine black-and-white random speckle… Nothing visibly moving, rising or changing" |
| Raw on it | "Almost entirely black. A very faint, dim grey speckled vertical smudge… Easy to miss" |
| Held reference | "A strong vertical column… a white lobe on the left paired with a black lobe on the right… tapering to a point at the bottom" |
| Running reference | "Broken into separate oval blobs… the bottom (and the continuity of the middle) is shown by [held] and largely missing": the stated meaning |
| `plume-weak` | "Stands out very clearly (full white and full black against mid-grey)" |
| `plume-wall` | Nothing drawn on the plain part; the band "is cut off dead straight at the boundary, which matches the texture/flat edge in the source exactly"; the setup view hatches the flat part and "the smooth interiors of the blobs" |
| `plume-drift` | Uncorrected: "background is bright cream to white, and its overall level jumps"; corrected: "surround dark and steady in all six moments" |
| **Real footage, `candle-dots`** | Source: "fine-grained speckled surface… Nothing visibly moving or rising". Knife edge: "a thin, sharp white/black paired line starts at the bottom edge… rises leaning leftward, and widens into a streaky, wavy plume… The shape suggests a plume of hot air or smoke rising from a small source (candle, flame, soldering iron)". Raw: "at the limit of visibility" |
| Traces on `plume` | A wedge of strokes over the eddies and nowhere else; the judge could not tell up from down in a still (no colour key was given) |
| **Traces on `candle-dots`** | **"Effectively empty, stray red dots only."** |

Traces against the known eddies of `plume` (`--target 1`): mean heading 269.6° against
270°, every measured vector within 20°, speed 140 px/s against 150 (93%), measured over
92% of the eddy region, 0.07% of the still background moving. On the real candle
recording the eddy velocity is trusted over 2.6% of the frame and relaxing the solver
does not make it coherent: filmed close up at 30 frames a second the plume moves too
far between frames. **The traces view ships labelled experimental**, and following the
plume along a space-time slice (which the literature finds better at ordinary frame
rates) is on the roadmap.

Real footage, second recording (`candle-screen`, a candle in front of a monitor
showing a fine checkerboard): at 640 px **nothing is measured**, because the pattern
blurs to flat grey; the status line says the background is too plain. At 1280 px and
at 1920 px the plume from the flame is plain to see (my own reading, not a judge's),
over a mottled, noisy background: a fine regular pattern on a screen is a poor
background. The working size limit was raised from 640 to 1280 px because of it.

Guidance: the status line was seen reporting `69% measurable · shifts over 0.08 px show
· reference follows` on `candle-dots`; the "too plain", "camera moved" and "camera is
moving" messages follow thresholds that are unit-tested but were not each provoked in
the browser.

**Performance**, same method and machine as V6:

| | 480 px | 640 px | 1280 px |
|---|---|---|---|
| Schlieren, knife edge | 4.8–5.8 ms | 5.7–7.2 | 12.2–14.7 |
| Schlieren, traces | 8.2–9.0 | 9.0–10.5 | 17.3–18.6 |

Defects the judges found, left as they are: a grainy surround on real footage in the
Strength view (noise has a size, so it shows); cores of strong plumes clipped to full
white at the default sensitivity; a heavier background with a running reference than
with a held one. Fixed: bright dashes along the picture's edges (nothing is drawn now
where a patch overhangs the edge).

**Not verified, plainly:**
- A phone: its camera's noise and compression, the live workflow, the frame rate.
- The numeric guard on Raw for `plume` was not computed; the judge's "easy to miss"
  stands in for it.
- Hold reference on real footage: neither recording has a usable flow-free start.
- Weak real sources (a mug, a heater, a lighter's gas) and natural backgrounds in real
  footage.
- Whether shifts measured on real footage are the right size: there is no ground truth.

### I2. Interface with the two new modes — judged from screenshots
Ten states audited with `scripts/page/audit.js` at desktop and phone sizes (Optical
flow and Schlieren on the Plate in both themes, with glow, with the setup check and
with traces; both modes and their parameter sheets on the phone; the keys list): all
pass on picture share, contrast, clipping, overlap and touch targets. No new chrome was
added, so no fresh critique against the brief was run.

### Robustness — accepted on a demonstration of the case that broke
| Change | Before | After |
|---|---|---|
| A long status line | With schlieren's first, long note the page's single column grew wider than the window: the panel left the screen and the seek bar was off-screen in three audited states | `#app` declares its column as `minmax(0, 1fr)`; the same three states pass; the notes were shortened as well |

### Deferred for having no visible effect (session 4)
- **A head and tail of different colours on plain traces.** Built, judged, not visible
  as a direction: removed.

### I3. Samples that open in a mode — interface, and a check of each clip
Eight samples were added to the source picker, one or more for every mode except
Magnify (the face clip was tried and taken out at the owner's request; a replacement
that is not a face has not been found yet); each names its mode
on the button and selects it with fitting settings when loaded. The three older samples
keep whatever mode is current, as before.

| Sample | Mode | What its filmstrip showed (my own reading; no blind judge was run for these) |
|---|---|---|
| Flower Opening | Posy | Fine outlines of leaves and stems on grey, colour fringes on the opening flower |
| Bees at the Hive | Motion mask | Each bee cut out in its own colours on black; a few specks of wall beside the fliers |
| Gulls Overhead | Motion history | An orange-to-blue ribbon along each bird's path |
| Crossing from Above | Background model | Cars and pedestrians cut out whole, with their shadows |
| Motorway | Optical flow | Two opposed streams in two hues (V6) |
| Clouds over Peaks | Optical flow, over the video | Traces along the cloud front, none on the mountains or the plain |
| Weir | Optical flow | A stream across the foam at lower left; the smooth sheet of water on the right carries almost none (little texture) |
| Candle Plume | Schlieren | The plume of V7 |

All eleven samples (and the face clip, before it was removed) were loaded from their hosts in headless Chrome the way the picker
does it: each came up in its mode with a picture (first frame after 0.2 to 1.0 s here;
the 49 MB candle clip after 1.0 to 1.4 s). The picker passes the interface audit at
desktop and phone sizes. Rejected after rendering: the intersection in Optical flow
(dim, the vehicles move too far per frame). Not checked: loading on a phone or a slow
connection, and browsers other than Chrome (the candle clip is a QuickTime file).

---

## Session A (Display)

Session 5, display work: `src/ui/` and how results are drawn. Branch
`session-a-display`.

### IA1. On-screen button for split compare — interface
Split compare (the S key) gets a visible control: a Split button in the transport
on the Plate and in the fullscreen Viewfinder, and in the top action plate on
phones, where the transport row has no room for it. Active state by `aria-pressed`
and the accent fill; the split handle widened to 44 px on phones.

**Result:** audit passes with split on at desktop (1440×700: no overlap, no
clipping, min contrast 5.6) and phone (390×844, touch targets all ≥ 44 px,
min contrast 11.5). Screenshots in the tier's critique round.

### IA2. Direction legend — interface
A hue wheel in the picture's corner, shown while the current view colours by
heading (optical flow colour view and heading-coloured traces, motion history
direction, schlieren direction), so the colours read without the help sheet.
The wheel must match the shaders' hue(): right red, down yellow-green, left
cyan, up violet — arrows on the wheel say so. Hidden in the data display, when
nothing is loaded, and (like all chrome) when idle in the Viewfinder.

**Result:** built as `ui/legend.js` (a CSS conic gradient turned a quarter
turn so hue 0 sits at the right, matching `hue()` in the shaders; four arrow
glyphs in the wheel's hole). Audit passes in the states that show it: flow
colour on the Plate (min contrast 5.97, nothing clipped, overlapping or off
screen), history direction on the phone (11.46, touch targets unaffected —
the legend is not interactive). In the Viewfinder it sits under the meta
plate, clear of the brackets and the bottom bar, and yields to the open
panel. Screenshots in the tier's critique round.

### VA1. Traces keep flowing while the video is paused — visual
**What it is.** A paused frame holds the measured velocity field of that
instant; the particle traces keep being stepped through it on the wall clock,
so the still frame reads like a wind map of one moment.

**Expected effect, written before building:**
- *On `traffic`, optical flow with particle traces, paused:* two screenshots of
  the paused picture a second or two apart are visibly different: the traces
  have flowed on along the same streams (same two opposed directions, same
  regions). Today the two screenshots are identical.
- *The video frame itself does not change* while paused: the original under the
  traces (overlay display) is pixel-identical between the two moments.
- *The streams stay where the motion was:* no traces appear over the still
  background while paused (the frozen field is zero there).
- *Resume is clean:* stepping or playing on after a paused spell shows no seam,
  pile-up or flash; trails fade as they did before.
- *No regression:* with traces hidden (colour view) a paused frame is as still
  as today; other modes untouched; the feedback-state rules (recompute on
  repeat) still hold for trails, history and background.
- Applies to the optical flow mode's traces and schlieren's experimental traces.

**Result: accepted.**

Built as `mode.animates(params)` on flow (particles) and schlieren (traces), a
wall-clock redraw loop in `Session._syncPausedFlow` (about 30 redraws a
second, clamped after a backgrounded tab, idle while seeking), and a
`frame.pausedDt` that only the particle step consumes: the frame stays a
repeat, so trails, history, background and magnify advance by nothing.

| Check | Result |
|---|---|
| Blind judge, two pairs of paused screenshots 2 s apart, unlabeled (K = before from master, W = after; the judge was not told which or what changed) | Pair K "identical to the eye… byte-for-byte identical". Pair W "visibly different… the same live scene re-rendered a moment later — the streak/filament texture has advected or regenerated while the overall coloured regions stayed roughly in place" — the written expectation, in the judge's own words |
| The video frame does not move | `currentTime` identical at both captures (4.980238 s), element paused |
| Before and after, numerically | Before: the two captures have the same SHA-256. After: they differ |
| A mode that does not animate stays still | Posy, paused, same build: both captures one SHA-256 |
| No regression while playing | Focused filmstrips (flow colour, flow particles both colourings, traffic particles, plume traces, dots traces) rendered on master and on this change: numeric guard below |

Regression guard (`npm run filmstrip compare`, before = master): **all six
strips byte-identical** — flow colour, flow particles (heading and plain),
traffic particles, plume traces, dots traces: 0% of pixels changed, flicker
and mean colour equal to the last digit.

One thing the guard caught: the first after-render of `traffic-particles`
differed by 7.8%, because the new wall-clock loop also ran between the
filmstrip tool's paused steps and advanced the traces nondeterministically.
`Session.pausedFlow` (public, default true) now lets tooling turn the
feature off, and `scripts/page/render.js` does so before stepping; the
re-render matched master exactly. Live behaviour is unchanged by the switch.

### VA2. Arrow grid for flow — visual
**What it is.** A third display for the optical flow mode: a sparse regular
grid of arrows over the picture, each showing the measured heading, with
length proportional to speed (at the set speed range), hidden where confidence
is low or nothing is measured. Reverses the roadmap's deferral at the owner's
decision: arrows give a reading a still frame can carry unambiguously, which
plain traces were judged not to (session 4).

**Expected effect, written before building:**
- *On `flow` (known truth):* arrows in the band point right, on the block
  down-left, around the disc square to the radius; arrow length near the
  disc's rim is visibly longer (about three times) than a third of the way
  out. No arrows on the still background, none inside the flat centre where
  nothing is measured.
- *On `traffic`:* the two carriageways carry arrows in opposite directions; a
  judge reads both directions and the faster lane from one still frame.
- *Against the colour view and the traces, blind:* the judge tells the three
  apart, reads direction from a single arrow still without a colour key, and
  does not find the arrows to obscure the picture more than the traces do.
- *Known limits for the help text:* an arrow is the mean of its cell, so a
  boundary between movers blends; arrows are drawn at a fixed grid, not on
  objects; speeds beyond the range setting clip at full length.
- *No regression:* colour and particle displays unchanged (numeric guard on
  their filmstrips).

**Result: accepted.**

Built as `app/arrows.js` (reads the same reduced field the particles read;
3 segments per arrow drawn with the line machinery; arrows centred on a
28 px grid, hidden below the presence and speed floors) behind an "Arrow
grid" option in the flow mode's Show select. The blind judge was given the
three displays unlabeled (Q = colour, J = particles, X = arrows) on the
known-truth `flow` clip and on `traffic`, with the plain footage:

| Check | Judge (blind) |
|---|---|
| Tells the three apart | "Trivially distinguishable at a glance: solid fields vs. fine streaks vs. discrete arrows" |
| Direction from a single still, `flow` | Band "arrows all pointing right"; square "arrows pointing diagonally down-left"; disc "arrows arranged tangentially… i.e. clockwise rotation". "Most confident from a single frame: X. The arrowheads give signed direction with no legend needed" — the particles' known 180° ambiguity named unprompted |
| Length means speed, disc | "Rim marks are noticeably longer… marks nearer the centre shrink to short stubs… a small empty patch at the very centre with no mark at all… exactly the velocity profile of rigid rotation, readable from one frame" |
| `traffic` from one still | Two carriageways opposite ways, "the right/approaching side is faster in every method… longest arrows in X, with speed growing toward the bottom of the frame" |
| Not cluttered | "Nothing is cluttered; X errs on too little ink, not too much". Rankings: direction X > J > Q; speed J > X > Q; pleasantness J > Q > X |
| No regression | The colour and particle strips of the same moments are byte-identical to master (VA1's guard table covers them) |

Defect the judge found, kept and added to the help text: the sparse grid
undersamples small and slow movers (distant traffic "reduce[s] to a handful
of faint specks"). The particles stay the default display. (Housekeeping:
the renderer file itself landed one commit early, unwired, inside IA2's
commit.)

### IA3. Time ruler: the mask's second gap and the history length; the ruler in the Viewfinder — interface
The ruler learns two more markers: the second gap of the modes built on the
motion mask, and the history length of motion history, so those lookbacks read
as a picture like gap, spread and trail do. The ruler also appears in the
Viewfinder layout (fullscreen and phones), where today only the Plate has it.

**Result:** built. The second gap is an ink flag ("2ND", draggable, shown at
its effective value: never nearer than the gap plus one frame); the history
length reuses the hatched band with a "HISTORY" marker where trail modes
show "TRAIL". Markers were restructured as transparent hit boxes with the
2 px line as a pseudo-element, so on phones they grow to 44 px for thumbs —
the audit's touch-target rule passes (it measures the element, which the old
±9 px pseudo grab area failed). Viewfinder shows the ruler between scrub and
transport at 72 px. Audited on the phone in motion history: min contrast
5.63, no overlap, no clipping, no small targets. Screenshots in the tier's
critique round.


### IA4. Mirror mode, and camera zoom by pinch — interface
**What it is.** A Mirror source button: the front camera, flipped like a
mirror, fullscreen viewfinder — an installation where viewers see their own
motion. The flip is display-only (CSS on the video and canvas): nothing
measured changes, and the direction legend flips with the picture so its
arrows and hues keep telling the truth about what is on screen. The mirror
stands only while the front camera is the source (flipping to the back
camera or loading a clip removes it). And, at the owner's request: two
fingers on the picture drive the camera's own zoom where the driver exposes
one (`track.getCapabilities().zoom`), with a status readout; a camera
without a zoom control says so once (iOS Safari exposes none).

**Result:** verified with headless Chrome's fake camera: the Mirror button
loads the user-facing camera into the fullscreen viewfinder with the canvas
flipped (`matrix(-1, 0, 0, 1, 0, 0)`; the fake camera's burnt-in timestamp
reads backwards); the fake camera has no zoom capability, so the graceful
path ran (`cameraZoom()` null, `setCameraZoom` false, the status message).
**Needs the owner's eyes on a real phone:** the real front camera in Mirror
(including a heading-coloured mode, to see the flipped legend read
correctly), pinch zoom on the back camera (range, smoothness, whether the
driver animates it), and that fullscreen sticks on the phone browser.


### IA5. Schlieren: a step-by-step setup guide in the picture — interface
**What it is.** A checklist card on the stage for the schlieren mode:
textured background, camera still, let it settle, hold then light — each
step with a live state dot and reading from the mode's own judgement of the
setup, published as `pipeline.readings` (Session B's contract: mode
'schlieren', setup {problem, usable, camera, noise, seen, held}). Opens by
itself the first time schlieren meets a live camera; a Setup-guide chip
reopens it; without readings (Session B's branch not yet merged, a mode
reporting none, the Canvas 2D fallback) the steps show no live state, which
is still the checklist.

**Result:** audited at desktop and phone with the readings stubbed in three
states: all-good (green dots, "72% measurable", "held — light the candle"),
plain background (step 1 red with "12% measurable"), settling (step 3
waiting). No overlap, nothing clipped, touch targets pass after the close
button grew to 44 px, min contrast 10.7 on the phone. The live wiring runs
against the stub exactly as it will against Session B's readings; checking
it against the real field needs their branch merged, and the camera flow
end-to-end needs the owner's phone.

### IA6. The tier's critique round — interface
A fresh critic (who had not seen the work) reviewed nine screenshots of the
new chrome against the brief. Verdict: "the two languages are real and
distinct — nothing here reads as a generic component library", with three
send-backs, all acted on:

| Send-back | Fix |
|---|---|
| The phone split divider ran the full viewport, through the title and letterbox ("looks like a rendering bug") | The shell now publishes the letterboxed picture's bounds (`--pic-top`); the divider clips to them |
| The phone setup guide covered the picture while the letterbox band above sat empty | The card starts in the band under the action plate, and a step already satisfied drops its instruction line, so a healthy card fits the band entirely |
| GAP/TRAIL label collision on the phone ruler | Already fixed before the round (IA3's foot anchor); the critique screenshot predated it |

Nits acted on: the guide card re-set in the Viewfinder's voice (condensed
caps and mono, not the Plate's serif); "2ND" flag relabelled "2ND GAP";
the desktop legend became a round, larger card (no dead corners, arrows
legible); the guide's held state reads "reference held" (the green dot had
contradicted "light the candle"); the camera Flip glyph is now ⇄.

Nits noted, kept deliberately: the red GAP flag inside the amber Viewfinder
stays — red-means-R-channel/gap is a cross-layout semantic shared with the
R/G/B spread flags; the hatched band keeps its TRAIL/HISTORY marker as its
label; the legend says direction only (brightness-means-speed stays in the
help); the phone clock drops the total duration for space, as before this
tier. Re-audited after the fixes: phone split and desktop flow states show
nothing clipped, overlapping, off screen or under 44 px.
## Session B

Verdicts from the measurement session (branch `session-b-measure`) are numbered V-B1,
V-B2… so they cannot collide with Session A's numbering.

### V-B1. Live readouts from the flow field, and a too-fast warning — robustness
**What is built.** The Optical flow mode reads a small copy of its velocity field back
each frame and reports, on the status line and as data (`pipeline.readings`): the
dominant heading, the peak speed, the share of the frame moving, and the camera's own
motion (the confidence-weighted median shift). When a telling share of what moves is
at the fastest speed the solver could have measured, the status line warns that the
motion is beyond the gap's reach instead of showing a number that cannot be right.

Readouts are text and data, not a picture: they are accepted on demonstrations
against known truth and unit tests, with the numeric guard confirming the flow
pictures themselves did not change.

**Expectations, written before building:**
- On the synthetic `flow` clip (a band sliding right at 90 px/s, a block down-left at
  60 px/s, a turning disc) at the default gap: dominant heading reads right; peak
  speed within 20% of the band's 90 px/s (scaled to the processing size); the share
  moving between half and 1.3× the movers' true cover of the frame; the camera reads
  still.
- On `handheld` (the whole frame wobbles) the camera reads as moving; on `trees`
  (static camera, branches in wind) it reads still.
- Warning: on `flow` with the gap raised until the band's shift per gap is beyond the
  pyramid's reach, the warning appears; at the default gap it does not.
- No regression: before/after filmstrips of `scripts/scenes/flow` differ under the
  numeric guard's invisibility threshold (readouts change no pixels), and the unit
  tests for the new core functions pass.

**Result: accepted.**

What was built: `flowReadings` in `core/flow.js` (unit-tested: shares, percentile
peak, circular heading with a coherence that tells one stream from opposed ones,
the median camera shift via `globalShift`, saturation against a ceiling);
`reportReadings` in `app/modes/flow.js` reads the velocity field back at ≤96 px
wide each frame, carries the measurable ceiling on the field, puts a sentence on
the status line and the numbers on `pipeline.readings`.

Demonstrations (headless Chrome, SwiftShader; `scratchpad/readings-demo.js`):

| Expectation | Measured |
|---|---|
| `flow`, default gap: heading right | Mean heading 0.08 rad; sentence "→ right" |
| `flow`: peak within 20% of the band's 90 px/s | Mean peak 93.0 px/s (640 px processing width = the scene's own size) |
| `flow`: share moving between 0.5× and 1.3× the true cover (~28%) | 34.9% ≈ 1.26× (window spread), sentence "31–32% of frame" |
| `flow`, `trees`: camera reads still | See clarification below: the camera claim is omitted (under half the frame measurable), not "still" |
| `handheld`: camera reads moving | "camera → 10%/s" (median 75 px/s), steady across samples |
| Warning at a gap beyond reach (`flow`, gap 15, ceiling 56 px/s) | Warned (saturation up to 0.34); the flow also collapses to "nothing moving", as beyond-reach answers lose confidence |
| No warning at the default gap | None (saturation 0.00; ceiling 448 px/s) |
| No regression | All 20 before/after strips of `scripts/scenes/flow.json` byte-identical (changed 0%, max diff 0); 296 unit tests pass |

**Clarification, found while demonstrating.** The first build claimed a camera
reading whenever a third of the frame was measured: on the synthetic `flow` clip
(flat background, so only the movers carry measurements) the median then reported
the movers as "camera 12%/s". The median only speaks for the camera when most of
the measured cells are background, so the claim is now made only when at least
half the frame is measured, and under 2.5% of the width per second it reads as
still (moving things among the measured cells drag the median a little; `trees`
sat at 2–3%/s). Where less than half the frame is measured the sentence says
nothing about the camera rather than guessing.

Known limits, stated rather than hidden: the camera readout is the median shift —
a zoom or rotation reads as near-still (its median is zero); and on footage where
movers fill most of the measured area the dominant heading *is* the camera's
drift, which is honest (everything does flow).

### V-B2. Type checking through JSDoc — robustness
The contracts that cross module boundaries are now JSDoc typedefs that
`npm run typecheck` (tsc, no emit, no conversion: the code stays plain
JavaScript) holds every implementation to: `Mode`, `ModeFrame` and `FrameStep`
in `app/modes/index.js` with every mode's default export checked against
`Mode`; `ParamDef` in `app/modes/params.js`; the worker protocol (request and
result messages) in `app/pipeline.worker.js`, used by the worker body itself.

Demonstration: the checker is clean at this commit; changing one mode's `id`
to a number is caught at the export ("Type 'number' is not comparable to type
'string'"). The only runtime change is the worker aliasing `self` to a typed
scope; the Canvas2D fallback was demonstrated still working (posy and magnify
render pictures with `?renderer=canvas2d`), and the build and all 296 tests pass.

### V-B3. A sample clip for Magnify that is not a face — sample check, as I3
**Chosen:** *Sleeping Kitten* (Pexels 13925469, 1920×1080, 30 fps, 13 s): a
ginger kitten curled asleep indoors on a locked-off camera, flank and belly
visible. Sample params: band 0.15–1.0 Hz, amplify 20×, pool 2×.

As with I3, my own reading, no blind judge: in the magnified filmstrip the
breathing shows as the flank edge swelling and sinking between frames; the
band strength averaged over the frame oscillates with about a 1.5 s period
(≈40 breaths/min, normal for a sleeping kitten) over four cycles before the
kitten stirs once around 6.5 s — in the plain video the breathing is nearly
invisible. Loaded from its host in headless Chrome the way the picker does
it: comes up in Magnify with a picture (band strength in the data target)
after about 1.6 s. Rejected after rendering: a chihuahua asleep on a quilt
(Pexels 5994139 — it moves visibly, nothing for magnify to reveal) and a
white dog outdoors (Pexels 5596930 — mostly a dog's face, and the head
drifts). Added to the reference clips as `kitten` for future magnify work.
Not checked: loading on a phone or a slow connection.

### V-B4. History ribbons in measured colours (flow + history) — visual
`historyShow: 'measured'`: the ribbon a mover leaves is still the history
mode's; its colour is the flow field's measurement from the moment each pixel
was passed — hue = measured heading (flow's wheel), brightness = measured
speed against the speed range — instead of a hue read off the ribbon's shape.
Design: docs/combined-modes.md §1.

**Expectations, written before building:**
- *Measured vs direction, on `gulls`:* told apart. Each ribbon holds one
  steady hue that matches its bird's course; the direction view shows the
  same wheel but patch-averaged (56 px cells), so hues bleed across nearby
  ribbons and wobble along one. A blind judge can say which is which from
  "hue is uniform per ribbon and does not leak outside it".
- *On `truth`:* the square's ribbon reads the right-heading hue (red), the
  30°-down disc's ribbon yellow-orange, the leftward disc's cyan — the known
  headings; brightness even along each ribbon while speed is constant.
- *Where flow has nothing* (a flat mover's interior): the ribbon keeps the
  last measured colour rather than going black; at worst it greys.
- *No regression:* the age and direction views byte-identical (the new pass
  runs only in the measured view); mask data output unchanged.

**Result: accepted, with the limits below.** Three blind judges, one per
clip pair, each given the two strips unlabeled in shuffled order.

| Check | Clips | Judge (blind) |
|---|---|---|
| Visible | truth, traffic, gulls | Told apart "easily" on all three |
| Intended: steady hue per rigid stream, brightness by speed | traffic | Measured strip described unprompted as "hue mostly uniform within a stream… brightness tied to speed or proximity, near-camera brightest"; the direction strip as "hue drifts and bleeds within a single stream" with "blue-grey and teal contamination" — the known 56 px pooling artifact |
| Intended: known headings | truth | Disc's ribbon uniform orange (its 30° course); square's rim red (rightward) with a grey interior — the anticipated greying of a flat mover's interior, where flow measures nothing |
| Intended (re-registered): parts of a flapping bird resolve | gulls | "Shows structure within a bird's motion (magenta body, teal wing edge, blue tail) that the other smooths away" |
| No regression | truth, traffic | Age and direction strips before vs after: 0% changed, max diff 0, on all ten scenes; data output untouched; 296 tests pass; typecheck clean |

**Limits, stated rather than hidden:** a flat mover's interior ribbon greys
(flow has nothing to measure there; the rim carries the colour); faint or tiny
movers lay down grey trails (the gulls' tails); the laydown edge is blocky at
the flow working size; and a ribbon at the top of the speed range saturates to
full brightness. The first two are what the measurement honestly knows, and
the help sheet says so.

**Addendum, before any traffic strips were rendered.** The gulls strips showed
the first two expectations were written for the wrong animal: a flapping bird
is not one motion, and the measured view resolves its parts (body forward,
wingtips up and down) where the direction view's 56 px pooling averages them
into one hue. The steady-hue expectation belongs to rigid movers, so it is
re-registered on `traffic` before rendering it: each carriageway's ribbons in
one steady hue (the two opposed headings), and the near, faster carriageway's
ribbons brighter than the far one at the same speed range — speed is what the
direction view cannot show at all.

### IA7. One preset list: the samples' looks join the Preset select — interface
At the owner's request: the per-sample default settings and the panel's
preset list were two separately maintained sets. Now `PARAMETER_PRESETS` is
the one source of truth — the samples' looks are entries in it, named after
their sample, and a `TEST_CLIPS` entry carries only `preset: '<name>'`.
A preset may name a display; `Session.applyPreset` applies both, from the
panel and from the sample buttons alike.

**Result:** verified in the browser: the Motorway sample button opens flow
with its preset (diff display, speed range 40), applying "Gulls Overhead"
from the preset path switches any footage to motion history with its
settings, and the select offers all 14 looks. 296 unit tests and the
typecheck pass. No pixels change: the same settings apply as before, from
one list instead of two.
### V-B5. Filling holes in mask cut-outs (morphological close) — visual
`maskFill` (Off / 1 px / 2 px) on the Motion mask and Background model modes:
after the 3×3 vote has removed speckle, the decision is dilated then eroded by
the chosen radius, so holes up to twice the radius across are filled and
ragged rims are smoothed, without growing the cut-out (a close returns solid
shapes to their own outline). Core `dilate`/`erode` in core/mask.js are the
source of truth; the shader mirrors them. Off keeps today's path untouched.
Design: docs/combined-modes.md §5.

**Expectations, written before building:**
- *On `traffic`, mask cut-out, fill 2 px vs off:* vehicle cut-outs lose their
  interior holes (dark panels, windows) and read as solid shapes; rims
  smoother. A blind judge tells the strips apart and says one shows whole
  vehicles where the other shows fragments or perforated ones.
- *On `bees`, mask cut-out:* each bee one solid blob instead of fragments.
- *On `crossing`, background-model cut-out, fill 2 px:* the same for cars and
  pedestrians being carved out of the model.
- *Speckle must not return:* the vote runs before the close, so lone noise
  pixels are gone before anything dilates. Flicker in static areas must not
  rise against the off strips.
- *Truth check (`truth-mask` scene, fill 1):* the share of the square's
  outline filled rises or holds against off; the share marked "elsewhere"
  stays within a point or two.
- *No regression:* with fill off, mask and background strips byte-identical
  to before the change.

**Result: accepted; visible exactly where there are holes to fill.** One blind
judge, three pairs, unlabeled and shuffled:

| Check | Clip | Judge (blind) | Numeric guard |
|---|---|---|---|
| Visible and intended | traffic (mask) | Told apart "clearly": with fill, "cars are whole, filled shapes"; without, "riddled with dark holes, black outlines, cracks"; rims smoother with fill | 1.8% of pixels changed; flicker 0.20 → 0.18 |
| Bees | bees (mask) | "Barely" told apart — at these settings the bee cut-outs were not actually perforated, so there was almost nothing to fill | 0.57% changed, at the invisibility floor |
| Crossing | crossing (background) | "Nearly identical for the cars and pedestrians. Both are solid" — the model's cut-outs had no holes; fill only thickened faint shadow patches slightly | 1.0% changed; flicker 0.22 → 0.24 |
| No speckle returns | all three | "No variant showed background speckle in any pair" (the vote runs before the close) | |
| Nothing lost or grown | all three | "No mover present in one and missing in the other"; with fill the traffic shapes read "slightly puffier" (a close rounds concavities) | |
| Truth check | truth | Fill 1 vs off: marks on the current outline 100% both, elsewhere 0 both, outline coverage identical — the close invents nothing on a mask without holes | |
| No regression | truth, truth-noisy, highway, background scenes | | Fill off: 0% changed, max diff 0 on all five guard scenes; parity probes exact on both fill cases (and all seven probes pass on the rebased tree); 301 tests |

The expectation for `bees` was wrong about the footage, not the change: a
hole-filler that finds no holes alters nothing, which the truth check
confirms is the designed behaviour. An *open* (salt removal) was not built:
the 3×3 vote already does that job. Samples keep fill off — it is a remedy
for footage whose cut-outs are actually perforated, like `traffic`.

### V-B6. Flow measured only on what moves (mask + flow, background + flow) — visual
`flowOnly` on the Optical flow mode: `Everything` (today's behaviour),
`Moving (mask)` — the three-frame mask gates the measured vectors before the
running average, so colour, traces and arrows exist only on movers — and
`Foreground (model)` — the background model's decision gates instead, so a
slow drifter keeps its flow and a stopper's fades out as it is absorbed. The
gate is downsampled to the working size by maximum and dilated by the solve
window, so a mover's rim keeps its vectors; the gate multiplies confidence
BEFORE smoothing, so gated places decay below the presence floor rather than
blinking off. Design: docs/combined-modes.md §2–3.

**Expectations, written before building:**
- *On `traffic`, colour view, mask gate vs everything:* colour confined to the
  vehicles; the faint speckle and smeared patches on the empty road are gone.
  A blind judge tells the strips apart and says which rule each follows.
- *On `crossing`, foreground gate:* flow colour on moving vehicles and
  pedestrians only; the road, its markings and parked/absorbed cars carry
  none.
- *On `river` (everything moves):* the gates change little — the picture
  stays a full field of flow apart from the still banks.
- *Readouts stay honest:* with a gate on, the "share of frame" readout counts
  only ungated cells, and the camera claim is omitted (under half the frame
  measured: the ground is deliberately no longer measured, so the median no
  longer speaks for the camera).
- *No regression:* `flowOnly: 'all'` byte-identical to before the change on
  the flow guard scenes; flow and schlieren parity probes still pass (the
  solver itself is untouched; only its confidence is gated afterwards).

**Result: accepted, with the gates' reach stated as limits.** One blind judge
(traffic pair, river pair, clouds trio, unlabeled and shuffled):

| Check | Clips | Judge (blind) | Numeric guard |
|---|---|---|---|
| Visible and intended | traffic | Told apart; the gated strip has "smaller, tighter blobs", the smeared upper-left mass separated and the stray streaks and left-edge specks removed; "the main big blobs are equally coloured in both" | |
| Intended (re-registered): the two gates differ on slow drift | clouds | Ranked exactly as registered: ungated full, foreground gate keeps most of the cloud front (patchy), mask gate "essentially black". Mountains and empty sky stay black in all three | |
| Readouts stay honest | traffic | | Gated: measured share 0.23 → 0.12 (only movers are measured); the camera claim stays omitted (share < 0.5) |
| No regression | all nine flow guard scenes | | `flowOnly: 'all'`: 0% changed, max diff 0; 301 tests; typecheck clean |

**Expectations that failed, kept as limits (in the help sheet):**
- On `river` the mask gate does not "change little": the three-frame mask
  resolves little of a surface that moves everywhere, and the gate eats much
  of the measurement with it (the judge: large areas coloured ungated are
  "black apart from patches" gated). The gate is for distinct movers on still
  ground; on motion-everywhere footage it should stay off.
- On `traffic` the gate also cost a few genuine small, distant movers (an
  orange streak on the far road) that the mask had missed: a gate is only as
  good as its mask.

**Addendum, before any clouds strips were rendered.** The crossing strips show
the foreground gate changing almost nothing there: flow's own "no better than
still" test already blanks that background, so the expectation named a clip
where the gate has no work. What distinguishes the two gates is slow drift:
the three-frame mask misses what barely moves between its gaps, while the
model never absorbs what keeps drifting. Re-registered on `clouds` (slow
cloud flow, gap 4) before rendering it: with the mask gate much of the cloud
front's colour disappears; with the foreground gate it stays close to
ungated; the mountains and plain stay dark in all three.

### V-B7. Per-pixel noise threshold for the mask (background model's variance) — visual
`maskAuto` on the Motion mask mode: the background model's variance (which
learns each pixel's own noise) sets a per-pixel floor of BG_K·σ·√2 — ×√2
because a frame-to-frame difference carries two frames' noise where the model
comparison carries one — and the global threshold becomes a floor under it,
exactly the rule the background mode already decides by. The model and its
variance are maintained the same way the flow gate maintains them
(learnMask + updateBackground). Design: docs/combined-modes.md §6; roadmap
motion-extraction item 2.

**Expectations, written before building:**
- *On `truth-noisy` (heavy sensor noise) at a LOW floor (threshold 8):* the
  fixed mask is speckled all over the still background; the auto mask at the
  same floor is as clean as the fixed mask at 20, while the square and discs
  stay marked at least as fully as fixed-20 marks them. A blind judge tells
  the strips apart and describes one as noise-speckled, the other as clean.
- *On `night` (real low light, grain) at threshold 10:* fixed speckles on the
  water and sky grain; auto suppresses the grain and keeps the walkers.
- *On clean footage (`truth`):* auto at the default floor is near-identical
  to fixed (the learnt variance sits at its minimum, whose √2 rule lands just
  under the default floor).
- *Truth check:* auto at floor 8 marks the square and disc outlines within a
  few points of fixed-20's coverage, nothing elsewhere.
- *No regression:* `maskAuto` off byte-identical to before the change.

**Result: accepted after one correction round.** Fresh blind judge each round
(the pairs unlabeled and shuffled; the round-2 judge knew nothing of round 1).

*Round 1* (bar = BG_K·σ·√2): on `truth-noisy` clean and told apart at a
glance, but the judge found the auto disc thinner than fixed-8's, and on
`night` the walkers reduced to "thin edge outlines… red clothing largely
missing". Cause, found and fixed rather than tuned around: the mask
differences 3×3-blurred frames, which carry a third of the learnt (unblurred)
noise, so the bar stood ~3× too high wherever the signal was low-contrast.

*Round 2* (bar scaled by the blur, core and shader):

| Check | Clip | Judge (blind, fresh) | Numbers |
|---|---|---|---|
| Visible and intended | truth-noisy, floor 8 | Fixed "has visibly more speckle… a denser cloud of dots"; auto "much cleaner… almost pure black"; "the bar and disc are about equally complete in both — no real loss of mover area" | Marks elsewhere 1.45% of marks (0.02% of coverage) vs fixed-8's 10%; outline coverage 42.8% vs fixed-20's 41.4%; disc filled 51.2 vs 50.2 |
| Night keeps its movers | night, floor 10 | "Cannot tell them apart at a glance… completeness looks the same" — nothing visibly suppressed either: at this floor the fixed mask's background marks are real lights and reflections, not grain, so the auto bar rightly leaves them (as with V-B5's bees: nothing to fix, nothing changed) | |
| Clean footage unchanged | truth, floor 20 | | Auto vs fixed byte-identical (the minimum learnt variance lands under the default floor) |
| No regression | truth, truth-noisy, highway | | maskAuto off: 0% changed, max diff 0; 304 tests pass; typecheck clean |

Not probed for shader parity (the auto path needs model state over frames);
covered instead by the core unit tests (including the blur scaling) and the
byte-identical clean-footage check against the fixed path.

The night expectation half-failed honestly: auto "suppresses the grain" only
where the marks are grain. Low-contrast movers survive the bar now; what
survives of the night background is signal.

### V-B8. Lighting normalisation: differencing edges instead of brightness — visual
`maskGradient` ("Ignore lighting") on the Motion mask mode: the three frames
are reduced to their edge strength (Sobel magnitude of luma — the gradient of
a smoothed image, so it replaces the pre-blur) before differencing. A global
brightness or exposure change adds a constant the gradient does not see, so
it stops lighting the whole frame; what moves still changes its edges.
Design: docs/combined-modes.md §7; roadmap motion-extraction item 5.

**Expectations, written before building:**
- *On `sunset` (timelapse exposure drift; measured: 27% of the frame marked
  at threshold 12 today):* with the option on, at the same threshold, the
  flat sky and sea stop being marked — the share of the frame in the mask
  falls by at least half — while the cloud fronts' moving edges stay marked.
  A blind judge tells the strips apart and describes one as a whole-frame
  wash and the other as edges of the changing clouds only.
- *Brightness invariance, exactly:* the core unit test adds a constant to
  every pixel and the edge image is unchanged.
- *On `truth`:* the movers stay marked at their outlines (a flat interior
  was never marked); nothing new appears elsewhere (truth check).
- *No regression:* option off byte-identical to before the change.

**Result: accepted, with the edge-detector's nature stated as limits.** One
blind judge, the sunset pair unlabeled and shuffled:

| Check | Judge (blind) | Numbers |
|---|---|---|
| Visible | "Instantly distinguishable" | Share of the frame marked at the same threshold: 21.1% → 1.0% |
| Intended | The fixed strip is "the pattern a global brightness drift would produce… whole cloud bodies rather than boundaries"; the gradient strip "marks only thin edges and contours… the bank's undulating silhouette is traceable across all six panels", not random scatter | Core unit test: a constant added to every pixel leaves the edge image bit-identical |
| Movers keep their outlines | | `truth`: 100% of marks on the current outline, nothing elsewhere |
| No regression | | Option off: 0% changed, max diff 0 on three guard scenes; 308 tests; typecheck clean |

**Limits, stated rather than hidden:** the gradient mask is a sparse edge
detector — thin ridges, further thinned by the clean-up vote, so a mover's
outline is marked sparsely (`truth`: 14% of the outline against the
brightness mask's 41%); and diffuse fronts with soft edges respond weakly
(the judge: the upper cloud mass the brightness mask fills is "almost
absent"). It is a remedy for lighting and exposure drift, not a better
general mask; the help sheet says so.

### V-B9. Magnify muted where nothing ever happens (background + magnify) — visual
`magQuiet` ("Mute still areas") on Magnify: the background model's variance —
each pixel's own level of change, learnt over seconds — gates the amplified
band. Where a pixel's σ sits at the frame's quiet level (the 25th percentile)
the band fades to nothing; where something rhythmic keeps raising it (a
breathing flank) the band stays. This mutes amplified sensor noise on walls
and bedding without knowing where the subject is. The picture adds
`keep·amp·band`, so gate off is arithmetically identical to today; the band
magnitude (data, sonification) is gated the same way. WebGL only, as the
model is. Design: docs/combined-modes.md §4, including the pre-registered
risk that a rhythm fainter than the noise floor is muted with the noise.

**Expectations, written before building:**
- *On `kitten` (gate on vs off, after a few seconds of learning):* the
  amplified grain and shimmer on the blanket, wall and sleeping body's still
  parts visibly drop; the flank's breathing swell stays. A blind judge says
  which strip is quieter off the subject and confirms the subject's movement
  is equally visible in both.
- *Numbers:* mean band strength (data R) over a still background patch drops
  by at least half with the gate; over the flank it stays within about a
  quarter of ungated.
- *On `pulse` (a 1-level swing, under the model's 2-level variance floor):*
  the gate mutes it — the pre-registered design risk, demonstrated and stated
  in the help sheet ("turn the gate off for rhythms fainter than the noise"),
  not a failure.
- *No regression:* gate off byte-identical (multiplying the band by 1 is
  exact); the Canvas2D worker path untouched.

**Result: accepted, with the numbers and the look reported honestly.** One
blind judge, the kitten pair unlabeled:

| Check | Judge (blind) | Numbers |
|---|---|---|
| Visible | Told apart "fairly easily, mainly in the still regions" | 57% of pixels differ |
| Still areas calmer | Ungated: "fine grain and mottling on the wall and blanket… hazy… smeared". Gated: "the wall surface itself is flatter and cleaner, with less grain" | Static-area flicker 11.8 → 6.0 (−49%): the amplified shimmer is what halves. Mean band strength: flat wall −30%, blanket −16%, the windowsill box −37% (those surfaces carry real recurring change — lamp flicker, breathing shadows — which the gate rightly keeps) |
| Subject untouched | "Amplification looks about equally strong in both… no clear weakening" | Flank band strength 94% of ungated |
| The clean-room case | | On `pulse` (a wholly static scene) the gate mutes everything, band strength 0.030 → 0.000 — including the 1-level pulse itself, the pre-registered design risk, now in the help sheet |
| No regression | | Gate off: 0% changed, max diff 0 (the composite keeps its exact float association when ungated); 308 tests; typecheck clean; worker path untouched |

**The look, stated rather than hidden:** what still flickers for real — bright
edges under a pulsing lamp — keeps its amplification and stands out harder
against the calmed surroundings; the judge read those rims as the gated
strip's own artefact ("embossed… cut-out" folds). The help sheet says so. The
registered "background drops by at least half" held for the flicker measure
and the static clip, not for the kitten's mean band strength, whose remainder
is real signal.
### IA8. Readings panel — interface (owner's commission)
Design and research in `docs/readings-panel.md` (observatory plate
marginalia; strip-chart pen line). Desktop Plate only; the I key and a mast
button; the readings and the parameters share the plate's margin, so on
windows under 1800 px opening one closes the other — the picture never
shrinks below the size rule for the panel's sake.

**Built in the owner's two steps.** The raw list first; watching it on the
clips changed the design twice: the raw camera row showed 86 px/s on the
synthetic scene's still camera (the median only speaks for the camera when
at least half the frame is measured — the row now says so instead of
showing a mover's number), and the full list proved too much to leave open
(now behind an "All readings" disclosure). Promoted instruments: the peak
speed numeral (px/s, 95th percentile of moving cells), the moving-share pen
line over 60 s on ruled chart paper (every mode: pooled grid where the mode
publishes no readings), and the direction rose (eight sectors in the
legend's hues — commissioned because one averaged heading is wrong on
`traffic`, and the observation confirmed it: 77% of moving cells head
down/down-right with an opposed up-stream the mean hides).

| Check | Result |
|---|---|
| Known truth, synthetic `flow` scene | Peak 94 px/s against 90 known (95th pct over all movers); dominant heading → right 0°; rose East bin 77%; coherence 0.83; speed spread 24/76/0 against the range — all as the scene defines |
| Rose orientation | A stubbed all-East reading draws one red bar pointing right: canvas y-down handled, hues match the legend |
| `traffic` | Rose shows both carriageways (S-heavy group and opposed N/NE group); peak ~170 px/s; status line and panel agree |
| No-readings mode (posy) | Pen line runs from the pooled grid; flow instruments dim with a plain sentence; no empty boxes |
| Audit, panel open | Nothing clipped, overlapping, off screen; min contrast 5.97; picture share equal to the parameters-open baseline at the same window |
| New measurement | One commit touching only reportReadings: rose and speeds bins over the field it already reads |

Needs nothing from the owner's phone (desktop only). Screenshots for the
tier's critique round.

### IA8a. Readings panel layout rework — interface (owner's report)
The owner found the raw list unreadable in use (dark Plate, schlieren): the
two-column grid let a wide value crush the name column to a word a line and
push values out of the margin, and the flow-only instruments sat as dimmed
empty boxes in modes that measure no flow.

**Result:** each reading is now one row — name and value share a line (a
long value wraps beneath, right-aligned), the unit below in small type; the
margin no longer scrolls sideways. Instruments that measure nothing in the
current mode are hidden, not dimmed: schlieren shows the pen line and the
note, no dash-boxes. The margin-sharing rule now also holds through window
resizes. Audited clean (flow with the panel open: nothing clipped,
overlapping or off screen; min contrast 5.97). A white picture in the
owner's screenshot was schlieren settling its reference (2 s), reproduced
on old master identically — not a panel effect.

## Session 6

### X-1. The app reorganised around effects (owner's pick from three mockups)
**Expected, written before the after-test ran.** The owner picked, from
docs/design/effects/: the atlas structure and landing (A), the instrument
margin as the data display (B), the question strip in the Viewfinder (C).
Success is measured the way the brief asked — a fresh agent that has never
seen the app gets a goal in plain words and must reach the right picture,
same four goals and 12-action cap as the baseline of 2026-11-15:

1. "Show which way the traffic is moving" — stays a one-step success.
2. "Load your own clip by URL, show the gulls' paths" — reached without
   abandoning the URL path, or the sample fallback found faster.
3. "Trails coloured by each mover's true direction" — the built combination
   (history × flow) is actually reached: historyShow = 'measured', not a
   flow-traces near-miss.
4. "Kitten breathing, then mute the amplified noise" — both parts reached:
   magQuiet on, through the UI.

Also: the interface audit rules hold at desktop and phone sizes with the
margin open (picture share, contrast, overlaps, 44 px targets), and a fresh
critique finds the result distinct and of one piece with the Plate, not a
generic dashboard.

**Result (same protocol, fresh agents, 2026-11-15).** All four goals reached:

| Goal | Before | After |
|---|---|---|
| 1. Traffic direction | reached, 1 step (labelled sample) | reached, 3 steps via the effect's own name (the sample path remains) |
| 2. Own URL → gull paths | sample fallback after 10 actions; URL abandoned | trails in 1 effective click; URL typing was blocked by the test harness (focus bug in the driver, not the app), Escape-"reset" and mid-test resets were the harness reloading the page |
| 3. Trails by true direction | NOT reached (near-miss accepted) | **reached**: "Coloured by: true measured direction" found in 2 clicks |
| 4a. Kitten breathing | reached, 1 step | reached, 2 steps |
| 4b. Mute the amplified noise | NOT reached in 12 actions | **reached** in 1 further click ("Still areas: muted") |

Testers' words: "the control labels are excellent — 'Leave trails' and
'Coloured by true measured direction' read exactly like my goal";
"'Still areas: amplified too / muted' was a perfectly worded control for
exactly the noise problem."

Interface audit: clean at 1440×900 (picture share 0.525, min contrast 4.78,
nothing clipped/overlapping) and at 390×844 (share 1, min contrast 11.46,
all targets ≥ 44 px), and on the landing (min contrast 5.63). Blind
critique verdict: "distinct-and-coherent … nothing here reads as a generic
dashboard", with defects that were fixed in the same branch (stale caption
and empty instrument on the landing, a pill-label wrap, phone/desktop
effect-name drift, a jargon label) or logged: arrows-on-black defaults,
the desktop legend wheel is unlabelled, "Mirror" is ambiguous beside
Camera, near-black specimen strips for the dark effects. One real bug the
test caught and this branch fixes: the hue legend now also shows in the
trails' measured view.

Found and fixed along the way: picking an effect with nothing loaded now
scrolls the atlas to that effect's row (two testers got lost exactly there).
