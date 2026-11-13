# Schlieren: design note

Status: **built** (session 4), checked on synthetic scenes with a known answer and on
two real recordings found online. **Not yet checked on a phone or on the owner's own
footage.** Research in `research.md` §7; results in `verdicts.md` V7.

## What it is
Hot air (or a different gas) bends light. Seen through it, a detailed background
appears shifted, by hundredths to tenths of a pixel at our picture size. Measure that
shift for every small patch and draw it, and the plume appears. This is
background-oriented schlieren (BOS).

**What the picture represents.** The shift at a point is proportional to the change of
air density *across* the line of sight, summed along it. It shows where the air is
unevenly hot. It is not a speed, and it is not a temperature.

## How it is built
`core/schlieren.js` (10 unit tests) and `app/modes/schlieren.js`, on the Lucas–Kanade
solve of `core/flow.js`. Per frame:

1. Luma of the frame, in levels, at the full processing size (up to 1280 px wide).
2. A short running average of it ("Smoothing", 33 ms by default) to cut noise.
3. The **reference**: a long running average of the scene ("Reference time", 2 s). For
   its first 15 frames it is a plain mean. With **Hold reference** on it stops updating.
4. The shift of every patch between reference and now: two sizes of the pyramid, a
   9×9 pixel window by default, and no "nothing moved" test (the shifts are far below
   the noise of any single pixel; the window average is what finds them).
5. A 64-cell-wide grid of the result is read back. Its median is the **camera's own
   shift**, which is subtracted everywhere; it also gives how much of the picture is
   measurable and the noise floor, which go to the status line.
6. The picture: **Knife edge** (one component of the shift as grey around 128, the
   look of a classic schlieren photograph), **Strength**, **Direction**, **Setup
   check**, or **Traces** (experimental; see `particles.md`).

Follow or hold, and what each shows:
- **Reference follows** (default): only hot air that *changes* is shown. A steady,
  smooth column fades out within the reference time. Nothing to set up, and slow drift
  of the camera or the light is absorbed.
- **Reference held**: everything that has changed since the hold is shown, including a
  steady column. Let the reference settle with nothing hot in view, switch Hold on,
  then light the candle. The camera must not move afterwards; a small shift is
  cancelled, and beyond 0.6 px the status line says to release and hold again.

## What it needs from the person filming
From the literature and from the two real recordings:

| Need | Why | What the app does about it |
|---|---|---|
| **A detailed background**, features 2 to 5 pixels across in the processed picture | A shift can only be measured against texture; a plain wall gives nothing | Draws nothing where it cannot measure. **Setup check** hatches those areas in red. The status line says "Background too plain: only N% can be measured" below 35%. `public/schlieren-pattern.svg` is a printable A4 sheet of random 2 mm squares |
| The background **resolved** at the processing size | A very fine pattern blurs to flat grey when the frame is reduced to 640 px (seen on the monitor-checkerboard recording: nothing at 640, a plume at 1280 and 1920) | The same message suggests a larger width; the mode works at the full processing size up to 1280 px |
| A **still camera**: propped, not held | The shifts are a tenth of a pixel; a hand moves the picture by many pixels | Subtracts the whole-picture shift every frame. Says "Camera is moving" when that shift jumps by more than 0.12 px between frames |
| The hot air **well in front of** the background: background about 1 m behind it, camera about as far in front | The shift grows with the distance from the hot air to the background | Help text only |
| **Focus and exposure locked** on the background; steady light | Refocusing, auto-exposure and lamp flicker all change the picture and read as signal | Help text only. The noise floor on the status line rises when they interfere |
| **Avoid a screen showing a fine regular pattern** as the background | Regular patterns alias (moiré) and screens flicker: the monitor recording is noisy even at 1920 px | Help text; the noise floor shows it |

The status line when all is well reads, for example, `69% measurable · shifts over
0.08 px show · reference follows`.

## What existing parts it builds on, and what is new
Builds on: the flow solver and its GPU passes; the running-average pattern of the
background model and Magnify; the feedback-state rules; Posy space (128 = nothing) for
the knife-edge picture, so diff/overlay/glow work unchanged; the media-time base (every
time constant is in real seconds); the live-camera path and the phone layout; the mode
registry (panel, help, key 8, data output follow from the registry entry).
New: the reference with follow and hold; cancelling the camera's shift from a small
readback; the setup judgement and its note on the status line (`frame.note`, new);
tracking the schlieren picture for traces; synthetic plume scenes with a known field,
and a check against it.

## How others do it, and what is different here
- **Pocket Schlieren** (the reference paper): its live mode subtracts consecutive
  frames, which the authors call indicative only and which loses smooth flow; its
  accurate mode runs Farnebäck optical flow on a chosen pair of photos and takes 2 to
  12 seconds. No source code is published.
- Hobby and classroom tools subtract a stored reference. Subtraction needs shifts of a
  pixel or more to show, which is why weak plumes vanish at low resolution.
- Research tools measure the shift (cross-correlation or optical flow) offline; NASA's
  real-time system does it on a desktop GPU. Atcheson's comparison found small-window
  Lucas–Kanade the robust choice.
- **Ours measures the shift live**: Lucas–Kanade against an averaged reference, in the
  browser. On the synthetic plume it resolves a noise floor of about 0.01 px, where
  Raw differencing shows faint speckle. It also cancels camera shift (only NASA's
  system was found doing that), tells the person what is wrong with the setup, and
  says what each view does and does not mean. No browser implementation was found.

## Will it hold the frame rate on a phone?
Measured on this machine only (Intel integrated GPU), median per frame: **4.8 to 5.8 ms
at 480 px (the phone default), 5.7 to 7.2 ms at 640 px, 12 to 15 ms at 1280 px**;
with Traces 8 to 9, 9 to 10.5 and 17 to 19 ms. At the phone default that leaves about
six times headroom inside a 30 fps frame. **Not measured on a real phone.** If it is
short, lower the width to 320 or the window size first.

## What was checked, and what was not
Checked against a known field (`scripts/truth-check.mjs --schlieren 1`): the shift
correlates 0.98 with the truth and reads 91% of its size on the standard plume; a
plume of 0.08 px typical shift is recovered at 0.93; camera drift of 0.4 px is
cancelled. Checked on real footage: a candle against printed dots shows a plume a blind
judge described as hot air rising from a small source, having seen nothing in the
original; a candle against a monitor checkerboard needs 1280 px or more and stays noisy.

Not checked: a phone camera's own noise and compression, live use on a phone, weak
sources (a mug, a heater), natural backgrounds in real footage, the "held" workflow on
real footage (neither real clip has a usable flow-free start at 640 px). The footage
listed below covers these.

## Footage still wanted
Phone on a stand, rear camera, 1080p at 30 fps, focus and exposure locked on the
background, daylight or a steady LED lamp; the printed pattern about 1 m away and
filling most of the frame, the heat source roughly half way. 25 to 30 seconds each,
into `ref-clips/`:
1. `candle-pattern`: candle **unlit** for 5 s (the reference), then lit, 20 s more.
2. `candle-wall`: the same against a natural textured background 2 m or more behind.
3. `weak-source`: a mug of boiling water, a heater, or a hair dryer, against the pattern.
4. `lighter`: gas released unlit for a few seconds, then lit.
5. Optional: 10 s of the first clip handheld, as a failure case.

## Left out, on purpose
Temperature or density values (needs calibration and tomography), tracking the
background through camera rotation or zoom (translation only), the Canvas2D fallback
(the mode reports that it needs WebGL2 with float targets).
