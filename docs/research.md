# Research: how others do it, and what we should change

Written 2026-11-13, before the mode registry and the new modes. Four areas were
read up on: browser motion-extraction tools, OpenCV's background subtractors and
motion templates, Eulerian magnification implementations, and GPU optical flow.

How to read this:
- Every source listed was opened and read during this pass. Claims that could not
  be checked against an opened page are marked **unverified**.
- "Ours" means the code on branch `core-timebase-gpu-ring` at commit `a0d84f9`.
- Ideas are borrowed, not code. Where code could be borrowed the licence is noted;
  nothing has been copied.

## Summary of proposed changes

| # | Area | Proposal | Verdict |
|---|------|----------|---------|
| 1 | Posy / Raw diff | Keep the blend, the media-time frame selection and the GPU ring | No change. Nobody else found does time-based selection or keeps history in a texture array |
| 2 | Posy / Raw diff | Add a luma-first option for the RGB time-shift | Adopt (already on the roadmap as "luma-only branch"). Without it source colour is mixed into the time-as-colour reading |
| 3 | Posy / Raw diff | Blur before the diff, not only after | Adopt in the motion mask mode. In Raw mode blurring after `abs` only averages noise; blurring before cancels it |
| 4 | Posy / Raw diff | A frozen reference frame ("difference from this moment") | Roadmap. Three reimplementations have it; it costs one pinned ring layer |
| 5 | Trails | Decaying feedback instead of a windowed max | Done in `a0d84f9`, with media-time decay. A signed leaky accumulator (one tool uses it) is rejected: opposite deviations cancel |
| 6 | Auto-configure | Keep the noise-derived threshold | No change now. Every other tool hard-codes a threshold. The per-pixel noise model (feature 3) will supersede the single global number |
| 7 | Motion mask (new) | Keep `min(|cur−old1|, |cur−old2|)`; threshold a difference at k·σ·√2; clean up with a 3×3 majority filter | Adopt. Offer the centred variant later, it costs latency |
| 8 | Motion history (new) | Store time-since-motion, not absolute time; take direction from a Sobel gradient with OpenCV's validity window | Adopt, with one deliberate difference from OpenCV (see below) |
| 9 | Background model (new) | Single Gaussian per pixel; gate the update on the frame-difference mask, not on the model's own decision; variance floor and ceiling; time-constant learning rate | Adopt. This changes the plan: the model depends on the mask from feature 1 |
| 10 | Magnify | Split the band into spatial levels with per-level amplification (the paper's λ rule) | Roadmap, the biggest quality gain available. Not started |
| 11 | Magnify | Normalise band gain so "amplify" means the same at any band setting | Needs a decision: it changes what existing amp values look like |
| 12 | Magnify | Presets for pulse (colour) vs motion; deeper pooling for pulse | Roadmap |
| 13 | Magnify | Document the MIT patents | Adopt now. See the licensing note |
| 14 | Optical flow | Dense pyramidal Lucas-Kanade at 320×180, not the widely copied single-pass shader | Design note (feature 4) |

## 1. Browser and creative-coding motion extraction

### Sources
Posy-style reimplementations:
- https://gist.github.com/chigozienri/0ac602c3bc7d6c5fab9f0c6839f4ad6f — ffmpeg scripts (offset, fixed frame, colour delay). No licence.
- https://blog.izissise.net/posts/vidmotion — ffmpeg `setpts` recipe with a 0.8 s shift.
- https://martinoshelf.neocities.org/posy-motion-part1 — OpenCV/ffmpeg write-up.
- https://github.com/Slangborgh16/motion-extraction — C++/OpenCV. No licence.
- https://github.com/gabriel-kahen/motion_extraction — Python desktop tool. MIT.
- https://github.com/kylecorry31/motion-extraction — webcam web app. MIT.
- https://javier.xyz/blog/motion-extraction-with-mostly-css — two stacked `<video>` elements.
- https://bluejaylouche.github.io/rustjay-engine/examples/delta.html — wgpu RGB-delay effect. No licence.
- https://derivative.ca/community-post/tutorial/motion-extraction-touchdesigner-%E2%80%94-free-tox/74476 — TouchDesigner component, parameters only.

Motion detection and motion as data:
- https://github.com/lonekorean/diff-cam-engine and https://codersblock.com/blog/motion-detection-with-javascript/ — MIT.
- https://github.com/maniart/diffyjs — MIT.
- https://github.com/kylemcdonald/cv-examples — FrameDifference, MotionHistory, BackgroundSubtraction examples.
- https://github.com/fourMs/MGT-python — Musical Gestures Toolbox. GPL-3.0 (do not copy).
- https://ayosec.github.io/ffmpeg-filters-docs/7.1/ (blend, tblend, tmix, deshake) and https://arj.no/2022/01/09/frame-differencing-with-ffmpeg

Unverified: Posy's own video (the page returned no description or transcript, so
"Posy's technique" is known only through reimplementers); Shadertoy returned 403.

