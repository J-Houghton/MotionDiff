# Optical flow: design note

Status: **design only, nothing built.** Feature 4 of the session 3 plan. The method
was chosen in `docs/research.md` §4; this note turns it into a build plan against the
code as it stands after the motion mask, motion history and background model modes.

## What it adds
Motion history already shows a heading, but it reads it from the shape of a trail:
it needs about a second of history, it is only right averaged over a patch, and it
says nothing about speed. Flow measures, between two frames, how far and which way
each small patch of the picture moved. That gives:

- direction and **speed** per patch, from the first pair of frames;
- a **global motion** estimate (how the camera moved), which is what camera
  compensation and a stabiliser need. Every mode today fails on a moving camera
  (`highway` clip: the mask turns the tree line into blobs, history into confetti).

## Method
Dense pyramidal Lucas-Kanade on luma, at a fixed working size of 320×180 whatever
the processing width.

For a patch, Lucas-Kanade solves a 2×2 system: the spatial gradients of the image
(the structure tensor `[[ΣIx², ΣIxIy], [ΣIxIy, ΣIy²]]`) against how brightness
changed between the frames (`[ΣIxIt, ΣIyIt]`). It is only valid for motion under
about a pixel, so it runs coarse to fine: solve at 80×45, double the result, shift
the older frame by it, solve for what is left at 160×90, and again at 320×180. Four
pixels of motion at the top level is sixteen at full working size, about 32 px at
640 wide.

The smaller eigenvalue of the structure tensor says whether the patch had texture in
both directions. Where it is small (a flat wall, a straight edge) the answer is not
trustworthy: that number is the **confidence**, and it is kept beside the flow.

## Passes
All targets through `renderer.target()`, half float, unfiltered. Ask for targets
before binding textures (creating one binds it: this bit the mask mode).

| # | Pass | Size | Output |
|---|---|---|---|
| 1 | Luma of the current frame and of the frame one gap back, 3×3 blurred | 320×180, ×2 | R = luma |
| 2 | Box-reduce each to half and quarter size | 160×90, 80×45 | R = luma |
| 3 | Solve at 80×45: 5×5 window, start from zero | 80×45 | RG = flow, B = confidence |
| 4 | Solve at 160×90: sample the level above ×2, warp, 5×5 window, add | 160×90 | same |
| 5 | Solve at 320×180, likewise | 320×180 | same |
| 6 | Temporal smoothing: blend with the previous result by confidence | 320×180, ping-pong | same |
| 7 | Picture and data | processing size | hue = direction, brightness = speed × confidence |

Eleven draws on small targets; pass 5 is the largest at 57,600 pixels × about 60
fetches. By the measured cost of the history mode (a 640×360 Sobel plus pooling, 4 ms
a frame) this should sit near the other modes; measure before believing it.

Details that matter:
- The reduce in pass 2 is an explicit box average (as in `BOX_POOL_FRAG`), not
  `generateMipmap`: mip filtering differs between drivers and could not be mirrored.
- Warping samples the older frame at a fractional position. Mode targets are
  unfiltered, so the shader does its own bilinear blend of four `texelFetch` reads
  (the history mode's picture pass already does this).
- Textures are stored bottom-up. Write the flow in image coordinates (x right, y
  down), as the history mode writes its headings, and flip once in the shader.
- The frame pair comes from the ring by media time: `ring.nearest(lookbackTime(...))`
  with the mode's gap, and the result is divided by the real time between the two
  stamps: **pixels per second**, not per frame. A longer gap lifts slow motion out of
  the noise; a short one keeps fast motion within the pyramid's reach.
- Feedback state (pass 6) follows the history mode's pattern: two targets, a
  `WeakMap` of which is current, start over when `renderer.epoch` changes, and
  recompute rather than advance on a `repeat` frame.

## Core, tests, probe
`core/flow.js`, pure, importing nothing:
- `luma(frame, out)`, `halve(src, w, h, out)`: trivial, tested for edge handling.
- `lucasKanade(a, b, w, h, guess, window, out)`: one level, with the warp. Tests:
  a textured patch shifted by a known sub-pixel amount comes back within 0.1 px; a
  flat patch has zero confidence; a straight edge has low confidence (the aperture
  problem); a shift of 3 px at one level fails and the pyramid recovers it.
- `pyramidFlow(...)`: the three levels chained. Test on a synthetic frame pair moved
  by (6, −3) px.
- `globalMotion(flow, cols, rows)`: confidence-weighted median per axis.

Probe `__motionDiffFlowParity()`: two synthetic frames through both; flow within
0.05 px where confidence is above the display floor. Expect small differences from
half floats, as with the background model; the probe should count mismatches rather
than demand zero.

## Mode
`app/modes/flow.js`, one entry in `MODES`. `needsFloat: true`, `worker: false`
(status message on the fallback, as for the other new modes).
- Controls: Gap (shared), Smoothing (0 to 1 s), Confidence floor, Show (direction and
  speed / speed only), Arrows (a coarse grid drawn in the picture pass, optional).
- Data: `{ kind: 'vector' }`, R = speed normalised to a full-scale setting, G/B =
  velocity in px/s. `DATA_VIEW_FRAG` already draws a vector field.
- Sonification pools R like every other mode.

## Acceptance, written in advance
On `truth` (`scripts/truth-check.mjs` already measures a heading over a region):
- **Direction** within 10° of the known heading for the square (0°), the disc (30°)
  and the second disc (180°), taken over each object's own outline, from a single
  frame pair. Tighter than the history mode's 20° because nothing is inferred.
- **Speed** within 20% of the known 120, 104 and 100 px/s. Only the textured rim of
  these flat objects carries flow; if the interior is empty that is correct, and the
  confidence must say so.
- **Still background:** speed under 5 px/s over 99% of it; on `truth-noisy`, 95%.
- **Global motion** on `handheld`: the estimated camera shift, applied in reverse,
  must make Raw on the stabilised pair visibly darker than on the original pair
  (blind judge), and reduce its mean brightness by at least half.
- **Blind judge:** names what it shows that motion history does not (speed; heading
  without a trail).

If the interior of flat objects reads as noise rather than as "no confidence", fix
the confidence before anything else: a flow field that looks sure about a blank wall
is worse than none.

## Left out, on purpose
Farnebäck, DIS, Horn-Schunck, sparse corner tracking, homographies, rolling-shutter
correction, particles, and the Canvas2D path. Reasons in `docs/research.md` §4.

## Order of work
1. `core/flow.js` and its tests (one level, then the pyramid).
2. The mode with passes 1–5 and 7, the probe, the checks on `truth`.
3. Temporal smoothing (pass 6), judged as a visual change of its own.
4. `globalMotion` with an asynchronous 8×8 readback; the `handheld` check.
5. Only then, and as separate roadmap items: camera compensation as a pre-pass for
   the other modes, and the stabiliser.
