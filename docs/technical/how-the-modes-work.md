# How the modes work

What each of the eight modes computes. The demo's six effects are built
from them: the keys 1 to 6 choose effects, and a mode is chosen by the
choices under the picture or by **Mode** in the parameter panel. For what
each picture means in plain words, follow the effect's link.

Each mode also writes its result as data, shown by the *Data* display: an
unsigned magnitude from 0 to 1 in the first channel, then the contents
listed here.

| Mode | Effect | Data |
|---|---|---|
| Posy, Raw diff | [Highlight motion](../concepts/highlight.md) | How much the pixel changed |
| Motion mask | [Cut out the movers](../concepts/cutout.md) | 1 where moving; strength of the difference |
| Background model | [Cut out the movers](../concepts/cutout.md) | 1 where foreground; distance from the model |
| Motion history | [Leave trails](../concepts/trails.md) | How recently the pixel moved; heading |
| Optical flow | [Map speed & direction](../concepts/speed.md) | Speed as a share of the speed range; velocity, px/s |
| Magnify | [Magnify the invisible](../concepts/magnify.md) | Strength of the amplified band |
| Schlieren | [Reveal heat & air](../concepts/heat.md) | Shift as a share of the sensitivity; the shift, px |

## Shared quantities

- **Gap.** How far back the comparison frame is, in video time. Stored in
  units of 1/30 s, shown in milliseconds.
- **Threshold.** The mean absolute difference between two frames over the
  three colour channels, 0 to 255, in every mode.
- **Trail.** Per pixel and channel, the strongest recent value and its age:
  held at full strength for half the trail length, then faded out.
- **Steady camera** (panel, *Look*). Fits the camera's own shift, zoom and
  rotation to the flow field and removes it before differencing or
  measuring flow. Magnify and Schlieren do not use it.

## Posy

`blend = (current + invert(old)) / 2`. An unchanged pixel of any value `V`
gives `(V + 255 − V) / 2 = 128`, so stillness is mid grey and motion is a
departure from it, lighter or darker. With **RGB spread** the three
channels look back by different amounts (gap, gap + spread, gap + 2 ×
spread), so a moving edge smears into colour along its direction of
travel. **Age colour** slides a trail from a "new" to an "old" colour.

## Raw diff

`diff = |current − old|` per channel. Stillness is black. Every mover
appears twice, where it is and where it was one gap ago.

## Motion mask

`moving = min(|current − old1|, |current − old2|) ≥ threshold`, with the
older frames at the gap and the longer **Second gap**. The place a mover
has just left matches one of the older frames, so it drops out and each
mover is marked once, where it is now. Frames are blurred 3×3 first and
the mask is cleaned by a 3×3 majority vote.

- **Auto threshold** also requires a difference to clear that pixel's own
  learnt noise. **Ignore lighting** differences edges, not brightness.
- **Box the movers** groups the mask into connected shapes and tracks
  them, for the [count line and the tracks file](../guide/counting-and-export.md).
- Limits: a mover must travel more than its own width between the two
  gaps; a flat-coloured mover shows only its edges; a stopped one vanishes.

## Motion history

One number per pixel: the time since the mask last fired there, as a share
of the **History** length. *Age* colours by it. *Direction* reads the
heading from the slope of the age field, averaged over patches about 56 px
across because at one pixel the slope follows the mover's outline.
*Measured (flow)* keeps the heading and speed optical flow measured when
each part of the band was laid down.

## Background model

A running mean and variance per pixel. A pixel is foreground when it
differs from the mean by more than the threshold and by more than 2.5
standard deviations. Whole objects are marked, and a stopped object stays
marked until the model has learnt it (**Absorb after**). The model does
not learn where something moved in the last half second.

## Optical flow

Lucas–Kanade on brightness, solved coarse to fine on a copy of the frame
at most 320 px wide, between now and one **Gap** back. Each patch gets a
velocity in picture pixels per second and a confidence, which is withdrawn
on flat surfaces, where the shift found does not explain the change, and
where "nothing moved" explains the frames as well. It is drawn as particle
traces stepped through the field, as colour, or as a fixed grid of arrows.
**Measure on** keeps vectors only where the motion mask or the background
model finds something. Along a straight edge only motion across it is
seen, and beyond the gap's reach the answer is wrong, not weak.

## Magnify

Eulerian video magnification. Each pixel's brightness over time is
band-passed (the difference of two running averages), multiplied by
**Amplify** and added back. **Band low / high** set the band in hertz;
**Pool** averages blocks of pixels first to cut amplified noise. *Measured
motion* instead band-passes the displacement optical flow measures and
warps the picture along it. **Mute still areas** fades the amplification
where a pixel never changes by more than its usual noise.

**Patents.** The method is from Wu et al., "Eulerian Video Magnification
for Revealing Subtle Changes in the World" (SIGGRAPH 2012). This code was
written from the paper and contains no MIT code, but the method is covered
by patents held by MIT (US 9,811,901 and related), licensed for commercial
use. MotionDiff is non-commercial. Before using Magnify commercially, ask
MIT's Technology Licensing Office or a lawyer.

## Schlieren

The flow solver, run between a reference picture of the scene and now. Hot
air bends light, so the background behind it shifts by a fraction of a
pixel, and the picture shows that shift: where the air is unevenly hot,
not a speed. With **Hold reference** off the reference is a running
average and only changing air shows; on, it is frozen. **Cancel camera
shift** subtracts the shift of the whole picture.
