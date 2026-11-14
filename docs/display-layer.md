# Crisp drawing layer at display resolution: design note

Status: **designed** (session 5, Session A); not yet built. Roadmap: "Traces drawn at
display resolution — crisp hair-lines on a large screen instead of soft ones", and the
owner's instruction to move the arrows onto the same layer.

## The problem
The canvas backing store is the processing size (`setSize` makes canvas.width the
processing width, e.g. 640×360) and CSS stretches it to the frame. Everything measured
is computed at that size — right for measurement, wrong for line work: traces and
arrows are 1-px lines rasterised at 640 wide and then blown up to a 2560-px display,
so a hairline arrives as a 4-px smear. V6 logged it; a large screen makes it worse.

## Choice: one canvas at display resolution, lines drawn last
Two architectures were considered:

1. **A second overlay canvas above the output** (the roadmap's phrasing). Leaves the
   renderer untouched, but splits the picture across two elements: recording
   (`CanvasRecorder` captures the one canvas) silently loses the traces, split compare
   needs the clip re-implemented per layer, Mirror needs the transform duplicated, and
   every future consumer must remember there are two pictures. Rejected: the hidden
   recording regression alone disqualifies it.

2. **The existing canvas, backed at display resolution.** The composite pass already
   samples textures with a fullscreen quad; drawing that quad into a display-sized
   backing is the same bilinear upscale CSS does today, so video and mode pictures look
   identical. Lines become crisp for free: their vertices already live in clip space
   (picture coordinates over `uPicture`), so the same geometry rasterised into the
   bigger viewport is exactly the hairline wanted. One picture, so recording, split,
   Mirror and fullscreen keep working unchanged — recordings actually improve, carrying
   display-resolution traces. **Chosen.**

## How it works
- **Sizes.** The renderer keeps `width`/`height` (processing, unchanged) and gains
  `canvasWidth`/`canvasHeight`: the canvas element's CSS box × devicePixelRatio, at the
  picture's own aspect, capped (2048 wide desktop, 1280 phone — the trail memory and
  fill-rate cap). The session owns the element and reports size changes
  (ResizeObserver → `pipeline.setCanvasSize`); below or equal to the processing size
  nothing changes, so the fallback and tiny windows cost nothing.
- **Modes are untouched.** `pictureFramebuffer`, `target(name, w, h)` and every
  measurement stay at processing size (Session B's contract). `renderComposite` only
  changes its final viewport.
- **The overlay pass.** `renderParticles` and `renderArrows` stop drawing into the
  picture target. Instead they keep their geometry (unchanged, picture coordinates)
  and their trail feedback ping-pong moves to canvas-sized targets; each registers an
  overlay for the frame. After `mode.render` returns, the pipeline asks the renderer
  to draw registered overlays onto the canvas — after the composite, so the lines are
  the last, sharpest thing drawn. Mode code keeps calling the same two functions with
  the same arguments.
- **Displays.** diff and overlay compose as today (the picture target holds black
  where only lines used to be, and the lines land on top). Glow is the one look that
  needs its own path: today the blur falls on the trail picture, traces included, so
  the overlay keeps a small blur pass of its own trail texture for the glow display —
  glowing and crisp. Judged against the current glow look on `clouds` (the one sample
  that ships with it).
- **Data display** never contained the lines; unchanged.

## Cost
Two RGBA8 trail targets at canvas size are the main memory: about 30 MB at 2048×1152,
about 9 MB at the phone cap. Fill rate: the composite quad and the fade pass run at
canvas size instead of processing size; at 1080p that is the cost the old CSS upscale
paid in the compositor instead. Measured before/after on this machine is meaningless
(software GL); the frame-rate check on a real phone goes to the owner's list.

## Acceptance (verdicts VA3, expectation before building)
- On a 2048-wide canvas, flow traces and arrows on `traffic` are hairlines: a blind
  judge shown before/after crops names the after as the sharper and finds the same
  geometry (same streams, same arrow directions and lengths).
- Video and mode pictures unchanged within the numeric guard at equal canvas size.
- Recording carries the crisp lines; split, Mirror, fullscreen unchanged.
- No regression at or below processing size (backing equals processing: pixels
  byte-identical to today).
