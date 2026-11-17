# Camera compensation: design note

Status: **built** (`cameraComp`, *Steady camera* in the panel's Look folder).
Verdict V-6C in [verdicts.md](../verdicts.md).

Estimate the camera's own motion each frame and subtract it, so that on
footage from a moving camera the scenery stops reading as motion and only
real movers remain. It waited for the shared stages
([pipeline-stages.md](pipeline-stages.md)). Expected effects were registered
in the verdict log (V-6C1..V-6C4) before building, as the
[acceptance rules](../acceptance.md) require.

## What is estimated

A 4-parameter similarity per frame — translation, scale, rotation about the
picture centre — fitted to the flow field. Translation covers pan and tilt
jitter (`handheld`, `highway`); the scale term covers a camera moving forward
(`river`), which reads as radial expansion no translation can cancel.

- The field: a solve at the flow working size between now and the frame one
  flow gap back, **ungated and unsmoothed** (the gate deliberately removes
  the still ground, which is exactly what the camera is read from; smoothing
  would lag a jitter estimate).
- The fit (`core/flow.js fitSimilarity`): confidence-weighted least squares
  of v = t + a·(p − c) over the cells of the reduced readback, where a
  packs scale and rotation; then the worst third of residuals is dropped and
  the fit repeated once, so movers crossing the frame do not drag it. Cells
  are in picture pixels per second.
- The trajectory: per-frame velocities are integrated into a cumulative
  camera position (x, y, log-scale, angle) stamped like the frame ring, so
  a mode comparing across any gap warps by the difference of the two
  stamps' positions, not by an assumed constant velocity. Cleared with the
  renderer epoch; frames before the first estimate warp by nothing.

## Where it is applied — one place per kind of consumer

`cameraComp` is one global toggle, off by default, surfaced as *Steady
camera* in the panel. All wiring lives in the stage layer:

- **Differencing (Posy, Raw, mask, and so history and the background feed).**
  A `stabilised(layer, stamp)` stage renders the ring layer into a 2D
  scratch target, resampled by the similarity between that stamp and now
  (manual bilinear — the ring is unfiltered — with each sample rounded back
  to whole 0..255 levels, so the integer discipline the mask shaders share
  with the core survives). The difference shaders gain a uniform switch:
  read the older frames from the warped 2D textures instead of the ring.
  Core mirror: `warpFrame` in `core/flow.js`, same rounding, unit-tested;
  the probes keep passing because the switch defaults off.
- **Optical flow.** The camera's similarity field (evaluated per cell from
  the same fit) is subtracted from the velocity field before gating and
  smoothing; one small pass with four uniforms.
- **Readings.** `camera` on `pipeline.readings` now reports the fit
  (including scale and rotation) rather than the median alone.

## Deliberately out of scope, and why

- **Magnify** amplifies against its own temporal filters; warping its input
  per frame would smear the band. It keeps requiring a steady camera.
- **Schlieren** already holds or follows a reference and reports camera
  steadiness; its own mechanism stays.
- **The background model's compare** is against a long-lived model image,
  not a ring frame; under sustained camera motion the model itself drifts.
  Compensation reaches the background mode only through its learning feed
  in this pass; warping the model is a later piece.
- **The stabiliser** (playback that holds still) is a separate idea and
  is not built.

## The guards the still-camera check forced

The first build failed its own acceptance: on a still camera the fit
random-walked on sensor noise and compensation *invented* motion. Three
guards, all in `stages.camera()`:

- the fit speaks only when at least a quarter of the field carries trusted
  flow (share is pre-trim support);
- below a stillness dead band (2 % of the width per second, counting the
  zoom and rotation terms at the frame edge) the camera reads as zero —
  the readings line holds the same rule;
- a solve across more than half a second of thinned ring is refused.

With them, `truth` renders byte-identically on and off, and `highway`'s
near-still camera is read as still instead of being "compensated".

## Cost

When `cameraComp` is on in a mode that did not solve flow, the solve now
runs each frame (the dominant cost of the flow mode). In flow mode the
solve for the estimate is separate from the view's own (distinct targets);
sharing them is a later optimisation if the frame times ask for it.

## Acceptance (V-6C1..V-6C4)

1. `handheld` + Raw: scenery cancels, the marching crowd remains.
2. `highway` + mask: the road's speckle gone, vehicles still cut out.
3. `river` + flow colour: the banks go dark (zoom term); the water keeps
   its flow.
4. `truth` (still camera), every touched mode: compensation on changes
   nothing — the fit reads zero; strips identical within the guard.