### What others do differently
- **Blend.** The same as ours. One tool uses our exact `(cur + (255 − ref) + 1) >> 1`;
  the rest use a 50/50 weighted add or `|a − b|`.
- **Comparison frame.** Almost all count frames (a deque, a 16-slot ring, an "offset
  frames" field); "seconds" options are `round(seconds × fps)`. Only the ffmpeg
  `setpts` recipe and the CSS version are truly time-based. Three tools also offer a
  fixed reference frame for cumulative change.
- **Pre-processing.** Optional Gaussian or box blur before differencing in two tools;
  a median or erosion after the threshold in one; downscaling to 64×48 in one, for
  speed. Nobody stabilises or normalises lighting.
- **Threshold.** All fixed constants (32 on luma-weighted difference, 21 on mean RGB,
  5% in MGT). MGT warns that thresholds remove small real motion. One tool uses a
  soft threshold, `max(c − t, 0) / (1 − t)`.
- **Trails.** A leaky signed accumulator; a max-blend feedback loop; set-to-255-then-decrement.
- **Colour.** Two tools convert to greyscale before the per-channel delay, so colour
  encodes only time. Typical frame offsets are 0/3/6 and 0/2/4.
- **Data.** diff-cam returns a score, a bounding box and a motion-pixel map; Diffy a
  grid of cell averages; MGT per-frame quantity, centroid and area of motion with
  millisecond timecodes, and warns that per-clip normalisation makes values incomparable.

### Should our code change
- **Diff, time base, ring: no.** We are ahead on frame selection and history.
- **Luma-first RGB time-shift: yes**, as an option. Today source colour and time are
  confounded in the fringes.
- **Blur order: yes, in the new mask mode.** Posy's blend is linear so the order does
  not matter there; in Raw mode and in the mask it does.
- **Frozen reference: roadmap.** Cheap and useful for slow cumulative change.
- **Threshold: no.** A soft knee is optional polish.
- **Data output: adopt the principle.** When modes expose data, emit raw quantities
  keyed by media time and never normalise per clip.

## 2. OpenCV: background subtraction, motion templates, three-frame differencing

### Sources
- OpenCV 4.x `bgfg_gaussmix2.cpp`, `bgfg_KNN.cpp`, `background_segm.hpp`, `imgproc.hpp`: https://github.com/opencv/opencv/tree/4.x/modules
- opencv_contrib 4.x `bgsegm` (`bgfg_gaussmix.cpp`, `bgfg_gmg.cpp`, `bgfg_subcnt.cpp`, `bgfg_gsoc.cpp`): https://github.com/opencv/opencv_contrib/tree/4.x/modules/bgsegm
- opencv_contrib `optflow` motion templates (`motempl.cpp`, `motempl.hpp`, `samples/motempl.py`): https://github.com/opencv/opencv_contrib/tree/4.x/modules/optflow
- Both repositories' `LICENSE`: Apache-2.0 on 4.x. The files above still carry the older BSD 3-clause header.
- Collins et al., VSAM final report §3.1.1: https://www.ri.cmu.edu/pub_files/pub2/collins_robert_2000_1/collins_robert_2000_1.pdf
- Collins, CSE486 lecture 24: https://www.cse.psu.edu/~rtc12/CSE486/lecture24.pdf
- Wren et al., Pfinder: https://static.aminer.org/pdf/PDF/000/205/725/pfinder_real_time_tracking_of_the_human_body.pdf
- Lacassagne, Manzanera et al. (Σ-Δ and morphology): https://largo.lip6.fr/~lacas/Publications/JRTIP08.pdf
- Barnich & Van Droogenbroeck, ViBe: https://orbi.uliege.be/bitstream/2268/145853/1/Barnich2011ViBe.pdf
- Davis & Bradski motion templates: https://vast.uccs.edu/~tboult/frame/Davis/DavisBradski.htm

Not opened: the Manzanera & Richefeu originals, Kameda & Minoh 1996, the Zivkovic
papers (the code was read instead), docs.opencv.org (403; the headers were read).

### What others do differently, and what we take
**Three-frame differencing (feature 1)**
- VSAM uses our causal form: moving if `|I(n) − I(n−1)| > T` and `|I(n) − I(n−2)| > T`.
  `min(a, b) > T` is the same test with a shared threshold and keeps a magnitude, so
  `min` stays.
- Collins' slides use the centred form, `D(−N) AND D(+N)`, which marks where the
  object is now. It needs N frames of latency. The claim that it leaves less of the
  uncovered strip than the causal form is a derivation, **unverified**.
- Both need the object to move about its own size across the gap; 15 frames suited a
  walking person.
- Thresholds in use: VSAM about 5× the temporal deviation, MOG2 4σ, MOG 2.5σ, Σ-Δ
  2–4. A two-frame difference has variance 2σ², so a threshold on a difference
  scales by √2. σ must be measured on the same blurred signal that is differenced.
- Cleanup: a majority ("density") filter of radius 1–3 or alternating open/close;
  a median of 7; component-area removal. A one-pass 3×3 majority is the cheapest
  shader fit.

**Motion history (feature 2)**
- `updateMotionHistory`: `mhi = t` where the silhouette is set; `0` where
  `mhi < t − duration`; unchanged otherwise. It stores absolute time, so variable
  frame intervals work by construction.
- `calcMotionGradient`: Sobel dx, dy on the timestamp image, orientation
  `atan2(dy, dx)`. A pixel's orientation is valid only if the spread of timestamps in
  its window lies between `delta1` and `delta2`: the upper bound rejects silhouette
  edges next to never-moved pixels, the lower rejects flat interiors. The sample
  uses duration 0.5 s, deltas 0.05 s and 0.25 s.
- `calcGlobalOrientation`: a histogram peak refined by a recency-weighted mean.
- **Where we differ on purpose:** we store time *since* last motion and advance it by
  the media-time step each frame, instead of absolute time. Absolute media time needs
  a 32-bit float target to resolve milliseconds an hour into a video; half floats,
  the fallback we must support, cannot. Age-since-motion fits half floats, resets
  cleanly on a seek, and is the same quantity the trail already keeps.

**Background model (feature 3)**
- What fits one or two float textures: a running average, a single Gaussian (mean and
  variance), Σ-Δ, and CNT. MOG2 (5 modes), KNN (21 samples), GMG (64-bin histogram),
  GSOC, LSBP and ViBe (20 samples) do not.
- Update rules read: VSAM `B ← αB + (1−α)I` and a threshold image updated the same
  way, both only where the pixel is not moving. MOG2 updates only the matched mode,
  `var ← var + k(d² − var)`, clamped to [4, 75] in 8-bit units, initial 15.
- **Gating.** ViBe warns that updating only where the model itself says "background"
  gives deadlocks and everlasting ghosts, while a blind update absorbs slow targets.
  VSAM gates on the frame-difference mask instead: a stopped object or a ghost shows
  no frame difference, so it is absorbed. We adopt that.
- For variable frame intervals, `α = 1 − exp(−dt/τ)`. MOG2's default history
  corresponds to about 17 s at 30 fps.
- Shadow test (MOG2/KNN), for later: brightness ratio between 0.5 and 1 with a small
  chroma distance.

### Known artifacts (for the help text)
- **Frame differencing:** only the leading and trailing edges of a uniform object
  show; a stopped object vanishes; a large gap shows two copies; motion toward the
  camera is weak.
- **Three-frame:** the gap must match the object's speed; slow or large objects come
  out hollow.
- **Background model:** fast objects leave short trails; stopped objects, and ghosts
  where a parked object left, fade in over time; centres of large slow objects fade;
  an object present at the start leaves a ghost; a sudden lighting change reads as
  foreground; objects the colour of the background are missed.
- **Motion history:** no motion inside silhouettes; direction is normal to the edge
  and carries no speed.

## 3. Eulerian video magnification

### Sources
- Wu et al., SIGGRAPH 2012, paper and errata: https://people.csail.mit.edu/mrub/papers/vidmag.pdf
- Project page and its LICENSE.pdf: https://people.csail.mit.edu/mrub/evm/
- Phase-based magnification: https://people.csail.mit.edu/nwadhwa/phase-video/
- Riesz pyramids: https://people.csail.mit.edu/nwadhwa/riesz-pyramid/
- MIT Technology Licensing Office listings: https://tlo.mit.edu/industry-entrepreneurs/available-technologies/eulerian-video-magnification-revealing-subtle-changes
- Patent US 9,811,901: https://patents.google.com/patent/US9811901B2/en
- https://github.com/antimatter15/evm — browser JS on the CPU. MIT.
- https://github.com/tschnz/Live-Video-Magnification — C++/OpenCV/Qt. AGPL-3.0 or commercial (do not copy).
- https://github.com/MrMoDDoM/RT-EVM-JS — OpenCV.js on the CPU. MIT.
- READMEs only: brycedrennan/eulerian-magnification (MIT), chrdiller/VideoMagnification (GPLv3), hiszpanski/evm (GPL-3.0), hbenbel/Eulerian-Video-Magnification (MIT).
- https://news.ycombinator.com/item?id=24362525 — practitioner reports.

No WebGL or Shadertoy implementation turned up in three searches. Every browser
implementation found runs on the CPU.

### What others do differently
- **Spatial decomposition.** The paper uses a full Laplacian pyramid for motion, and
  heavy low-pass plus downsampling for pulse. Ports use 3–5 levels and zero the
  finest level. Our single 1–4× box pool is the main gap.
- **Temporal filter.** The paper's real-time app uses the same "two first-order
  low-pass IIR filters" we do. One port uses raw per-frame coefficients (frame-rate
  dependent); another uses our mapping with a nominal fps. Our real-interval version
  is the most robust found.
