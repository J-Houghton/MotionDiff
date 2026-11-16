# The backend ladder proves a look (session 9 design note)

The two model workers (naming, docs/naming-poc.md; depth,
docs/depth-stage.md) each walk a ladder of backends — **WebGPU fp16,
WebGPU fp32, wasm q8** — and use the first that works. Until now "works"
meant "loads". This note changes it to **"loads and answers one look"**,
and says what happens when a look fails later.

## What broke (the owner's desktop, 2026-11-16; reproduced here)

*Name the movers* loaded, said `Naming is on (webgpu/fp32)`, and then
every look failed with

    The detector failed a look: using ceil() in shape computation is not
    yet supported for AveragePool

RT-DETR's backbone has AveragePool nodes with `ceil_mode=1`. The WebGPU
backend in the pinned runtime (Transformers.js 3.8.1) accepts the graph
when the session is built and rejects those nodes when it first computes
their output shape — at run time. The ladder only tested loading, so it
stopped on the GPU, reported ready, and had no way down. The same model
runs on wasm. Depth shares runtime, ladder and machine and works: the
fault is the detector's graph on that backend, not the ladder's order.

Reproduced on current master in this machine's headless Chrome, which has
a real WebGPU adapter (Intel Xe): in 30 s of `traffic` the status line
took that error 52 times and no look ever completed.

## The rule

1. **A rung is proved, not just loaded.** Inside `load()`, after the
   pipeline is built, each worker runs one throwaway inference on a small
   grey picture and only then posts `ready`. A failure is reported with
   its stage: `load` (fetching, compiling) or `prove` (the throwaway
   look). Either fails the rung and the ladder steps down, each rung in a
   fresh worker as before. For depth this is insurance only.
2. **A look that fails after `ready` steps down once**, to the next rung,
   which is proved the same way before it is used. Nothing is posted per
   look: the status line says once that it is stepping down, then where
   it landed. A worker that dies outright counts as a failed look.
3. **On the last rung there is nowhere to go**: the first failed look of
   a streak is reported once; three in a row and the option switches
   itself off with a sentence, the way it does when it cannot load. A
   look that succeeds ends the streak.
4. **The status line says where and why in words** whenever the ladder
   stepped down: `Naming is running on the CPU (wasm/q8) because the GPU
   backend can't run this model`. The raw failures go to the console (as
   before) and into the copied readings. When the first rung proves, the
   sentences are the ones already there (`Depth is on (webgpu/fp16): …`).

## Where it lives

- `core/ladder.js` — pure, unit-tested: the rungs in order
  (`ladderRungs`), the step-down decision as a small state machine
  (`startLadder`, `stepLadder`), the words (`landedWords`,
  `gaveUpWords`), and the triage switch's parser (`faultFor`).
- `app/modelladder.js` — the one driver both models use: spawns a fresh
  worker per rung, feeds `stepLadder` with what happened, and tells its
  owner when a look failed, when it landed, and when it gave up.
  `app/detect.js` and `app/depthstage.js` keep what is theirs (throttle,
  snapshots, matching, the latest map) and lose their copies of the
  ladder loop.
- The workers gain the throwaway look and a `stage` on their error
  message; nothing else in them changes.

## Triage switch

`?modelfault=<rung>:<stage>[,…]` makes a rung fail on purpose, so every
branch above can be seen on a machine whose backends all work. `<rung>`
is `all`, a device (`webgpu`, `wasm`) or one rung (`webgpu/fp16`);
`<stage>` is `load`, `prove` or `look` (every real look after `ready`).
`?modelfault=webgpu:prove` is the owner's fault in miniature. Inert
without the parameter. `?detdtype=` still pins the detector's GPU rung.

## What it costs, and what it does not cover

- One extra inference per rung tried: load takes longer by about one
  look (measured in the verdict). On WebGPU that look also compiles the
  shaders the first real look would have compiled.
- A look that **hangs** after `ready` (no answer, no error) is not
  detected; only the load-and-prove phase has a timeout.
- This did not give naming its GPU back: it made the failure honest and
  landed on the CPU. The GPU came back afterwards by moving the
  detector's worker alone to Transformers.js 4.3.2 (docs/naming-poc.md,
  "M-1 again" in the verdicts); the ladder is unchanged by that and
  still lands on the CPU where the GPU rungs fail.

## Acceptance (L-1, registered before building)

See docs/verdicts.md, Session 9.
