# Parameter guide

How to choose the settings most modes share. What each mode computes is in [../modes.md](../modes.md).

## Choosing the gap
The gap is how far back the comparison frame is, in video time. A longer gap reveals slower motion, because the thing has moved further between the two frames and is more likely to cross the threshold.

| Gap | Best for | Notes |
|---|---|---|
| 33–100 ms | Fast motion: people walking, hand gestures | Keeps fast subjects from smearing too far between samples |
| 170–500 ms | General footage, moderate motion | A good default range for wind, water and everyday outdoor scenes |
| 0.7–1.3 s | Slow drift: clouds, fog, rising steam | For motion that is real but hard to notice frame to frame |
| 1.7–3 s | Motion too slow to see: a moonrise, the tide | Best kept for locked-off shots with a very stable background |

The keys **[** and **]** shorten and lengthen it; so does dragging the GAP marker on the time ruler.

## Choosing the threshold
The threshold is the mean absolute channel difference between the two compared frames, on a 0–255 scale, and it means the same thing in every mode.

Start at 20. If still areas show noise, raise it. If slow motion is missing, lower it. The usual range is 10 to 50. **Auto-configure** (the A key) measures the noise floor of the clip and picks a value just above it.

## Trail length
A trail holds each pixel's strongest recent motion at full strength for the first half of the trail length, then fades it out over the second half: back to grey in Posy, to black elsewhere. The length is in video time, so a trail lasts the same on screen at any frame rate or playback speed.

With **Age colour** on (Posy), the trail is drawn as a colour that slides from the "new" colour to the "old" one as the motion ages. In the "Latest only" style a pixel that keeps moving stays the new colour; in "Mixed" it shows new and old at once.

## RGB spread and direction
- **Spread 0:** colours come only from which channels changed most.
- **Spread 33–67 ms:** red leads and blue trails, so a moving edge gets a warm side and a cool side that tell you which way it went. This is approximate and depends on the colours in the scene.
- **Spread over 100 ms:** a strong rainbow smear, more artistic than analytical.

For an exact heading, use Motion history's direction view instead.

## Second gap (Motion mask, Motion history)
The mask compares against two earlier frames. The second one has to be far enough back that a mover had not yet reached the place it has since left: more than its own width of travel between the two gaps. One second suits most footage. Lengthen it if slow or large things leave a ghost; shorten it if the scene changes quickly and old positions linger.

## Absorb after (Background model)
Roughly how long a stopped object stays marked before it becomes part of the background. Short (1–2 s) for busy scenes where you only care about what is moving or has just stopped; long (10 s and up) to keep parked or waiting things marked.
