# Troubleshooting

## Which browsers

Tested in Chrome on a desktop GPU and on a phone. Firefox and Safari are
untested.

The demo draws with WebGL2, the browser's way of using the graphics chip,
and falls back to a slower renderer where the browser has none. Some
effects also need *float render targets*, a WebGL2 feature that some older
and low-power graphics chips lack. What each effect needs:

| Effect | Needs |
|---|---|
| Highlight motion | Nothing special |
| Cut out the movers, *vanish at once* | WebGL2 |
| Cut out the movers, *fade out slowly*; Leave trails; Map speed & direction; Reveal heat & air | WebGL2 with float render targets |
| Magnify the invisible | WebGL2 with float render targets. On the fallback renderer, *brightness changes* only |

An effect that cannot run says so in the status line at the top and under
the effect's name, for example *Motion mask needs WebGL2* or *Motion history
needs float render targets, which this GPU lacks*. The message uses the
mode's name; [Controls and keys](controls.md#the-parameter-panel) lists
which effect each mode belongs to. Nothing you can change in the demo fixes
it; try a current version of Chrome, or another device. The parameter
panel's *Performance* folder shows which renderer is in use.

## The video will not load

| Message | What to do |
|---|---|
| *Could not play that file* | The browser cannot read that format. MP4 (H.264) and WebM are the safest |
| *YouTube URLs are not supported directly* | Download the video and open the file |
| *HLS streams are not supported*, *DASH streams are not supported* | Use the address of a single video file |
| *Could not load that URL* | The site will not let other sites read the video. Download it and open the file |

## The camera will not start

| Message | What to do |
|---|---|
| *This browser has no camera access (it needs HTTPS)* | Open the demo from its `https://` address |
| *Camera access denied* | Allow the camera for this site in the browser's site settings, then choose **Camera** again |
| *This device has no other camera* | **⇄ Flip** found only one camera |
| *This camera exposes no zoom control* | Pinch zoom works only where the camera offers zoom to the browser |

## The picture looks wrong

- **Everything lights up.** The camera is moving. Prop it, or switch on
  *Steady camera* in the parameter panel.
- **Still areas sparkle.** Press **A**, or raise the threshold (**=**).
- **Slow things are missing.** Lengthen the gap (**]**) or lower the
  threshold (**-**).
- **It stutters.** Lower *Width* in the panel's *Performance* folder.
- **A model option will not start, or is slow.** See
  [Experimental model options](experimental-models.md).
- **Recording does nothing.** *Recording is not supported in this browser*
  means the browser cannot save video from a page.

## Reporting a problem

The version of the demo is printed at the bottom of the opening page and of
the keys list (**?**). Include it, with the browser and device, in an issue
on [GitHub](https://github.com/J-Houghton/MotionDiff/issues).
