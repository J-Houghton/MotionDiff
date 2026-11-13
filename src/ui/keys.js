/**
 * The keyboard map. Everything the interface can do has a key; this table
 * is both what the handler runs and what the help sheet lists.
 */

/** [keys shown in help, what it does, action name] */
export const SHORTCUTS = [
  ['Space', 'Play / pause', 'toggle'],
  ['← →', 'Step one frame', null],
  ['J  L', 'Slower / faster', null],
  ['1 – 9', 'Mode', null],
  ['[  ]', 'Gap shorter / longer', null],
  ['-  =', 'Threshold lower / higher', null],
  [',  .', 'Trail shorter / longer', null],
  ['D', 'Display: diff, overlay, glow, data', 'display'],
  ['S', 'Split compare against the original', 'split'],
  ['O', 'Hold to see the original', null],
  ['P', 'Parameters', 'panel'],
  ['N', 'Choose a source', 'source'],
  ['A', 'Auto-configure gap and threshold', 'auto'],
  ['R', 'Record / stop', 'record'],
  ['F', 'Fullscreen viewfinder', 'fullscreen'],
  ['H', 'Hide everything but the picture', 'hide'],
  ['T', 'Light / dark', 'theme'],
  ['?', 'This list', 'keys'],
  ['Esc', 'Close', 'escape'],
];

const SINGLE = {
  ' ': 'toggle', k: 'toggle', d: 'display', s: 'split', p: 'panel', n: 'source', a: 'auto',
  r: 'record', f: 'fullscreen', h: 'hide', t: 'theme', '?': 'keys', '/': 'keys', Escape: 'escape',
};

/** Keys that nudge a param: [param, direction]. */
const NUDGE = {
  '[': ['frameOffset', -1], ']': ['frameOffset', 1],
  '-': ['threshold', -2], '=': ['threshold', 2], '+': ['threshold', 2],
  ',': ['trailLength', -1], '.': ['trailLength', 1],
};

function isTyping(target) {
  if (!target || !target.closest) return false;
  if (target.closest('[contenteditable="true"], textarea, select')) return true;
  const input = target.closest('input');
  return Boolean(input && !['range', 'checkbox', 'button'].includes(input.type));
}

/**
 * @param {Record<string, Function>} actions - toggle, display, split, panel,
 *   source, auto, record, fullscreen, hide, theme, keys, escape, plus
 *   step(frames), rate(direction), mode(index), nudge(param, direction),
 *   original(held)
 */
export function initKeys(actions) {
  document.addEventListener('keydown', (event) => {
    if (event.ctrlKey || event.metaKey || event.altKey) return;
    if (event.key === 'Escape') { actions.escape(); return; }
    if (isTyping(event.target)) return;
    // A focused slider (split, ruler marker, scrubber, a pane slider) owns
    // its own arrow keys.
    const onSlider = event.target.closest?.('[role="slider"], input[type="range"]');
    // Space and Enter belong to a focused button.
    const onButton = event.target.closest?.('button, a, summary');

    const key = event.key.length === 1 ? event.key.toLowerCase() : event.key;
    if (key === ' ' && onButton) return;

    if (key === 'ArrowLeft' || key === 'ArrowRight') {
      if (onSlider) return;
      event.preventDefault();
      actions.step(key === 'ArrowLeft' ? -1 : 1);
    } else if (key === 'j' || key === 'l') {
      actions.rate(key === 'j' ? -1 : 1);
    } else if (key === 'o') {
      if (!event.repeat) actions.original(true);
    } else if (key >= '1' && key <= '9') {
      actions.mode(Number(key) - 1);
    } else if (NUDGE[key]) {
      actions.nudge(...NUDGE[key]);
    } else if (SINGLE[key]) {
      event.preventDefault();
      if (!event.repeat) actions[SINGLE[key]]();
    }
  });

  document.addEventListener('keyup', (event) => {
    if (event.key.toLowerCase() === 'o') actions.original(false);
  });
}
