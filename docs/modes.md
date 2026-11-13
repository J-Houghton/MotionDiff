# How the modes work

Six modes, chosen with the keys 1 to 6 or in the parameter panel. This page explains what each one computes and what its controls do. For settings that suit particular footage see [examples/](examples/).

- [Shared ideas](#shared-ideas): the gap, the threshold, trails, display modes
- [Posy](#posy) · [Raw diff](#raw-diff) · [Magnify](#magnify)
- [Motion mask](#motion-mask) · [Motion history](#motion-history) · [Background model](#background-model)
- [Data output](#data-output)

## Shared ideas

### The gap
Most modes compare the current frame with an earlier one. The **gap** is how far back that earlier frame is. It is measured in video time, not in frames: frames are stamped with their media time and the comparison frame is looked up by time, so a gap means the same thing at any source frame rate, playback speed or processing cap. The panel shows it in milliseconds; internally one unit is 1/30 s.

| Gap | Best for |
|---|---|
| 33–100 ms | Fast motion: people walking, hand gestures |
| 170–500 ms | General footage: wind, water, everyday outdoor scenes |
| 0.7–1.3 s | Slow drift: clouds, fog, rising steam |
| 1.7–3 s | Motion too slow to notice: a moonrise, the tide |

### Threshold
The threshold suppresses noise. It is the mean absolute difference between the two frames over the three colour channels, on a 0–255 scale, and it means the same in every mode.

- Lower: more sensitive, more noise.
- Higher: a cleaner picture, but subtle motion can disappear.

**Auto-configure** (the A key) measures the noise floor of the clip from a short burst of frames and sets the gap and threshold just above it.

### Trails
A trail keeps a pixel's motion on screen for a while after it happened. For every pixel and channel MotionDiff remembers the strongest recent value and how long ago it was written, holds it at full strength for the first half of the trail length, then fades it out. The trail length is in video time, like the gap. Short trails show immediate movement; long ones turn motion into streaks and ghosted silhouettes.

### Display modes
| Display | What it shows |
|---|---|
| Diff | The mode's output on its own |
| Overlay | Motion screen-blended onto the original frame |
| Glow | The original plus an amplified additive bloom from the motion |
| Data | The mode's result as data: a mask, a scalar field or a vector field |

Split compare (the S key) puts the original on the left of a draggable line and the output on the right.

## Posy

Posy compares the current frame against an older one after inverting the old one:

`blend = (current + invert(old)) / 2`

For a pixel that has not changed, the sum always collapses to the same midpoint:

`static pixel: (V + (255 − V)) / 2 = 128`

That holds for every value `V`. The background cancels to grey, and motion shows as a departure from grey in either direction: lighter where something brighter arrived, darker where it left.

**RGB spread.** Instead of comparing all three channels with the same old frame, each can look back a different amount:

```text
time:   now  ← current frame
red:    now − gap
green:  now − (gap + spread)
blue:   now − (gap + 2 × spread)
```

That turns time into colour. When an edge moves, each channel sees it at a slightly different moment, so the result is a directional rainbow smear instead of a white outline. With a spread of zero the colours come only from which channels changed most. The tint each channel compares against can be changed.

**Colour by age.** With "Age colour" on, a trail is drawn as a colour that slides from a "new" colour to an "old" one as the motion ages, at full brightness until the trail ends. Two styles: *Latest only* colours each pixel by the time since it last moved; *Mixed* also shows the old colour where motion has been going on for a while, so a place that keeps moving shows both at once (magenta, with the default orange and blue).

## Raw diff

The absolute difference per channel:

`diff = |current − old|`

Still regions go to black and brighter pixels mean a larger change. It is the literal mode: high contrast and easy to read. Every mover appears twice, once where it is now and once where it was a gap ago, because both places changed. A stopped object disappears.

## Magnify

Eulerian video magnification in its simplest real-time form. Each pixel's brightness over time is band-passed (the difference of two running averages with different time constants), the band is multiplied by the amplification, and the result is added back to the frame. Changes that repeat within the band (a pulse at around one a second, breathing, a sway) become visible; everything else is left alone.

- **Band low / high** set the band in hertz. The caption under the picture translates it into "times a minute".
- **Pool** averages blocks of pixels first, which trades detail for much less amplified noise.
- It needs a still camera: any shake is amplified with everything else. It takes about a second to settle after a seek.

**Patents.** The method is from Wu et al., "Eulerian Video Magnification for Revealing Subtle Changes in the World" (SIGGRAPH 2012). This implementation was written from the published description and contains no MIT code, but the method itself is covered by patents held by the Massachusetts Institute of Technology (US 9,811,901 and related), which MIT licenses for commercial use. MotionDiff is a personal, non-commercial project. If you want to use Magnify commercially, ask MIT's Technology Licensing Office or a lawyer first. More in [research.md](research.md).

## Motion mask

A pixel counts as moving only when it differs from **two** earlier moments, the gap and a longer second gap:

`moving = min(|current − old1|, |current − old2|) ≥ threshold`

The place an object has just left differs from the frame of one gap ago, but it looks like the older frame again, because back then the object had not arrived yet. So the second copy that Raw draws drops out and each mover is marked once, where it is now.

Requiring two independent differences also means noise has to exceed the threshold twice, so the mask speckles far less than Raw at the same setting. The frames are blurred 3×3 before differencing ("Blur first") and the mask is cleaned by a 3×3 majority vote ("Clean up").

The picture is the current frame cut out by the mask, in its own colours, or the mask in white.

Limits:
- An object has to move by more than its own width between the two gaps, or part of its ghost survives. Lengthen the second gap for slow or large things.
- A flat-coloured object shows only its leading edge: differencing cannot see inside a single colour.
- A stopped object disappears.
- On a moving camera the scenery itself is "moving".

Needs WebGL2.

## Motion history

One number per pixel: the time since the motion mask last fired there, as a share of the history length. Two views:

- **Age**: a colour gradient from the "new" colour at the object to the "old" colour at the tail of its path.
- **Direction**: hue for the heading. Right is red, down is yellow-green, left is cyan, up is violet; grey means the patch does not agree on a heading.

The heading is read from the slope of the age field: behind a mover, age rises steadily, so motion points down the slope. At a single pixel that slope follows the shape of the object's outline, not its heading, so it is averaged over patches about 56 pixels across.

Limits:
- A trail wider than the patch shows different hues along its two sides.
- Things that sway back and forth (foliage, water) give mixed or grey hues.
- It inherits the motion mask's limits.

Needs WebGL2 with float render targets.

## Background model

A running mean and variance of what is usually at each pixel. A pixel is foreground when the current frame differs from the mean by more than the threshold **and** by more than 2.5 standard deviations.

Unlike differencing, this marks the whole of an object, not just the edges that changed, and keeps marking it after it stops, until the model has learnt it. **Absorb after** is roughly how long that takes for a typical object.

The model does not learn where something moved within the last half second, so a thing moving through neither smears into the background nor inflates its variance. The variance is learnt only from pixels that match the background, so it measures the background's own noise.

Limits:
- Whatever is in the picture when the model starts is taken for background, and leaves a ghost for about one absorb time when it moves away.
- A slow, flat-coloured object is partly absorbed while it passes and leaves a fading trail.
- A change of lighting or exposure marks everything until it has been absorbed; a moving camera marks everything, all the time.
- Things that never stop moving stay marked.

Needs WebGL2 with float render targets.

## Optical flow
Between the current frame and the one a **Gap** back (67 ms by default), how far and which way each small patch of the picture moved, divided by the real time between them: a velocity in picture pixels per second. The method is Lucas–Kanade on brightness, solved from coarse to fine on a copy of the frame at most 320 px wide ([optical-flow.md](optical-flow.md)).

Every vector comes with a confidence. It is withdrawn on flat surfaces (nothing to measure), where the shift found does not explain the change between the frames (the edge of a moving thing), and where "nothing moved" explains the frames as well: that last test is what keeps the still surroundings of a mover dark.

- **Show**: *Particle traces* draws a few thousand short-lived traces that follow the flow, like a wind map ([particles.md](particles.md) says exactly what they mean); *Colour* paints heading as hue and speed as brightness.
- **Gap**: a short gap follows fast motion, a long one finds slow motion. Beyond its reach the answer is wrong, not weak.
- **Speed range**: the speed drawn at full brightness, as a share of the picture's width per second. Lower it for slow scenes.
- **Smoothing**: how long the flow is averaged over.
- **Traces, Trace length, Trace speed, Trace colour**: how many, how long they stay, whether their steps are true to scale, and heading colours or plain.

Limits: nothing on flat surfaces; along a straight edge only motion across it is seen; a moving camera makes everything flow (which shows what the camera did).

## Schlieren
Makes hot air and gas visible by measuring how much they shift the background behind them, a fraction of a pixel ([schlieren.md](schlieren.md) covers the setup, and it matters: a still camera and a detailed background well behind the hot air).

The shift is measured against a reference picture of the scene. The picture shows where the air is unevenly hot. It is not a speed.

- **Show**: *Knife edge* (light where the background is pushed one way, dark the other: the classic schlieren look), *Strength*, *Direction*, *Traces* (experimental: follows the travel of the eddies), *Setup check* (hatches in red whatever cannot be measured).
- **Hold reference**: off, the reference follows the scene and only changing hot air shows; on, it is frozen and everything since shows, including a steady column.
- **Sensitivity**: the shift drawn at full strength, in pixels.
- **Window**: the patch each shift is measured over. Larger sees weaker plumes, more coarsely.
- **Smoothing**, **Reference time**: averaging of the current frame and of the reference.
- **Knife shows**: sideways or up-down shifts.
- **Cancel camera shift**: subtracts the shift of the whole picture.

The status line reports the setup: how much of the picture can be measured, the smallest shift that shows, and what is wrong when something is.

## Data output

Every mode also gives its result as data, not only as a picture: one value set per pixel, shown by the "Data" display and readable in code.

| Mode | Kind | Contents |
|---|---|---|
| Posy, Raw diff | scalar | How much the pixel changed, 0–1 |
| Magnify | scalar | Strength of the amplified band, 0–1 |
| Motion mask | mask | 1 where moving; the strength of the difference alongside |
| Motion history | vector | How recently the pixel moved, and its heading as a vector |
| Background model | mask | 1 where foreground; the distance from the model alongside |
| Optical flow | vector | Speed as a share of the speed range; velocity in picture pixels per second |
| Schlieren | vector | Size of the shift as a share of the sensitivity; the shift in picture pixels |

The sonification (the Sound section of the panel) is driven by the same data: it pools "how much motion, where" into a coarse grid and plays one voice per cell, panned by position and pitched by height.
