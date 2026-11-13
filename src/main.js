import { PHONE_DEFAULTS, Session } from './app/session.js';
import { buildShell, initShell } from './ui/shell.js';

const query = new URLSearchParams(window.location.search);
// Phones and tablets get the viewfinder layout (ui/shell.js uses the same
// query), a smaller processing size and a smaller frame-ring budget.
const phone = window.matchMedia('(max-width: 720px), (pointer: coarse)').matches;

const root = document.getElementById('app');
const { video, canvas } = buildShell(root);

const session = new Session({
  video,
  canvas,
  // ?renderer=canvas2d runs the worker fallback even where WebGL2 is available.
  forceCanvas2D: query.get('renderer') === 'canvas2d',
  // ?nofloat behaves as a GPU without float render targets would.
  noFloat: query.has('nofloat'),
  processWidth: phone ? PHONE_DEFAULTS.processWidth : undefined,
  ringBudgetBytes: phone ? PHONE_DEFAULTS.ringBudgetBytes : undefined,
});

initShell({ root, session });

if (session.webgl && !session.floatTargets) {
  session.setStatus('This GPU lacks float render targets: Magnify and the newer modes are unavailable', 'info');
}

if (import.meta.env.DEV) {
  // What scripts/filmstrip.mjs and one-off checks drive the app through.
  window.__motionDiff = {
    session,
    pipeline: session.pipeline,
    video,
    canvas,
    load: (blob, name) => session.loadFile(new File([blob], name, { type: blob.type || 'video/mp4' })),
    pause: async () => session.pause(),
    setWidth: (width) => session.setWidth(width),
    setDisplay: (display) => session.setDisplay(display),
    setParams: (params) => session.setParams(params),
    stepTo: (time) => session.stepTo(time),
  };
  // Shader-vs-core parity probes (see CLAUDE.md).
  import('./app/probes.js').then((probes) => {
    window.__motionDiffDiffParity = () => probes.debugDiffParity(session.pipeline);
    window.__motionDiffTrailParity = () => probes.debugTrailParity(session.pipeline);
    window.__motionDiffEnergyParity = (cols, rows) => probes.debugEnergyParity(session.pipeline, cols, rows);
  });
}