- **Colour space.** YIQ, YCbCr or Lab, used only to attenuate chroma, as our Rec.709
  split does.
- **Amplification limit.** The paper bounds `(1 + α)·δ < λ/8` and reduces α below a
  cutoff wavelength λc. Ports implement it per pyramid level. We have none, so fine
  detail and noise are amplified as much as the signal.
- **Defaults.** Pulse: α 100, band 0.83–1 Hz. Motion: α 10–20, band 0.4–3 Hz.
  Ports default to α 20 at 1–5 Hz for motion and α 100 at 0.84–1.43 Hz for colour.
- **Practical reports.** Noise is amplified in proportion to α; the subject must hold
  still; turn auto-exposure off; lamp flicker interferes; "tuning parameters is hell".

### Should our code change
1. **Per-level amplification (roadmap, largest gain).** The EMAs are linear and
   per-pixel, so the current state textures can stay: mipmap the band texture and
   composite `Σ α_l · (level l − level l+1)` over 3–4 levels, zero the finest, apply
   the λc rule. This is a derivation, not something seen implemented, and float
   mipmaps in WebGL2 need a feature check. **Unverified.**
2. **Band-gain normalisation (decision needed).** A difference of two one-pole
   low-passes peaks at `(fH − fL)/(fH + fL)`: 0.48 at our defaults, so "amplify 15"
   is effectively about 7. Dividing by that factor would make the number mean the
   same at any band setting, but it roughly doubles the effect of every existing value.
