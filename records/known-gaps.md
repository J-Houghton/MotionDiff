# Known gaps and deferred items

Status: reference, as of version 1.0 (November 2026). The detailed list of
what is known not to work well, and of ideas that were set aside with the
reason. The short [roadmap](../ROADMAP.md) carries the headline items; IDs
such as V-6T point into the [verdict log](verdicts.md).

## Known gaps
- Counting miscounts packed traffic, and the count line cannot be started on
  a phone: both are described in the [roadmap](../ROADMAP.md).
- **Naming on a CPU rung is thin**: at a look every second or two, names
  arrive for track ids the tracker has already dropped (about 2% of drawn
  boxes named) and model-only finds are not drawn at all. On a GPU rung
  about a quarter of boxes are named; more than half of all motion boxes
  touch nothing the model detects.
- Each effect in `src/app/effects.js` lists `controls` to show beside its
  choices, and `effectControls()` resolves them, but the interface never
  calls it: those settings are reached from the time ruler and the
  parameter panel only.
- Naming on an integrated GPU costs frame rate: 24 fps against 30 on the test machine.
- A look that hangs after a model is ready (no answer, no error) is not
  detected for either model; with naming and depth both on, two versions
  of the runtime are downloaded and run.
- Mirror mode and pinch zoom are confirmed working on a phone (November
  2026). iOS Safari exposes no zoom control.
- Motion magnification turns fine repeated texture (fur) painterly: the field
  measures its real micro-shimmer; coherent large-scale motion suffers least
  (V-6M). A coherence gate is the next idea if it matters in use.
- Tracking IDs churn on the far field of a busy road; congestion is boxed per
  merged clump (V-6T).
- Calibration is true at the marked line's depth only, and its entry points
  (C, the margin link) failed a first-time discoverability test before the
  link existed; not tested since.
- The filmstrip tool: a synthetic scene rendered after a real-clip scene in
  one run can differ slightly from the same scene rendered alone (reproduced
  on old master; compare strips from runs with the same scene order).
- **Schlieren live on a phone does not work well yet** (first try on a phone): the preset clips work there, the live camera gives a flat grey picture, which means nothing could be measured (a plain background or a moving phone are the likely causes; not diagnosed). The setup guide built for this (IA5) has not been tried on a phone since.
- **Frame rates on a real phone have not been measured.** The app runs on
  phones, but frame-rate figures are from one desktop GPU. Schlieren has been checked on synthetic scenes and
  two recordings from the web, not on phone footage, weak sources or natural backgrounds.
- A fine regular pattern on a screen is a poor schlieren background, and unusable below
  a 1280 px processing width.
- Plain (uncoloured) traces do not show which way they run in a still picture.
- Optical flow: ragged outlines on movers; nothing measured along the middle of a
  straight edge or on flat surfaces; a moving camera makes everything flow.
- Blind-judged in headless Chrome, with phone and tablet layouts under device
  emulation and Chrome's fake camera. Real phones and a real camera work with the deployed
  site. Not tested: Firefox, Safari.
- Motion history: a hatched patch at the tail of a flat, round object's trail, and
  hue that drifts across a trail wider than 56 px.
- Background model: ragged edges while something is being absorbed; soft, blobby
  cut-outs on real footage.
- Motion mask on a moving camera: scenery turns into blobs unless *Steady
  camera* (`cameraComp`) is on.
- Colour-by-age "mixed": motion that pauses briefly and restarts reads pink where the
  old ring showed orange.
- On a phone held upright, a landscape clip is shown whole and small (a double tap
  fills the screen and crops it); rotating the phone is the better answer.
- Stepping backwards past the frame ring, or scrubbing far while paused, shows a
  blank frame until playback or a forward step rebuilds history.

## Deferred, and why
| Item | Why |
|---|---|
| Magnify: band-gain normalisation | Decided against: it changes what existing amplification values look like |
| Budgeted ring for an exact colour-by-age match | The blind judge calls the feedback version the same look, with a hue caveat (verdict V1). Build it only if that caveat matters in use |
| Luma-only branch | No visible effect of its own; a speed measure. Revisit if a phone needs it |
| Centred three-frame variant | Costs a gap of latency; the causal form passes its checks |
| Worker fallback for the mask, history and background modes | No effect where WebGL2 exists; those modes report that they cannot run |
| Automatic per-frame threshold from a noise model on the GPU | Superseded by item 2 (the per-pixel noise threshold, `maskAuto`) |
| Sparse optical flow | Dense low-resolution flow is the better fit for WebGL2, and is built |
| Plain traces that show which way they run in a still picture | Tried with a tinted tail; a blind judge could not tell (the optical-flow section of the verdict log). Heading colours do it |
| Temperature or density values from schlieren | Needs calibration and tomography; the picture is the product |
| Worker fallback for optical flow and schlieren | As for the other WebGL-only modes |
| Per-vehicle separation inside a merged mask clump | Needs a measurement the mask does not make (a flow-direction split); tracking boxes congestion per clump today (V-6T) |
| Compression motion vectors | |
| Phase-based / Riesz magnification | Large shader cost and a separate patent |
