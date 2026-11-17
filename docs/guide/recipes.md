# Recipes

Starting points for kinds of footage. Press **A** first on any video: the
demo measures it and sets the gap and threshold. Then try these. Settings
are named as the [parameter panel](controls.md#the-parameter-panel) shows
them.

## Choosing the gap

| Gap | Suits |
|---|---|
| 33–100 ms | Fast movement: people walking, hands |
| 170–500 ms | Everyday scenes: wind, water, traffic |
| 0.7–1.3 s | Slow drift: clouds, fog, steam |
| 1.7–3 s | Movement too slow to notice: a moonrise, the tide. Needs a very steady camera |

For the threshold (a difference in brightness, on a scale of 0 to 255),
start at 20. Raise it if still areas sparkle; lower it if
slow movement goes missing. Most footage wants 10 to 50.

## By footage

| Footage | Effect and choice | Settings |
|---|---|---|
| Grass, hair, fabric in a light wind | Highlight motion, *ghostly colour* | Gap 67 ms, threshold 16, trail 270 ms |
| People walking, branches swaying, as double silhouettes with a rainbow smear | Highlight motion, *ghostly colour* | Gap 330 ms, threshold 24, trail 500 ms, RGB spread 67 ms |
| Fog, smoke, steam, shimmer on distant water | Highlight motion, *ghostly colour* | Gap 1 s, threshold 12, trail 670 ms, RGB spread 33 ms, blur on |
| Fast movement as bright outlines on black | Highlight motion, *bare difference* | Gap 100 ms, threshold 5, trail 100 ms |
| Traffic, people in a square, a ball in flight | Cut out the movers, *vanish at once* | Gap 170 ms, second gap 1 s, threshold 20. Add a trail of half a second for a multiple-exposure look |
| A car park, a doorway, a desk: who arrived and stopped? | Cut out the movers, *fade out slowly* | Absorb after 4 s, threshold 20. Let it run for four seconds first so it learns the empty scene |
| A road, a crossing, a flock: which way is everything going? | Leave trails, *direction of the trail* | History 1 s, gap 170 ms, threshold 20 |
| A pulse in a face held still, in even light | Magnify the invisible, *brightness changes* | Amplify 15×, band low 0.7 Hz, band high 2.0 Hz, pool 2× |

**Absorb after** is how long a stopped thing stays marked before it becomes
scenery: one or two seconds for busy scenes, ten or more to keep parked
things marked. **Second gap** has to be long enough for a mover to clear its
own width; lengthen it if slow or large things leave ghosts.