3. **Pulse and motion presets, deeper pooling for pulse (roadmap).**
4. **Not worth it:** YIQ (no visible gain over the Rec.709 split), Butterworth
   biquads (awkward with a variable interval), phase-based or Riesz magnification
   (large shader and state cost, and a separate patent), stabilisation (document
   "use a tripod" instead).
5. **Already right:** both EMAs are seeded from the first frame and after a seek.

### Licensing and patents
This is a factual note, not legal advice.
- We use no MIT code. The MIT reference code is licensed for non-commercial research only.
- The *method* is patented: MIT lists US 9,811,901, 10,007,986 and 10,217,218 as
  available for non-exclusive licensing. Google Patents shows 9,811,901 as active
  with an adjusted expiry in January 2033. The claims were not read.
- Patents cover the method regardless of whose code implements it, and the
  open-source ports grant no patent rights. Magnify mode is fine for personal and
  research use of this demo; anything commercial is a question for MIT's licensing
  office or a lawyer.

## 4. GPU optical flow

### Sources
- https://github.com/anvaka/oflow — CPU Lucas-Kanade on zones. MIT.
- https://github.com/moostrik/ofxFlowTools — single-pass normalised gradient. MIT.
- https://github.com/keeffEoghan/glsl-optical-flow — WebGL port of the same shader. MIT.
- https://github.com/cacheflowe/haxademic — same, with temporal smoothing. MIT.
- https://github.com/diwi/PixelFlow — same formula on Sobel textures. MIT.
- https://github.com/princemio/ofxMIOFlowGLSL — Benson-derived flow. No licence stated.
- https://cycling74.com/forums/sharing-new-distortions — the author describes the shader as an approximate Horn-Schunck, "good enough for experimental video".
- https://papadanku.github.io/blog/made/lucaskanade.html — dense Lucas-Kanade in HLSL.
- https://cs.brown.edu/courses/csci1290/2011/results/final/psastras/ — dense pyramidal iterative Lucas-Kanade in GLSL.
- https://derivative.ca/UserGuide/Optical_Flow_TOP — TouchDesigner; output in screen-widths per second, optional timestamps.
- https://github.com/Volcomix/optical-flow-web — Farneback in WebGL, work in progress. MIT.
- OpenCV `tracking.hpp`, `optflowgf.cpp`, videostab `global_motion.hpp`.
- Bouguet, pyramidal Lucas-Kanade: https://www.cs.ucf.edu/courses/cap4453/bouguetopticalflow.pdf
- DIS optical flow: https://arxiv.org/abs/1603.03590
- Sun, Roth, Black, "Secrets of Optical Flow": https://cs.brown.edu/people/dqsun/pubs/cvpr_2010_flow.pdf
- Stabilisation: https://learnopencv.com/video-stabilization-using-point-feature-matching-in-opencv/, https://nghiaho.com/?p=2093, https://arxiv.org/abs/1701.03572
- https://developer.mozilla.org/en-US/docs/Web/API/WebGL_API/WebGL_best_practices — asynchronous readback, float targets.

