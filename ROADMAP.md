# Roadmap

Status of everything planned for MotionDiff. Updated at the end of every working
session. Statuses: **done**, **in progress**, **planned**, **deferred**.

Last updated: 2026-11-13 (end of session 3: new interface, three new modes, visual
tooling).

The governing rule for every item: lightweight, and easy to maintain and debug by hand.
Visual work is accepted under the rules in `CLAUDE.md`; results are logged in
`docs/verdicts.md`.

## Planned, in order
Ranked by visible effect for the effort. "Visible effect" is what a blind judge should
be able to see, and on which reference clip (`scripts/README.md`); an item with none
is deferred, not planned.

| # | Item | Expected visible effect, and on what footage | Effort | Notes |
|---|---|---|---|---|
| 1 | Frozen reference frame ("difference from this moment") | Everything that changed since the pin stays lit, however slowly it changed: the whole cloud bank on `sunset`, where Raw at any gap shows thin edges | Small | One pinned ring layer and a key to pin |
| 2 | Direction legend and second-gap marker | A hue wheel in the picture corner makes the history view readable without the help text; the ruler shows the mask's second gap and the history length | Small | Interface only; `traffic`, any clip |
| 3 | Dense optical flow | Speed and heading per patch from one frame pair: on `truth`, the square and discs in three hues with brightness by speed; no trail needed | Large | Design in `docs/optical-flow.md`, with acceptance numbers |
| 4 | Global-motion estimate, then camera compensation | On `handheld` and `highway` the scenery goes dark and only real movers remain, in every mode. Today those clips light up everywhere | Medium, after 3 | 8×8 pooled flow, median on the CPU |
| 5 | Per-pixel noise threshold | On `night` and `truth-noisy` the mask is clean without touching the threshold; today it needs Auto-configure or a hand-set value | Medium | Threshold from the background model's variance, ×√2 for a difference |
| 6 | Combining several frame gaps | On `traffic`, the slow far carriageway and the fast near one both show fully at one setting | Medium | Maximum over two or three gaps |
| 7 | Magnify: per-level amplification | On `face`, the pulse shows as a colour change of the skin without the amplified edges and noise the single band gives | Medium-large | Biggest quality gain found in research |
| 8 | Lighting normalisation (gradient-image differencing) | On `sunset`, and on a camera with auto-exposure, a brightness change no longer lights the whole frame | Medium | |
| 9 | Morphological open and close | On `traffic`, mask and background-model cut-outs lose their holes (windscreens) and ragged rims | Small-medium | The 3×3 vote already does the cheap part |
| 10 | Real-time stabiliser | `handheld` plays back steady | Medium, after 4 | |
| 11 | Magnify: pulse and motion presets, deeper pooling | On `face`, one click gives a visible pulse | Small | |
| 12 | The time ruler in the Viewfinder layout | Gap and trail read as a ruler in fullscreen and on phones, as on the Plate | Small | From the interface critique: the two layouts share too little |

## Deferred
| Item | Why |
|---|---|
| Magnify: band-gain normalisation | Owner's decision (session 3). Changes what existing amplification values look like |
| Budgeted ring for an exact colour-by-age match | The blind judge calls the feedback version the same look, with a hue caveat (`docs/verdicts.md`, V1). Build it only if that caveat matters in use |
| Luma-only branch | No visible effect of its own; a speed measure. Revisit if a phone needs it |
| Centred three-frame variant | Costs a gap of latency; the causal form passes its checks |
| Worker fallback for the mask, history and background modes | No effect where WebGL2 exists; those modes report that they cannot run |
| Automatic per-frame threshold from a noise model on the GPU | Superseded by item 5 |
| Sparse optical flow | Dense low-resolution flow is the better fit for WebGL2 |
| Blob extraction and tracking | |
| Compression motion vectors | |
| YOLO proof of concept | Run on the original frame, not on diff output; combine with motion in data |
| Audio engine improvements | Keep it working, do not extend it |
| Phase-based / Riesz magnification | Large shader cost and a separate patent |

## Done
### Session 3
| Item | Commit | Notes |
|---|---|---|
| Acceptance rules and decisions recorded | `f5ed9a0` | `CLAUDE.md` |
| Mode registry with data outputs; session module; new interface (Plate and Viewfinder, light and dark, phone layout); Tweakpane panel from mode schemas with the ARIA and focus patch; keyboard map; old UI, Pickr and accent themes removed; phone defaults; no-float fallback exercised | `2414314` | |
| Visual tooling: reference clips, filmstrips, numeric guard, interface audit, checks against known truth | `cd98ae7`, `a0ff53c` | `scripts/README.md` |
| Colour-by-age: both looks from the feedback buffer | `cd98ae7` | V1. Same look as the old ring, with a hue caveat |
| Interface fixes from the blind critique | `d524b4c` | 23 states audited; fresh critic passes all seven rules |
| Motion mask mode (three-frame differencing, pre-blur, 3×3 vote) | `a0ff53c` | V2 |
| Motion history mode (age and direction) | `e27ae6e` | V3 |
| Background model mode (running mean and variance, gated by motion) | `9015be5` | V4 |
| Optical flow design note | with this roadmap update | `docs/optical-flow.md` |

### Sessions 1 and 2
| Item | Commit |
|---|---|
| GPU capture and texture-array frame ring (192 MiB budget, 120 frames max) | `f2b46cc` |
| Media-time base for gap and spread | `e4fe723` |
| Shared unsigned motion magnitude | `b9080f8` |
| Worker-owned frame store on the fallback | `10289a1` |
| Auto-configure from frame bursts | `6e2166c` |
| Magnify: box pooling into float | `2667239` |
| One threshold unit; shader/core parity probes | `0c5f36c` |
| Time-based trails, single feedback buffer | `a0d84f9` |
| Performance baseline against master (1080p: about 53 ms to 12.5 ms a frame) | session 2 report |
| Research write-up, design mockups | `3922a07` |

## Known gaps
- Verified in headless Chrome on one Windows machine with an Intel GPU only, with
  phone and tablet layouts under device emulation and Chrome's fake camera. Not
  tested: a real phone, a real camera, Firefox, Safari, screen capture, HLS.
- Motion history: a hatched patch at the tail of a flat, round object's trail, and
  hue that drifts across a trail wider than 56 px.
- Background model: ragged edges while something is being absorbed; soft, blobby
  cut-outs on real footage.
- Motion mask on a moving camera: scenery turns into blobs (item 4 is the fix).
- Colour-by-age "mixed": motion that pauses briefly and restarts reads pink where the
  old ring showed orange.
- On a phone held upright, a landscape clip is shown whole and small (a double tap
  fills the screen and crops it); rotating the phone is the better answer.
- Stepping backwards past the frame ring, or scrubbing far while paused, shows a
  blank frame until playback or a forward step rebuilds history.
