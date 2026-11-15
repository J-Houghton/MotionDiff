# Shared measurement stages (session 6 design note)

The restructure the large tier waits on (`combined-modes.md` §8): each
measurement becomes a stage computed **once per frame** that any view can use.
It must change nothing visible; the proof plan is at the end. Written before
building, as the acceptance rules require.

## The problem

The measurements are already factored as exported helpers that take and return
textures (`maskDifference`, `learnMask`, `updateBackground`, `flowVelocity`,
`renderHistory`), and mode modules import each other's helpers freely. Two
things are wrong with that shape, and both block the work that comes next:

1. **Stateful helpers advance when called.** `updateBackground`, `flowSmooth`
   and the history ping-pong each keep "the state before this frame" and step
   it forward per call. Today exactly one mode renders per frame, so each is
   called at most once and nothing goes wrong — but the moment two consumers
   want the same measurement in one frame (tracking wants the mask *and* the
   flow field; a readings panel wants what the picture is drawn from), the
   second call would advance the model twice or recompute the solve twice.
2. **Variants collide on shared targets.** Every `maskDifference` call writes
   the same `mask:raw` target, whatever its options; callers survive by
   copying the result out before anyone else runs. That ordering discipline
   is invisible in the code and breaks silently.

Camera compensation makes it urgent: subtracting the camera's motion means
warping the older frame before *any* differencing and subtracting a shift from
flow's own field — one change that today would have to be repeated in five
mode modules (`combined-modes.md` §8).

## Approaches considered

- **A dependency-graph scheduler** (declare stages and inputs, let a planner
  order them). Rejected: machinery the project's governing rule forbids;
  nothing needs dynamic ordering — the dependencies are few and static.
- **Move all measurement passes into a new `src/app/measure/` layer** and
  leave mode modules as pure views. Rejected for this change: it moves every
  shader while also changing behaviourally sensitive call paths, which makes
  "nothing visible changed" hard to review. The split can happen file by file
  later; nothing in the chosen design prevents it.
- **A thin per-frame stage cache over the existing helpers** — chosen. The
  helpers stay where they are and keep their tests and probes; a small
  `Stages` object adds the two guarantees the helpers lack (once per frame,
  one target per variant). The diff stays reviewable and each mode's render
  shrinks to: ask for stages, draw.

## The design

One new module, `src/app/stages.js` (app layer; imports core/ and the mode
modules' helpers — mode modules do not import it, they receive it per frame).

```
Pipeline owns        stages = new Stages()
Pipeline.process     frame.stages = stages.begin(frame)   (WebGL path)
a mode's render      const velocity = frame.stages.velocity()
```

`begin(frame)` clears a per-frame memo map. Every stage method computes on
first request in a frame and returns the cached result after that, so a
stateful stage advances exactly once per frame however many views pull it.
Repeat frames keep today's semantics: the helpers' own `repeat` handling
(ping-pong "recompute, don't advance") is unchanged underneath.

The stages, with what they return:

| Stage | Returns | Today's code |
|---|---|---|
| `maskPair()` | ring layers for [gap, second gap], or null | `maskLayers(frame)` |
| `maskRaw(opts)` | raw three-frame decision + strength, one target per variant | `maskDifference` |
| `maskClean(opts)` | voted (and hole-filled) decision | `closeMask` / `maskDraw` |
| `learnMask()` | the two-frame voted mask that gates learning | `learnMask` |
| `background()` | model decision + variance, advanced once | `updateBackground` |
| `velocity()` | smoothed flow field with ceiling, gate applied per params | `flowVelocity` |
| `flowReadings()` | the small readback of `velocity()` and the numbers from it | `reportReadings`'s readback |
| `history(view)` | age field + pooled directions (+ laid-down colours), advanced once | the advance half of `renderHistory` |
| `quietGate()` | magnify's mute-still-areas gate (pulls `background()`) | `quietGate` |

Memo keys name the variant: `maskRaw` is keyed by its options (blur, gradient,
auto, which pair of layers), and each variant draws into a target keyed the
same way, so two variants in one frame stop sharing `mask:raw`. Stages whose
options all come from `pipeline.params` (`background`, `velocity`, `learnMask`)
take no arguments: one canonical form per frame, options read in one place.

`renderHistory` splits into an advance half (age, laid-down velocity, gradient,
pooling — the stage) and a show half (the SHOW pass into picture and data —
stays in the mode). `renderMask` and `renderBackground` are already split that
way (`maskDraw` is the show half).

What deliberately stays mode-owned, with one consumer and heavy state:
schlieren's reference/average pair and shift solve, and magnify's EMA pyramid
in the renderer. Each becomes a stage when a second consumer exists. Posy and
Raw's diff passes live in the renderer's built-ins and stay there. The worker
fallback path is untouched.

**Where camera compensation will plug in** (next piece, not this one): a
`camera()` stage (the flow field's global fit) and one warped-sampling switch
inside `maskRaw`/`velocity` — one place instead of five mode modules.

**The mode contract** gains one line: `ModeFrame.stages`. A mode's render still
draws its picture and data; it now asks `frame.stages` for measurements instead
of calling helpers (or other modes' helpers) directly.

## What must not change

- Every mode's picture and data output, on every reference clip, including the
  combined options (measured history colours, flow gates, auto threshold,
  lighting normalisation, hole filling, magnify quiet gate).
- The parity probes' numbers (same passes, same order within each measurement).
- Preset meaning: no param keys change.
- Frame times, within noise.

## Proof plan, and what was measured

1. `npm test` (308) and `npm run typecheck`: green. ✓
2. All nine parity probes green, run headlessly (`npm run filmstrip eval`
   with a script that calls each `__motionDiff*Parity()` on the dev page). ✓
3. Filmstrips before (master `22766e9`) and after (branch), all twelve
   acceptance scene files — every mode and every combined option, 122
   scenes: **byte-identical PNGs, 122 of 122**, a stricter bar than the
   numeric guard's "invisible". The first run caught a real difference
   (2 scenes): the foreground gate's model advanced on frames whose flow
   solve never runs. Fixed by measuring the gate decision lazily; the
   re-render is identical.
4. Frame times: `traffic` stepped through 14 mode/option combinations on
   both builds, two interleaved rounds each, 40 timed frames per run
   (median of process + a 1-px readback). Every combination within ±2% —
   noise. Indicative only: software GL on this machine.
