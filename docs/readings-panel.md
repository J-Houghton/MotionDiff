# Readings panel: design note

Status: **designed** (session 5, Session A); owner's commission. Absorbs the
roadmap's "motion-over-time strip" (its design note, `docs/motion-strip.md`,
survives as the seismograph line's definition). Desktop Plate only.

## Research
Two traditions fit the Plate's language, and both are the real ancestors of
what this panel does:

- **Observatory plate annotations.** Astronomers wrote their measurements —
  star, brightness, position — directly beside the image, on the plate and on
  its jacket, as working marginalia rather than a separate report (Schechner
  & Sliski 2016, [arXiv:1602.03475](https://arxiv.org/pdf/1602.03475); the
  [Harvard plate digitisation account](https://www.popsci.com/science/article/2011-10/recording-century-night-skies-through-scanner-darkly/)).
  So: the readings are a narrow annotation column in the plate's own margin,
  set in the caption's voice — not boxed widgets.
- **Strip-chart recorders.** The continuous-measurement instrument of the
  pre-digital lab: one pen line on ruled chart paper, time running along the
  strip, the scale printed on the paper ([HP's Moseley recorders](https://www.hpe.com/us/en/about/history/innovation-gallery/015-product.html),
  [pen recorders](https://Www.Wikipedia.org/wiki/Pen_recorder)). So: the
  motion-over-time line is drawn as a pen trace on a faintly ruled strip, not
  as a filled chart.

## What it shows
A column beside the frame, in three blocks; a key (I) and a mast button show
and hide it. Nothing changes on phones or in the Viewfinder, and the picture
keeps its size (the column lives in the Plate's spare margin and collapses
away below it).

1. **Instruments** (the promoted readings):
   - *Peak speed* as a numeral, px/s of the processing picture (95th
     percentile of moving cells — labelled as such).
   - *Moving share* as the pen line over the last 60 s: the seismograph.
     Works in every mode (pooled magnitude grid); in flow/schlieren it is the
     mode's own `moving` share.
   - *Direction rose*: eight sectors, bar length = share of moving cells
     heading that way, in the legend's hues. One averaged angle is wrong on
     `traffic` (two opposed streams); the rose shows both. Flow only (the
     only mode measuring velocity; schlieren's shift is not one — said in
     place).
   - *Coverage*: measurable share and moving share as numerals.
2. **Raw list** behind a toggle: every published reading as name, value,
   unit — including camera dx/dy, coherence, saturated share, speed ceiling,
   speed spread (slow/medium/fast thirds of the range), centre of motion
   (derived from the pooled grid), time since anything moved (derived), gap,
   processing size, measured frame rate, ring frames and their memory.
3. **Setup** (schlieren only): the same judgement the guide card uses.

Refresh: numerals and rose at 4 Hz; the pen line appends at 4 Hz. Modes that
publish no readings show the pooled-grid line and the cheap facts, with one
plain sentence for what is not measured — no empty boxes.

## Where the numbers come from
- `pipeline.readings` (flow, schlieren/setup) — Session B's contract.
- One small addition inside `reportReadings` only (the owner's allowance):
  `rose` (8 heading bins, share of moving cells) and `speeds` (3 bins against
  the speed range), from the same reduced field the function already reads.
- `pipeline.getEnergyGrid(cols, rows)` for the every-mode line, the centre of
  motion and the quiet timer — the sonification's existing readback, small.
- Session/pipeline facts (fps, sizes, ring) read directly.

## Acceptance (verdict IA8 + VA4-as-absorbed)
- Interface audit at desktop sizes with the panel open and closed; picture
  share stays within the rule; a fresh look in the tier's critique round.
- On the synthetic `flow` scene the panel shows the known truth: peak speed
  within 20% of 90 px/s, the rose's longest sector East, measurable high.
- The pen line: on `truth`, after a playthrough, visibly low between 3.5 and
  8.5 s (the strip expectation, kept).
- In a mode without readings (posy): the line still draws; the flow-only
  instruments say they are not measured; nothing empty.
