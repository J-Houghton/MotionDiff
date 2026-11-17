# Combined modes, and hard footage: design note

Status: **built**, all eight items. Verdicts V-B4 to V-B9 and V-6C in
[verdicts.md](../verdicts.md).

Combinations of existing measurements, and the four changes that make real
footage measurable. Written before building, as the
[acceptance rules](../acceptance.md) require; each item's expected effect was
registered in the verdict log when it was built.

## Where a combination lives: an option, not a new mode

A combination could be a new registry mode (`flow-foreground`) or an option on
an existing mode (`flowOnly: 'foreground'`). Options win on every rule this
project has:

- The registry stays at eight modes (when this was written, keys 1–9 chose
  modes; keys 1–6 now choose the six effects); the help sheet and panel stay
  one per idea rather than one per pairing.
- Each mode keeps one meaning: Optical flow still answers "how fast and which
  way", with or without a gate in front of it; the gate is a setting, like Blur.
- The parts are already exported functions that take and return textures
  (`maskDifference`, `renderBackground`'s model, `flowVelocity`,
  `renderHistory`), and mode modules already import each other that way
  (history and background import `maskDifference` from mask).
- Presets and samples carry options for free; a new mode id would touch
  presets, keys, help and the mode-aware interface.

Cost: the mode modules gain a little branching. Kept small by putting each
gate behind one helper with one uniform.

## The four combinations

### 1. History trails in measured colours (flow + history)
`historyShow: 'measured'` joins `age` and `direction`. The ribbon a mover
leaves stays the history mode's (age per pixel from the mask); its colour
comes from the flow field where the ribbon was laid down, not from the age
slope: hue = measured heading (the same wheel as flow), brightness = measured
speed against the flow speed range. Implementation: the velocity field
(`flowVelocity`, already smoothed) is sampled when a pixel's age resets to
zero — a second feedback target alongside the age target holds "velocity when
last moving", advanced in the same pass, so a ribbon keeps the colour of the
moment the mover passed rather than the current field.
**Expected on `gulls`:** each ribbon one hue that matches its bird's true
course; two crossing birds in distinct hues. **On `truth`:** the square's
ribbon in the right-heading hue at even brightness; history's own direction
view shows a coarser, cell-quantised version of the same hue.
Cost: flow solve added to history's frame (both exist; run in sequence).

### 2. Flow only on what the mask says moves (mask + flow)
`flowOnly: 'mask'` on the flow mode. The three-frame mask (cheap, no state)
is computed at flow's working size and zeroes the *presence* of vectors on
still ground before smoothing, so colour and traces exist only on movers.
The mask is dilated by one solve window first — flow is valid a window out
from an edge, and an ungated rim would flicker.
**Expected on `traffic`:** colour confined to vehicles; the road's speckle
(window-mean bleed) gone. **No regression:** `river` (everything moves)
unchanged apart from its banks.

### 3. Flow only on the foreground (background model + flow)
`flowOnly: 'foreground'`: the background model's decision gates instead. The
model absorbs what stands still for `absorbSeconds`, so a car that parks
stops carrying flow, and slow drifters the three-frame mask misses keep
theirs. Same gating path as 2; the two options share every line but the mask
source. The model update runs from flow's frames with the mask it already
needs (maskDifference), as the background mode does today.
**Expected on `crossing`:** flow only on the moving vehicles and pedestrians,
and a stopper's colour fades out as it is absorbed, where option 2 cuts it
the moment it is slow. Dearer than 2 (model update per frame).

### 4. Magnify only what is not background (background + magnify)
The point is noise: magnify amplifies sensor noise over the whole frame, and
the help sheet's only answer today is pooling. The background model knows
where nothing but noise ever happens — but the subject of magnification (a
breathing flank) is *also* nearly still, so gating by the model's foreground
decision would erase exactly what magnify is for.
What is gated instead is the **band**: the amplified band is kept where the
model's variance says the pixel changes more than the noise floor, and faded
to nothing where the variance sits at the floor (sky, wall). Breathing
raises variance a little over the floor; static noise does not raise it at
all (the model averages it away). `magMask: 'off' | 'quiet'` toggle.
**Expected on `kitten`:** the flank still swells; the amplified grain on the
blanket and wall drops visibly. **Risk, stated in help:** a rhythm smaller
than the noise floor is gated away with the noise; turn the gate off for it.

## Hard footage

### 5. Filling holes in mask cut-outs (morphological close)
`maskClean` today is one 3×3 vote. A close (dilate then erode, two cheap
passes at the decision stage, radius 1–2) fills pinholes and bridges cracks;
an open (erode then dilate) removes salt. Order: close for holes is the
visible win (`traffic`, `bees` cut-outs); expose as `maskFill: 0 | 1 | 2`
(radius). Applies wherever `maskDraw` is used (mask, background, history's
feed), so every cut-out benefits.

### 6. Per-pixel noise threshold (background model's variance)
The model's variance is a per-pixel noise estimate the user cannot set by
hand. A difference of two noisy values has variance 2σ², so the decision
becomes |difference| > k·σ√2 with the global threshold as a floor
(the background mode already decides this way — this brings the same rule
to the three-frame mask; built as the `maskAuto` toggle, *Auto threshold*).
**Expected on `truth-noisy` and `night`:** a clean mask at the default
threshold, where today the threshold must be raised by hand.

### 7. Lighting normalisation (gradient differencing)
Differencing gradient images instead of brightness: a global exposure or
lighting change shifts brightness but barely changes spatial gradients, so
the whole-frame lighting flash disappears while edges of movers remain.
One extra pass per compared frame (central-difference gradient magnitude,
as flow's products pass already computes), then the existing differencing
on that image; a toggle on the mask (and so history and background feeds). **Expected on `sunset`:** the timelapse's exposure drift
no longer lights the whole frame; cloud motion remains.

### 8. Camera compensation (global motion, then subtract)
The flow's median shift (now on `pipeline.readings.camera`) is the
translation estimate; subtracting it means sampling the older frame shifted
by it before any differencing, and subtracting it from flow's own field.
Doing this per mode duplicates a warp in five places — exactly the shape the
Large pipeline restructure (shared measurement stages) is for. Decision:
**camera compensation is designed and built with the restructure**, not
before it; the readout ships now, the subtraction follows the stage design
([pipeline-stages.md](pipeline-stages.md), then
[camera-compensation.md](camera-compensation.md)). (`river`'s forward motion
additionally needs a zoom term — a 4-parameter similarity fit over the flow
field instead of the median; same stage, richer fit.)

## Order of building (visible effect for the effort)
1. History trails in measured colours (1)
2. Hole filling (5)
3. Flow gated by mask (2), then by the model (3) — shared gating path
4. Per-pixel noise threshold (6)
5. Lighting normalisation (7)
6. Magnify band gate (4)
7. Camera compensation (8) — deferred into the pipeline restructure design,
   and built there
