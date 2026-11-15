# Grouping and tracking (session 6 design note)

The object picture the owner asked for: the background model (or the mask)
finds a mover, grouping turns its pixels into a shape, tracking gives the
shape an identity — a box with an ID, its measured numbers, and an arrow
ahead of it. Start on the traffic clip. Expected effects are registered in
`verdicts.md` (V-6T) before building.

## What is measured

- **Grouping** (`core/track.js labelComponents`): connected components,
  4-neighbour, over the voted decision read back on a coarse grid (at most
  160 cells wide — the existing `reduceField`/`readField` path). Each
  component: area, bounding box, centroid, in picture pixels. Components
  under a minimum area are noise and dropped.
- **Tracking** (`core/track.js stepTracks`, pure, unit-tested): each live
  track predicts its centroid one frame ahead with its own velocity; greedy
  nearest-first matching within a gate scaled by box size. A matched track
  updates position, an EMA velocity (from its own displacement — no flow
  solve needed), and its age. An unmatched detection becomes a track after
  it persists a few frames (birth); an unmatched track coasts on its
  prediction for a few frames (a mover briefly lost by the mask) before it
  dies. IDs count up and are never reused within a session.
- **The stage** (`stages.objects()`): runs when `maskTrack` is on, from the
  same voted decision the picture uses, once per frame; publishes
  `readings.objects`: id, box, centroid, velocity (picture px/s), speed,
  heading, age — the raw numbers. Tracking state lives with the stage and
  resets with the renderer epoch.

## What is drawn — and by whom

The measurement publishes; the interface draws (the Session A/B seam,
kept). `ui/boxes.js` lays a DOM overlay over the stage — like the legend
and the guide — and redraws from `pipeline.readings.objects` every frame:
a thin box per track, its ID in a small plate at the box's shoulder, the
speed under it, and an arrow from the box's leading edge along the
velocity, one lead-second long. DOM, not GL: the numbers stay crisp at any
display size, and the overlay inherits each layout's voice (ink-on-paper
plates in the Plate, amber-on-black in the Viewfinder).

## Where it is reachable

`maskTrack` ("Box the movers") on the mask and background modes; surfaced
as a pill on the Cut out effect. The instrument margin gains one row:
tracked movers now.

## Deliberately out of scope

- Flow-based velocities (track displacement is enough for an arrow and a
  speed; flow inside boxes is a refinement for later).
- Tracking through occlusion beyond the short coast.
- Real units (the calibration item builds on these boxes next).

## Acceptance (V-6T)

1. `traffic`: vehicles carry boxes with stable IDs across a strip's frames;
   arrows point along each carriageway's direction of travel.
2. `truth`: the moving square carries one box; its reported speed is within
   20% of the known 120 px/s while it moves, and the box dies while the
   square stands still (3.5–8.5 s) or survives only as a short coast.
3. No boxes on `truth`'s static noise background (no phantom tracks).
Judged from page screenshots (the overlay is DOM) by a blind reviewer;
the numbers against truth come from `readings.objects` directly.
