# Parameter Guide

## Choosing frame offset
The offset controls the temporal "distance" of the comparison. One unit is 1/30 s of video time, whatever the source frame rate, playback speed or processing fps cap. A longer offset reveals slower motion because the displacement between frames is larger, making it more likely to cross the threshold.

| k value | Best for | Notes |
|---------|----------|-------|
| 1-3 | Fast motion, people walking, hand gestures | Keeps fast subjects from smearing too far between samples |
| 5-15 | General nature footage, moderate motion | Good default range for wind, water, and everyday outdoor scenes |
| 20-40 | Slow drift, clouds, fog, rising steam | Useful when the motion is real but hard to notice frame-to-frame |
| 50-90 | Imperceptibly slow motion, moonrise, tide | Best reserved for locked-off shots with very stable backgrounds |

## Choosing threshold
Threshold is the mean absolute channel difference between the two compared frames, on a 0-255 scale. It means the same thing in Posy and Raw mode.

Rule of thumb: start at 20. If static areas show noise, raise it. If you are missing slow motion, lower it. Typical range: 10-50. The Auto button measures the noise floor of the clip and picks a value just above it.

## Trail length and algorithm interaction
A trail holds each pixel's strongest recent motion at full strength for the first half of the trail length, then fades it out over the second half. In Posy mode it fades back to grey, in Raw Diff mode to black.

Trail length uses the same unit as the offset, 1/30 s of video time, so a trail lasts the same on screen at any frame rate, playback speed or fps cap.

With Color Age on (Posy only), the trail is drawn as a colour that slides from the "new" colour to the "old" one as the motion ages, at full brightness until the trail ends. A pixel that keeps moving stays the "new" colour.

## RGB spread and motion direction
Spread=0: colors are determined only by which channels changed most.

Spread=2: red leads, blue trails. Motion toward the camera tends to read warmer, while motion away often reads cooler. This is approximate and depends on scene color.

Spread=4+: strong rainbow smear, more artistic than analytical.
