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
Nine samples were added to the source picker, one or more per mode; each names its mode
on the button and selects it with fitting settings when loaded. The three older samples
keep whatever mode is current, as before.

| Sample | Mode | What its filmstrip showed (my own reading; no blind judge was run for these) |
|---|---|---|
| Flower Opening | Posy | Fine outlines of leaves and stems on grey, colour fringes on the opening flower |
| Face, Held Still | Magnify | Loads and runs; the picture was not judged again (clip unchanged since session 3) |
| Bees at the Hive | Motion mask | Each bee cut out in its own colours on black; a few specks of wall beside the fliers |
| Gulls Overhead | Motion history | An orange-to-blue ribbon along each bird's path |
| Crossing from Above | Background model | Cars and pedestrians cut out whole, with their shadows |
| Motorway | Optical flow | Two opposed streams in two hues (V6) |
| Clouds over Peaks | Optical flow, over the video | Traces along the cloud front, none on the mountains or the plain |
| Weir | Optical flow | A stream across the foam at lower left; the smooth sheet of water on the right carries almost none (little texture) |
| Candle Plume | Schlieren | The plume of V7 |

All twelve samples were loaded from their hosts in headless Chrome the way the picker
does it: each came up in its mode with a picture (first frame after 0.2 to 1.0 s here;
the 49 MB candle clip after 1.0 to 1.4 s). The picker passes the interface audit at
desktop and phone sizes. Rejected after rendering: the intersection in Optical flow
(dim, the vehicles move too far per frame). Not checked: loading on a phone or a slow
connection, and browsers other than Chrome (the candle clip is a QuickTime file).
