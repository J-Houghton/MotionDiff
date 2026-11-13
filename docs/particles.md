# Particle traces: design note

Status: **built** (session 4). A wind-map display for a velocity field: a few thousand
particles carried along by the measured flow, each drawing the path it took. Used by the
Optical flow mode and, experimentally, by Schlieren. Research in `research.md` §6;
results in `verdicts.md` V6.

This reverses a decision in `optical-flow.md`, which had ruled particles out.

## What the picture means
Stated here so that the help text, the code comments and the picture agree.

| Part of the picture | Is it a measurement? |
|---|---|
| The **direction** of a trace | Yes: the measured direction of movement at each point it passed |
| The **length** of a trace, at "True (1x)" speed | Yes: how far that point of the picture travelled while the trace was visible. At 2x to 8x the lengths are exaggerated by that factor; directions are unchanged |
| The **brightness** of a trace | Yes, loosely: faster is brighter, from a floor (so slow motion is still seen) up to the "Speed range" setting |
| The **colour**, with "By heading" | Yes: the heading, in the same hues as Motion history (right red, down yellow-green, left cyan, up violet) |
| **Where a trace starts** | No. Random |
| **How many traces** there are in a place | No. Particles that land where nothing is measured are moved on within about an eighth of a second, so traces gather on whatever moves. Density says "something is measured here", nothing more |
| An area **without traces** | Either nothing moves there, or nothing can be measured there (a flat surface) |

In flow-visualisation terms each trace is a short **pathline**: the path a point followed
through a field that changes every frame. A weather wind map draws **streamlines** of one
frozen field; the two are the same thing only when the field is steady.

### What the particles follow, in each use
- **Optical flow mode:** the velocity of the picture itself, in picture pixels per second
  of media time, measured between two frames a gap apart (`core/flow.js`), averaged over
  a fraction of a second, and only where the measurement is trusted. A trace on a car is
  the path of that patch of the car.
- **Schlieren mode:** *not* the shift that schlieren measures. That shift says where the
  air is unevenly hot; it is not a velocity, and traces along it would be a picture of
  nothing real. The traces follow how the **pattern** of shifts moves from one frame to
  the next: the travel of the eddies of hot air ("schlieren velocimetry" in the
  literature). That is a real measurement with known limits: it is slower than the air
  itself (published comparisons recover 30% to 100%), and there is nothing to follow
  where the flow is smooth. On the synthetic plume it reads 93% of the true speed and is
  within half a degree of the true heading. **On the one real candle recording tried it
  shows nothing**: filmed close up at 30 frames a second, the plume moves too far
  between frames to be followed. The view is labelled experimental for that reason.

Nothing in either mode is simulated: no buoyancy, no made-up drift.

## How it is built
- `core/particles.js` holds everything: `createParticles`, `stepParticles`,
  `sampleField`, `traceFade`, `particleCount`. Plain arrays, a seeded generator, 11
  unit tests. **There is no shader copy of it**: the particles are stepped in JavaScript,
  so there is one implementation to read and debug, and no parity probe is needed.
- `app/particles.js` draws: it reduces the velocity texture to at most 160 cells wide,
  reads it back (one small synchronous read per frame), steps the particles, and draws
  one line segment per moving particle onto a trail picture that is dimmed a little each
  frame. The trail picture is feedback state and follows the usual rules (two targets,
  redraw without stepping on a repeated frame, start over when `renderer.epoch` changes).
- The renderer gained two small things for it: `program()` accepts a vertex shader, and
  `drawLines()` draws line segments additively.

Rules of the step, all on media time (so the picture is the same at any frame rate or
playback speed, which no wind map found does):
- a particle moves by velocity × time × gain; the segment drawn is exactly that step;
- a particle lives 0.6 to 2.4 seconds, fading in and out over 15% of its life, and is
  re-seeded at random when it dies or leaves the picture;
- a particle on a spot slower than 4% of the speed range draws nothing and is re-seeded
  with a time constant of 0.12 s;
- the count is a density (25 per 1,000 pixels by default: 5,760 at 640×360, 3,240 on a
  phone), capped at 20,000.

## What existing parts it builds on, and what is new
Builds on: the mode registry and its shared controls, the frame ring (the older frame is
found by media time), float render targets, the feedback-state pattern, the
diff/overlay/glow compositing (traces can be shown over the video), the data output.
New: the flow solver (see `optical-flow.md`), the particle core, line drawing.

## How others build it, and what is different here
From reading the code of the hint.fm wind map, `cambecc/earth` and `mapbox/webgl-wind`
(`research.md` §6):
- All three step **per displayed frame** with no time base. Ours steps on media time.
- All three draw a **steady, precomputed field** that is defined everywhere. Ours is
  measured live, changes every frame, and is undefined over most of the picture; hence
  the re-seeding rule and the confidence that travels with every vector.
- hint.fm and earth step particles in JavaScript on a 2D canvas (5,000 and about 7 per
  pixel of width); Mapbox moved the step to the GPU for a million particles, at the cost
  of packing positions into 8-bit textures, which is where its reported phone bugs come
  from. We need thousands, not a million, so the JavaScript step is the lighter choice.
- Borrowed ideas: random first ages so the crowd does not die together (earth), rounding
  the fade down so 8-bit trails reach black (Mapbox), never seeding on a still spot
  (hint.fm).
- No project was found that draws short-lived, re-seeded wind-map traces through
  optical flow measured from video.

## Will it hold the frame rate on a phone?
Measured on this machine only (Intel integrated GPU, headless Chrome), median per frame
including the flow passes: **5.2 to 5.6 ms at 480 px, 5.8 to 7.2 ms at 640 px**, against
3 to 4 ms for Raw. The particle step itself is 0.3 ms (3,240 particles) to 0.5 ms
(5,760). That leaves a wide margin inside the 33 ms of a 30 fps frame, and a phone GPU
several times slower would still fit. **Not measured on a real phone**: the one thing
that could behave differently there is the per-frame readback of the field (at most
160×90 values), which stalls some mobile GPUs. If it does, the fix is an asynchronous
read one frame late (a roadmap item).

## Known limits
- In a still picture, plain (uncoloured) traces show the line of travel but not which
  way along it. A blind judge could not tell, with or without a tinted tail (tried and
  removed). Heading colours, the default, do show it.
- Traces are drawn at the processing size and scaled up with the picture, so they are
  soft on a large display.
- A paused video shows the traces frozen. Letting them keep flowing through the frozen
  field (true streamlines of that instant) is on the roadmap.
