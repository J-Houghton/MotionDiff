# Naming what is tracked: a proof of concept (session 7 design note)

Tracking draws boxes with numbers; this names them. A small image
classifier looks at crops of the **original frame** under each tracked box,
a few times a second, **beside the pipeline and not inside it** — nothing
in the measurement or render path changes — and tracking carries the label
between classification runs: a box keeps its name while its id lives.
Loaded **only when asked**, so the app stays light without it.

## Licences, checked against this repo's MIT (2026-11-16)

| Piece | Licence | Compatible |
|---|---|---|
| ONNX Runtime Web (the runtime, from the jsDelivr CDN, version pinned) | MIT | yes |
| MobileNetV2 int8 (`onnxmodelzoo/mobilenetv2-12-int8` on Hugging Face — the ONNX Model Zoo's new home since its GitHub LFS downloads ended July 2025; 3.65 MB) | Apache-2.0 | yes — and it is fetched at runtime, not redistributed with this repo |
| ImageNet-1k class names (the label list, a data file in this repo) | the synset words; recorded in the file header | yes |
| Ultralytics YOLO (the obvious alternative) | AGPL-3.0 | **no — rejected**, as the deferred list long suspected; a detector is also unnecessary here, since tracking already supplies the boxes |

Neither runtime nor model enters the repository or the bundle: both are
fetched when the option is first switched on. Offline, the switch fails
with a plain sentence and turns itself back off.

## The method

1. **Switch on**: *Name the movers* (`maskNames`), a toggle on the mask
   mode beside *Box the movers*, shown only while boxes are on. The first
   enable dynamically imports `app/naming.js`, which loads the runtime
   from the CDN and the model from Hugging Face (~4 MB together, said in
   the status line while it loads).
2. **Classify**: every 400 ms, the largest few born boxes (up to 4) are
   cropped from the video element at their picture coordinates — the
   original frame, not the mode's output — letterboxed into 224×224,
   normalised, and classified in one batch of single runs. Top-1 class
   and score per crop.
3. **Carry**: per track id, a small vote over the last five
   classifications; the winning label (with its share) is the box's name.
   The id's label survives between runs and through coasting; a dead id
   forgets. Labels under a confidence floor show as nothing rather than
   nonsense.
4. **Show**: the boxes overlay appends the name to the id plate
   (`7 · 93 px/s · tabby`). That is the whole surface: a PoC names boxes,
   it does not export, filter or alert.

## What it will and will not do (help text)

- ImageNet names things as one of 1,000 everyday classes: cars, animals,
  household objects. A crowd, a synthetic square or rain gets a wrong or
  absent name; the score says how sure it was.
- The crop is the box: a mover the mask merges into a clump is named as
  one thing, and a box around part of a mover names the part.
- Names run a few times a second on the CPU, beside the pipeline: the
  picture does not wait for them.

## Acceptance (N-1, registered before building)

1. **Light without it**: with naming never switched on, the production
   bundle's startup chunks are unchanged from master, and a headless run
   of the app makes no request to the CDN or Hugging Face (checked from
   the page's own resource timing).
2. **It names vehicles** (`traffic`, headless, mask + boxes + names, ~12 s
   of normal playback): among boxes that lived ≥ 2 s and got a settled
   label, at least half carry a vehicle-family ImageNet label (the
   design's list: car/wagon/cab/minivan/van/truck/trailer/bus/moving van/
   pickup/limousine/jeep/ambulance/racer/sports car/convertible/
   streetcar/snowplow/tow truck). This is a PoC bar: wrong names on the
   rest are recorded, not hidden.
3. **Tracking carries the label**: a sampled id's label is present on
   frames between classification ticks (ticks ≤ 3 Hz, label on every
   sampled frame while the id lives).
4. **Beside the pipeline**: median frame time on `traffic` with names on
   is within 25% of names off on this machine (SwiftShader, indicative),
   and the picture keeps playing while the model loads.
5. **Interface**: audit stays clean with named boxes up.
