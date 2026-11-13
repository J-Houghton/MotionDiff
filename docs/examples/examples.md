# Examples

Starting points for common footage. Values are as the parameter panel shows them. Press **A** first on any clip: Auto-configure measures its noise and sets the gap and threshold, and these recipes are what to try from there.

## Subtle wind
**Posy** · gap 67 ms · threshold 16 · trail 270 ms · RGB spread 0

For grass, hair, fur, fabric in a gentle breeze. Look for fine, filament-like traces on moving edges.

## Ghost trails
**Posy** · gap 330 ms · threshold 24 · trail 500 ms · RGB spread 67 ms

For people walking slowly, branches swaying. Each mover shows as a double silhouette, one where it was and one where it is, with a rainbow smear between them from the spread.

## Atmosphere
**Posy** · gap 1 s · threshold 12 · trail 670 ms · RGB spread 33 ms · blur on

For fog, smoke, steam, distant water shimmer. Large soft areas of colour reveal drift too slow to notice.

## High-contrast motion
**Raw diff** · gap 100 ms · threshold 5 · trail 100 ms

For fast motion and silhouettes: bright outlines on pure black.

## Just the moving things
**Motion mask** · gap 170 ms · second gap 1 s · threshold 20 · show: cut-out

For traffic, people crossing a square, a ball in flight. Each mover is cut out in its own colours on black, once, with no copy where it used to be. Add a trail of half a second for a multiple-exposure look. Lengthen the second gap if slow or large things leave a ghost.

## Which way is everything going?
**Motion history** · show: direction · history 1 s · gap 170 ms · threshold 20

For a road, a crossing, a flock. Each stream of movement takes the hue of its heading: right is red, down is yellow-green, left is cyan, up is violet. Switch to "age" to see how long ago each place was passed.

## Who stopped?
**Background model** · absorb after 4 s · threshold 20 · show: cut-out

For a fixed camera on a scene where things arrive and wait: a car park, a doorway, a desk. Things are shown whole, and stay shown for a few seconds after they stop moving. Let it run for one absorb time first so it learns the empty scene.

## A pulse
**Magnify** · amplify 15× · band 0.7–2.0 Hz · pool 2×

For a face held still in even light, on a tripod. The skin flushes faintly with each heartbeat. Turn off auto-exposure if you can, and raise the pooling if the picture is noisy.
