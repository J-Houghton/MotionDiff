# Motion-guided magnification: design note

Status: **built** (`magMode: 'motion'`, *Amplify: measured motion*). Verdict
V-6M in [verdicts.md](../verdicts.md).

Amplify small motions along their **measured** direction. The first Magnify
is Eulerian — it amplifies a
temporal band of brightness per pixel, which also amplifies sensor noise
and says nothing about direction. This adds a second way of magnifying:
the measured displacement itself is band-passed and exaggerated, so a
flank that swells by half a pixel is drawn swelling by ten, along the way
it actually moved.

## The method

Per frame, at flow's working size, using pieces that already exist:

1. **Velocity** — the shared stage (`stages.velocity()`), already smoothed,
   confidence-carried, and camera-compensated when that is on.
2. **Band-passed displacement** — two leaky integrators of velocity per
   pixel (RG float targets, ping-ponged exactly like magnify's EMAs, with
   the same two cut-offs the band sliders set):
   `D += v·dt − α·D`, once with the fast α and once with the slow; the
   band displacement is their difference. A drift or a constant pan
   leaves the band (both integrators follow it); a small oscillation in
   the band stays.
3. **Warp** — the output samples the current frame at
   `x − amp·d_band(x)` (backward warp, bilinear — the same shape as the
   camera stabilise pass, but by a per-pixel field). The warp is faded by
   flow's own presence channel, so nothing is warped where nothing was
   measured, and the displacement is capped (a quarter of the working
   cell count) so a flow error cannot smear the frame.

Core mirrors and checks, per the conventions: `bandDisplacement` and
`warpByField` join core/magnify.js and core/flow.js with unit tests, and a
parity probe (`__motionDiffMotionMagnifyParity`) runs synthetic fields
through both sides.

## Where it lives

A second option on the Magnify mode and a pill on the effect:
**Amplify: brightness changes / measured motion** (`magMode`). Brightness
stays the default and keeps the worker fallback; measured motion is
WebGL-only (it needs the flow solve) and says so there. The quiet gate
applies to the brightness mode only — the motion mode's own gate is flow's
presence.

## What it will and will not do (help text)

- A rhythm with no spatial movement (a brightness pulse) does not move:
  the motion mode shows little or nothing on it — that is the proof it
  amplifies motion, not change.
- Where flow measures nothing (flat interiors), nothing is amplified;
  edges and texture carry the effect.
- An occluding edge can smear: the warp has one layer, not an inpainting.

## Acceptance (V-6M, registered before building)

1. `kitten`: the breathing flank's edge visibly travels further in the
   motion mode than in the raw clip; a blind judge can tell the motion
   strip from the unamplified one and names the flank or chest as what
   moves.
2. `pulse` (brightness swings, nothing moves): the motion mode shows
   little or nothing where the brightness mode plainly shows the patch —
   the pair proves direction-measured motion is what is amplified.
3. Parity: the probe's shader-versus-core differences stay within the
   flow probes' tolerances; unit tests hold the integrator's band (a
   constant velocity decays, an in-band oscillation passes).
