# Roadmap

Status of everything planned for MotionDiff. Updated at the end of every working
session. Statuses: **done**, **in progress**, **planned**, **deferred**.

Last updated: 2026-11-13 (end of session 2: checks, research, design exploration).

The governing rule for every item: lightweight, and easy to maintain and debug by hand.

## Foundations
| Item | Status | Notes |
|---|---|---|
| GPU capture and texture-array frame ring | done | `f2b46cc`. 192 MiB budget, 120 frames max |
| Media-time base for gap and spread | done | `e4fe723`. `core/timebase.js` |
| Time-based trails, single feedback buffer | done | `a0d84f9`. Look of colour-by-age changed; awaiting sign-off |
| Shared unsigned motion magnitude | done | `b9080f8`. `core/magnitude.js` |
| Worker-owned frame store on the fallback | done | `10289a1` |
| Auto-configure from frame bursts | done | `6e2166c` |
| Magnify: box pooling into float | done | `2667239` |
| One threshold unit; shader/core parity probes | done | `0c5f36c` |
| Performance baseline against master | done | See the session 2 report; 1080p went from ~53 ms to ~12.5 ms per frame |
| Research write-up | done | `docs/research.md` |

## Demo
| Item | Status | Notes |
|---|---|---|
| Design direction | in progress | Three mockups in `docs/design/`; waiting for a pick |
| Mode registry (one module plus one entry per mode) | planned | Each mode also exposes its result as data: a mask, a scalar field or a vector field |
| Tweakpane panel generated from mode schemas | planned | With the ARIA and focus-ring patch described in `docs/research.md` §5 |
| Shell: stage, split compare, transport, source picker | planned | Plain DOM unless Lit earns its place |
| Keyboard map for everything | planned | |
| Remove the old UI, Pickr and the accent themes | planned | Light and dark only |

## Conditioning (before differencing)
| Item | Status | Notes |
|---|---|---|
| Pre-diff blur | planned | Part of the motion mask mode |
| Luma-only branch | planned | Also wanted as "luma-first" for the RGB time-shift |
| Lighting normalisation or gradient-image differencing | planned | |
| Camera motion compensation | planned | Depends on the global-motion estimate |
| Frozen reference frame ("difference from this moment") | planned | Added from research; one pinned ring layer |

## Detection
| Item | Status | Notes |
|---|---|---|
| Three-frame differencing (motion mask mode) | planned | Feature 1. Causal `min(|cur−old1|, |cur−old2|)`; centred variant later |
| Per-pixel noise threshold | planned | From the background model's variance, scaled by √2 for a difference |
| Background subtraction | planned | Feature 3. Single Gaussian per pixel, update gated on the frame-difference mask |
| Combining several frame gaps | planned | |

## Mask cleanup
| Item | Status | Notes |
|---|---|---|
| 3×3 majority filter | planned | Added from research as the cheap first step |
| Morphological open and close | planned | |

## Temporal memory
| Item | Status | Notes |
|---|---|---|
| Motion history image with decay and direction | planned | Feature 2. Stores time since motion, not absolute time |

## Vectors
| Item | Status | Notes |
|---|---|---|
| Optical flow design note | planned | Feature 4. Dense pyramidal Lucas-Kanade at 320×180 |
| Dense optical flow | planned | After the design note is agreed |
| Sparse optical flow | deferred | Research: dense low-resolution flow is the better fit for WebGL2 |
| Global-motion estimate from flow | planned | Serves camera compensation and a real-time stabiliser |
| Real-time stabiliser | planned | |

## Magnify
| Item | Status | Notes |
|---|---|---|
| Per-level amplification (spatial split of the band) | planned | Biggest quality gain found in research |
| Band-gain normalisation | planned | Needs a decision: changes what existing amp values look like |
| Pulse and motion presets, deeper pooling | planned | |

## Deferred
| Item | Status | Notes |
|---|---|---|
| Blob extraction and tracking | deferred | |
| Compression motion vectors | deferred | |
| YOLO proof of concept | deferred | Run on the original frame, not on diff output; combine with motion in data |
| Audio engine improvements | deferred | Keep it working, do not extend it |
| Phase-based / Riesz magnification | deferred | Large shader cost and a separate patent |

## Known gaps
- Verified in headless Chrome on one Windows machine with an Intel GPU only. Not
  tested: Firefox, Safari, mobile, a real camera, screen capture, HLS.
- The fallbacks for GPUs without float render targets have not been exercised.
- Stepping backwards past the frame ring, or scrubbing far while paused, shows a
  blank frame until playback or a forward step rebuilds history.
