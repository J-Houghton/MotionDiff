# Design exploration for the new demo

Three directions, built as static mockups to choose between. They are not the app:
the picture is a still captured from the real pipeline, the parameter panel is a
real Tweakpane built from a mode schema, and only the split handle is interactive.
Delete this folder's `mockups/` once a direction is built.

To open them: `npm run dev`, then
- http://localhost:5173/MotionDiff/docs/design/mockups/a-viewfinder.html
- http://localhost:5173/MotionDiff/docs/design/mockups/b-plate.html
- http://localhost:5173/MotionDiff/docs/design/mockups/c-modeline.html

Add `?state=idle`, `?state=nopanel`, `?state=palette`, `?state=panel` or
`?state=split` to see a mockup's other states. Screenshots are written to
`docs/design/shots/` (not tracked in git).

## What all three share
- One output stage. Split compare against the original with a draggable divider
  (`S` toggles it, arrow keys move it); hold `O` to see the original alone.
- Tweakpane is the parameter panel, generated from the mode's schema, restyled
  through its CSS variables, summoned with `P`.
- Everything has a key: Space play, ←/→ step, J/K/L shuttle, 1–6 mode, `[` `]`
  gap, `-` `=` threshold, `,` `.` trail, D display, N source, A auto-configure,
  R record, H hide everything, F fullscreen, `?` the full list.
- Gap, spread and trail are shown in milliseconds, since they are media time now.
- Drop a file anywhere to open it. Light and dark themes only.

## A — Viewfinder
A camera monitor. The frame is full-bleed; the interface is overlays in its
corners that fade out after a couple of seconds without input (`?state=idle`).
- **Type:** Barlow Condensed for labels and the mode name, JetBrains Mono for numbers.
- **Colour:** black, off-white, one signal amber.
- **Legibility:** every overlay sits on a solid black plate. Text straight on the
  picture was tried first and vanished over bright footage; blend-mode tricks fail
  on Posy's mid-grey.
- **Motion:** fades only, 200–250 ms, none with reduced-motion.
- **Risk:** the plates cover some picture while visible.

## B — Plate
A motion-study plate, after Muybridge: the frame printed on paper with a caption
strip underneath. Deliberately not full-bleed and light by default.
- **Type:** Fraunces (serif) for the mode name and timecode, IBM Plex Mono for data.
- **Colour:** warm paper, ink black, one vermilion.
- **Its own idea: the time ruler.** "Now" on the right, the past to the left, with
  a draggable marker for each channel's lookback and a hatched band for the trail.
  It shows what gap, spread and trail mean and edits them in place.
- **Risk:** the frame is smaller than in A and C; the dark theme needs its own design.

## C — Modeline
A modal editor for video. The picture, a one-line status bar, and a command
palette (`:`). There is so little interface that nothing needs to hide.
- **Type:** JetBrains Mono throughout.
- **Colour:** near-black, off-white, one hot pink for the mode tag and selection.
- **Its own idea: the palette.** Type `gap 250` or `mode magnify`; each entry shows
  its key, so the palette teaches the shortcuts.
- **Risk:** least discoverable for a first-time visitor without a keyboard; the
  status line needs a touch layout.

## Not decided here
- Fonts are loaded from Google Fonts in the mockups. The app would bundle one or
  two files or fall back to system fonts.
- Phone layout was not mocked for any of the three.
- Whether the shell uses Lit. Nothing in these mockups needed it; plain DOM modules
  are enough so far.
