# Roadmap

Status of everything planned for MotionDiff. Updated at the end of every working
session. Statuses: **done**, **in progress**, **planned**, **deferred**.

Last updated: 2026-11-14 (session 5. Session A small tier: display work — legend,
ruler, paused traces, arrows, mirror, setup guide. Session B small tier: flow
readouts, too-fast warning, JSDoc type check, magnify sample).

The governing rule for every item: lightweight, and easy to maintain and debug by hand.
Visual work is accepted under the rules in `docs/development.md`; results are logged in
`docs/verdicts.md`.

The project is no longer only motion differencing. Work is listed under three heads:
- **Motion extraction**: measuring what moved (differencing, masks, models, flow).
- **Visualisations**: ways of showing a measured field.
- **Applications**: a measurement put to a particular use.

"Expected visible effect" is what a blind judge should be able to see, and on which
reference clip (`scripts/README.md`); an item with none is deferred, not planned.

## Applications
| Item | Status | Expected visible effect, and on what footage | Effort | Notes |
|---|---|---|---|---|
| Schlieren: hot air and gas made visible | **done**, session 4 | A candle plume appears where the video shows a still background (`candle-dots`, `plume`) | | `docs/schlieren.md`, verdict V7 |
| Schlieren on a real phone, and on the owner's footage | **in progress** | The same, live from a phone camera; weak sources (a mug, a heater); natural backgrounds; a held reference | Small once footage exists | Waiting for the footage listed in `docs/schlieren.md` and for a deploy to test on a phone. Defaults (window, smoothing, sensitivity) may need tuning for phone noise and compression |
| Schlieren: a step-by-step setup guide in the picture | **done**, session 5 (Session A) | First-time users reach a working setup without the help sheet: background, steady camera, settle, hold | | Verdict IA5. A checklist card with live state dots from `pipeline.readings`; the live wiring waits on Session B's readings landing in master |
| Mirror: the front camera flipped like a mirror, fullscreen | **done**, session 5 (Session A) | An installation where viewers see their own motion | | Verdict IA4. Display-only flip; the legend flips with it. Needs the owner's phone |
| Camera zoom by pinch (owner's request) | **done**, session 5 (Session A) | Two fingers zoom the camera where the driver allows it | | In IA4. iOS Safari exposes no zoom control; needs the owner's phone |
| Schlieren: speed of the plume from a space-time slice | planned | On `candle-dots`, where frame-to-frame tracking shows nothing, a number or a slope for how fast the plume rises | Medium | The literature finds this better than frame matching at 30 fps. Would replace the experimental traces view on real footage |
| Camera compensation (global motion, then subtract it) | planned | On `handheld`, `highway` and `river` (whose camera moves forward, as flow revealed) the scenery goes dark and only real movers remain, in every mode | Medium | The flow and its median shift exist; needs a zoom term for `river` |
| Real-time stabiliser | planned, after compensation | `handheld` plays back steady | Medium | |
| Sonification | done; **deferred** beyond keeping it working | | | Could be driven by flow speed and heading |

## Visualisations
| Item | Status | Expected visible effect, and on what footage | Effort | Notes |
|---|---|---|---|---|
| Particle traces (wind-map display) | **done**, session 4 | Streams that show direction and speed at a glance: two opposed streams on `traffic` | | `docs/particles.md`, verdict V6 |
| Traces keep flowing while the video is paused | **done**, session 5 (Session A) | A paused frame shows the streamlines of that instant, like a wind map of one moment | | Verdict VA1; `docs/particles.md` on what the paused picture means |
| Direction legend | **done**, session 5 (Session A) | A hue wheel in the corner makes heading colours readable without the help text (flow, history, schlieren direction) | | Verdict IA2 |
| Traces drawn at display resolution | planned | Crisp hair-lines on a large screen instead of soft ones | Small-medium | Today they are drawn at the processing size |
| Asynchronous readback of the particle field | planned only if a phone needs it | No visible effect; a frame-rate measure | Small | The one per-frame readback; fine on desktop, unmeasured on phones |
| Second-gap marker on the time ruler | **done**, session 5 (Session A) | The ruler shows the mask's second gap and the history length | | Verdict IA3 |
| The time ruler in the Viewfinder layout | **done**, session 5 (Session A) | Gap and trail read as a ruler in fullscreen and on phones, as on the Plate | | Verdict IA3 |
| A sample clip for Magnify that is not a face | **done**, Session B | A locked-off shot of something nearly still with a small rhythm (a sleeping animal breathing, a slight sway) opens in Magnify and shows it | | *Sleeping Kitten* sample and `kitten` reference clip, V-B3 |
| Arrow grid for flow | **done**, session 5 (Session A) | Signed direction readable from one still, which particles were judged not to give | | Off the deferred list at the owner's decision. Verdict VA2 |

## Motion extraction
Ranked by visible effect for the effort.

| # | Item | Status | Expected visible effect, and on what footage | Effort | Notes |
|---|---|---|---|---|---|
| | Dense optical flow | **done**, session 4 | Speed and heading per patch from one frame pair | | `docs/optical-flow.md`, verdict V5 |
| 1 | Frozen reference frame ("difference from this moment") | planned | Everything that changed since the pin stays lit, however slowly it changed: the whole cloud bank on `sunset` | Small | One pinned ring layer and a key to pin. Schlieren's held reference is the same idea for shifts |
| 2 | Per-pixel noise threshold | **done**, Session B | On `night` and `truth-noisy` the mask is clean without touching the threshold | | `maskAuto` on the mask mode, V-B7; the bar scales with the pre-blur |
| 3 | Combining several frame gaps | planned | On `traffic`, the slow far carriageway and the fast near one both show fully at one setting; in flow, slow and fast motion in one picture | Medium | Maximum over two or three gaps |
| 4 | Magnify: per-level amplification | planned | On `face`, the pulse shows as a colour change of the skin without the amplified edges and noise | Medium-large | Biggest quality gain found in research |
| 5 | Lighting normalisation (gradient-image differencing) | **done**, Session B (mask mode) | On `sunset`, and on a camera with auto-exposure, a brightness change no longer lights the whole frame | | `maskGradient` on the mask mode, V-B8 (21% → 1% on `sunset`). Bringing it to schlieren stays open |
| 6 | Morphological open and close | **done**, Session B (close; the vote already removes salt) | On `traffic`, mask and background-model cut-outs lose their holes and ragged rims | | `maskFill` on the mask and background modes, V-B5 |
| 7 | Magnify: pulse and motion presets, deeper pooling | planned | On `face`, one click gives a visible pulse | Small | |
| 8 | Flow at moving edges | planned | The ragged outlines of movers in the flow colour view become clean | Medium | A median or an edge-aware window |

### Session B (measurement; branch `session-b-measure`)
| Item | Commit | Notes |
|---|---|---|
| Live readouts from the flow field (dominant heading, peak speed, share moving, camera motion) on the status line and as data (`pipeline.readings`); warning when motion is beyond the gap's reach | `289d17a` | V-B1 |
| Type checking through JSDoc: `npm run typecheck` holds the mode contract, worker messages and params to their typedefs | `a24f191` | V-B2 |
| Schlieren publishes its setup judgement as data (`pipeline.readings.setup`), for Session A's in-picture setup guide | `2f6520c` | |
| Magnify sample that is not a face: *Sleeping Kitten*, plus the `kitten` reference clip | with this update | V-B3 |
| History ribbons in measured flow colours (`historyShow: 'measured'`) | `5ab27a9` | V-B4 |
| Fill holes in mask and background cut-outs (morphological close, `maskFill`) | with this update | V-B5 |
| Flow gated by the mask or the background model (`flowOnly` on Optical flow) | with this update | V-B6; the gates' limits are in the help sheet |
| Per-pixel noise threshold (`maskAuto` on the mask mode) | with this update | V-B7 |
| Lighting normalisation (`maskGradient`: edge differencing on the mask mode) | with this update | V-B8 |

## Deferred
| Item | Why |
|---|---|
| Magnify: band-gain normalisation | Owner's decision (session 3). Changes what existing amplification values look like |
| Budgeted ring for an exact colour-by-age match | The blind judge calls the feedback version the same look, with a hue caveat (`docs/verdicts.md`, V1). Build it only if that caveat matters in use |
| Luma-only branch | No visible effect of its own; a speed measure. Revisit if a phone needs it |
| Centred three-frame variant | Costs a gap of latency; the causal form passes its checks |
| Worker fallback for the mask, history and background modes | No effect where WebGL2 exists; those modes report that they cannot run |
| Automatic per-frame threshold from a noise model on the GPU | Superseded by item 5 |
| Sparse optical flow | Dense low-resolution flow is the better fit for WebGL2, and is built |
| Plain traces that show which way they run in a still picture | Tried with a tinted tail; a blind judge could not tell (`docs/verdicts.md`, session 4). Heading colours do it |
| Temperature or density values from schlieren | Needs calibration and tomography; the picture is the product |
| Worker fallback for optical flow and schlieren | As for the other WebGL-only modes |
| Blob extraction and tracking | |
| Compression motion vectors | |
| YOLO proof of concept | Run on the original frame, not on diff output; combine with motion in data |
| Audio engine improvements | Keep it working, do not extend it |
| Phase-based / Riesz magnification | Large shader cost and a separate patent |

## Done
### Session 5 — Session A (Display)
Branch `session-a-display`; verdicts under "Session A (Display)" in `docs/verdicts.md`.

| Item | Verdict | Notes |
|---|---|---|
| On-screen button for split compare | IA1 | Transport on desktop; top action plate on phones |
| Direction legend (hue wheel) | IA2 | `ui/legend.js`; matches the shaders' hue() |
| Time ruler: second gap, history length, ruler in the Viewfinder | IA3 | Markers rebuilt as 44 px phone hit boxes |
| Traces keep flowing while paused | VA1 | Streamlines of the paused instant; `Session.pausedFlow` keeps tooling deterministic |
| Arrow grid for flow | VA2 | Owner's decision, off the deferred list |
| Mirror mode; camera zoom by pinch | IA4 | Needs the owner's phone |
| Schlieren setup guide in the picture | IA5 | Live wiring waits on Session B's `pipeline.readings` in master |
| This machine's tooling | — | Headless Chrome on WSL2 needs `--enable-unsafe-swiftshader` (a wrapper outside the repo); software GL, so timings here are not comparable |

### Session 4
| Item | Commit | Notes |
|---|---|---|
| Optical flow: Lucas–Kanade core, shader mirror, probe, mode with colour and particle views; particle traces | `578ec21` | V5, V6 |
| Schlieren mode; synthetic plume scenes with a known field; two real candle clips in the reference set; printable background pattern | `7687582` | V7 |
| Fixes from the blind judges and the interface audit; schlieren probe | `2fc96fd` | I2 |
| Research notes §6 and §7, design notes for particles and schlieren, optical-flow note brought up to date | `c0095c2` | |
| Schlieren's knife-edge view always shown on its own (laid over the video it looked like a plain camera) | `e481f4b` | From the first try on a phone |
| Samples that open in a mode: eight new, among them a real candle plume for Schlieren | branch `demo-clips` | Each checked in its mode from a filmstrip; six added to the reference clips. Magnify has none yet |

### Session 3
| Item | Commit | Notes |
|---|---|---|
| Acceptance rules and decisions recorded | `f5ed9a0` | Now in `docs/development.md` |
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
- **Schlieren live on a phone does not work well yet** (owner's first try, session 4): the preset clips work there, the live camera gives a flat grey picture, which means nothing could be measured (a plain background or a moving phone are the likely causes; not diagnosed). The setup guide under Applications is the next step.
- **Frame rates on a real phone have not been measured.** Frame-rate
  figures are from one desktop GPU. Schlieren has been checked on synthetic scenes and
  two recordings from the web, not on phone footage, weak sources or natural backgrounds.
- Schlieren traces show nothing on the real candle recording (too fast between frames
  at 30 fps); the view is labelled experimental.
- A fine regular pattern on a screen is a poor schlieren background, and unusable below
  a 1280 px processing width.
- Plain (uncoloured) traces do not show which way they run in a still picture.
- Optical flow: ragged outlines on movers; nothing measured along the middle of a
  straight edge or on flat surfaces; a moving camera makes everything flow.
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