Unverified: Shadertoy shaders (403), the TouchDesigner algorithm, any integrated-GPU
performance figure. No source gave timings for our target hardware.

### Comparison for our constraints
| Approach | Passes | Notes | Fit |
|---|---|---|---|
| Single-pass normalised gradient (the widely copied shader) | 1 | Brightness difference steered along the gradient. Not pixel displacement; the aperture problem is unsolved | Trivial, but cannot give velocity or global motion |
| Dense Lucas-Kanade, one level | 1–2 | Real displacement, valid only below about 1 px | Too limited alone |
| Pyramidal Lucas-Kanade | about 1 per level | 2–4 levels; minimum eigenvalue gives a confidence; flat regions unreliable | Best fit; mipmaps supply the pyramid |
| Horn-Schunck | many | Fills flat regions; more noise-sensitive; iteration count needs tuning | Heavier to maintain |
| Farneback | many | 17–22 float channels per level | Too heavy |
| DIS | — | Fast on CPU; per-patch gradient descent | Poor fragment-shader fit |
| Sparse corners + pyramidal LK | — | Needs a CPU-side feature list | Use dense low-resolution flow instead |

### Recommended design (feeds the feature 4 design note)
- Dense pyramidal Lucas-Kanade on pre-blurred luma at 320×180, mip levels
  320/160/80, one warp-and-solve pass per level with a 5×5 window, plus one
  temporal smoothing pass.
- Confidence from the minimum eigenvalue of the 2×2 structure tensor.
- Store RG = displacement in pixels, B = confidence, in a half-float target.
- Pick the frame pair by media-time gap from the ring and divide by the real gap:
  velocity in px/s. A longer gap lifts slow motion above the noise; the shortest gap
  keeps fast motion inside the pyramid's range.
- Show as a hue wheel (direction) with value = magnitude × confidence, and a coarse
  arrow grid. No particles.
- Global motion: pool confidence-weighted flow to an 8×8 grid in a shader, read it
  back asynchronously, take the per-axis median on the CPU (optionally fit a
  4-parameter similarity). This is the same estimate camera compensation and a
  stabiliser need.
- Leave out: Farneback, DIS, Horn-Schunck, sparse tracking, homographies,
  rolling-shutter correction, and the Canvas2D path (status message instead).
- The Lucas-Kanade solve mirrors cleanly into `core/` and can be tested with
  synthetic shifted gradients.

## 5. UI library check: Tweakpane 4.0.5

Checked first-hand by building a pane in Chrome and inspecting it, not from documentation.
- **Keyboard: good.** Slider tracks are focusable and respond to arrow keys. Number
  fields step with the arrow keys, ×10 with Shift. Checkboxes, lists, buttons, folder
  headers and tabs are native elements.
- **Screen readers: weak.** The DOM has no ARIA attributes at all. Slider tracks are
  plain `div`s with no role or value. Inputs have no accessible name: labels are
  unassociated `div`s.
- **Focus visibility: weak.** The outline is suppressed; focus shows only as a
  subtle background change.
- **Theming:** about 30 CSS variables (`--tp-*`) cover colours, radius, font and spacing.
- MIT licence, no dependencies, about 150 kB minified.

How the gaps are covered: because the pane is generated from each mode's schema, a
small pass after building it sets `aria-label` on every control from its label,
gives slider tracks `role="slider"` with min, max and current value, and a stylesheet
restores a visible focus ring. Keyboard shortcuts cover the common adjustments
without entering the pane.
