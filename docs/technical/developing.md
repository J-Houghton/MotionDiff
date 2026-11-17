# Developing

How to run MotionDiff locally, check a change, and add a mode. Read
[How it is built](architecture.md) first.

## Running locally

```bash
npm install        # needs a current Node.js LTS release (22 or later)
npm run dev        # dev server at http://localhost:5173/MotionDiff/
npm test           # unit tests for src/core/ (Vitest, no DOM or WebGL)
npm run typecheck  # checks the JSDoc types with TypeScript; emits nothing
npm run build      # the app, then this documentation site, into dist/
npm run docs       # the documentation site alone, into dist/docs/
npm run preview    # serves dist/: the app at http://localhost:4173/MotionDiff/,
                   # this site at http://localhost:4173/MotionDiff/docs/
```

URL switches, in any build. The browser console logs the active renderer.

| Switch | Effect |
|---|---|
| `?renderer=canvas2d` | Uses the Canvas 2D fallback even where WebGL2 works |
| `?nofloat` | Behaves as a GPU without float render targets would |
| `?detdtype=fp32` | Pins *Name the movers* to 32-bit weights on WebGPU |
| `?modelfault=<rung>:<stage>` | Makes a model backend fail on purpose. `<rung>` is `all`, `webgpu`, `wasm` or one rung such as `webgpu/fp16`; `<stage>` is `load`, `prove` or `look` |

## Tests and parity probes

Unit tests cover the pure functions in `src/core/`. The shaders are checked
against those functions in a real browser: in a dev build, on an idle page,
call a probe in the console, for example `__motionDiffMaskParity()`. The
full list is at the end of [`src/main.js`](../../src/main.js). Each runs
the same synthetic frames through both and reports the difference (8-bit
results should agree within about 2/255). Run them after touching a shader
or its core function.

`npm run filmstrip` is the visual tooling: it drives the running dev server
through headless Chrome to render strips of frames from a clip, compare two
strips, check a mode against synthetic scenes with known motion, and take
the pictures in this documentation. See [scripts/README.md](../../scripts/README.md).

## Adding a mode

1. Write the algorithm as pure functions in `src/core/<name>.js`, with
   tests in `src/core/__tests__/`. It may import nothing.
2. Add `src/app/modes/<name>.js`: a default export that follows the `Mode`
   typedef in [`app/modes/index.js`](../../src/app/modes/index.js) (`id`,
   `label`, `blurb`, `help`, `params`, `data`, `render(frame)`), with its
   shaders. Import it in `index.js` and add it to `MODES`. Controls are
   plain data ([`params.js`](../../src/app/modes/params.js)); the panel and
   the help sheet are generated from them.
3. In `render`, draw the picture, and draw the data into
   `renderer.dataFramebuffer()` with an unsigned magnitude in the red
   channel. Ask for every `renderer.target()` and the data framebuffer
   before binding textures.
4. To show it as a choice under the picture, add it to an effect in
   [`app/effects.js`](../../src/app/effects.js): its id in `modes`, and an
   option under `choices`. Otherwise it is reachable only from **Mode** in
   the panel.
5. Add a parity probe in `src/app/probes.js`, registered in `src/main.js`.

Rules that keep modes consistent:

- In Posy space 128 means no motion (`128.0 / 255.0` in a shader, not
  `0.5`); in Raw space the baseline is 0.
- Nothing a person sets may count processed frames. Use media time
  (`frame.time`, `frame.dtMs`).
- A mode with feedback state keeps two targets, recomputes instead of
  advancing when `frame.step === 'repeat'` (use `frame.stepMs`), and
  starts over when `renderer.epoch` changes.
- A mode may be WebGL-only (`worker: false`) or need float targets
  (`needsFloat: true`). Posy, Raw diff and Magnify must keep working on
  the fallback.

## Documentation and deployment

The pages of this site are the markdown files in `docs/`.
[`scripts/build-docs.mjs`](../../scripts/build-docs.mjs) renders them with
`markdown-it`, a dev dependency, into `dist/docs/`: `npm run build` runs it
after the app build, `npm run docs` runs it alone. The build fails on a
broken link or a missing image. To add a page, create the `.md` file and
add it to the `NAV` list at the top of the script.

[`.github/workflows/deploy.yml`](../../.github/workflows/deploy.yml) runs
the tests and `npm run build` on every push to `master` and publishes
`dist/` to GitHub Pages (the repository's Pages source must be "GitHub
Actions"), under `/MotionDiff/`, the `base` in `vite.config.js`.

Design notes, the log of what was tested and found, and the rules a change
was accepted by are in [records/](../../records/README.md).
