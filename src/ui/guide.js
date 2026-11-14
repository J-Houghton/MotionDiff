/**
 * Schlieren setup guide: a step-by-step card in the picture, so a first-time
 * user reaches a working setup without the help sheet.
 *
 * The steps follow the mode's own judgement of the setup, published by the
 * measurement side as `pipeline.readings` (mode 'schlieren', `setup`:
 * problem 'plain'|'moved'|'shaking'|'settling'|null, usable 0..1, camera
 * {dx, dy} px, noise px, seen frames, held). The card works without
 * readings too — the steps then show no live state, which is still the
 * checklist — and never trusts the field to exist: it goes null whenever a
 * mode reports none, and schlieren does not run on the Canvas 2D fallback.
 *
 * Opens by itself the first time schlieren meets a live camera (the setup
 * case); a Guide chip on the stage reopens it any time in schlieren.
 */

const STEPS = [
  ['background', 'Textured background', 'Put detail a metre behind the hot air: print the pattern, or brick, gravel, foliage, a bookshelf.'],
  ['steady', 'Camera still', 'Prop the phone against something solid. Touching it shows as signal.'],
  ['settle', 'Let it settle', 'Give the reference a few seconds with nothing hot in view.'],
  ['hold', 'Hold, then light', 'Switch on Hold reference, then light the candle: everything that changes is shown.'],
];

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

/**
 * @param {object} options
 * @param {HTMLElement} options.stage
 * @param {import('../app/session.js').Session} options.session
 * @returns {{update: () => void}}
 */
export function initGuide({ stage, session }) {
  const card = el('aside', 'guide chrome');
  card.setAttribute('aria-label', 'Schlieren setup guide');
  card.hidden = true;
  const head = el('div', 'guide-head');
  const close = el('button', 'guide-close', '✕');
  close.type = 'button';
  close.setAttribute('aria-label', 'Close the setup guide');
  head.append(el('b', '', 'Schlieren setup'), close);
  const list = el('ol', 'guide-steps');
  const steps = new Map();
  for (const [key, title, hint] of STEPS) {
    const item = el('li');
    item.dataset.state = 'idle';
    const detail = el('span', 'guide-detail');
    const row = el('div', 'guide-title');
    row.append(el('b', '', title), detail);
    item.append(row, el('p', '', hint));
    steps.set(key, { item, detail });
    list.append(item);
  }
  card.append(head, list);
  stage.append(card);

  const chip = el('button', 'guide-chip chrome', 'Setup guide');
  chip.type = 'button';
  chip.hidden = true;
  stage.append(chip);

  let open = false;
  let autoOpened = false; // once per source, so closing it stays closed
  let timer = 0;
  close.addEventListener('click', () => { open = false; update(); });
  chip.addEventListener('click', () => { open = true; update(); });

  const set = (key, state, text) => {
    const step = steps.get(key);
    step.item.dataset.state = state;
    step.detail.textContent = text || '';
  };

  function refresh() {
    const readings = session.pipeline.readings;
    const setup = readings && readings.mode === 'schlieren' ? readings.setup : null;
    if (!setup) {
      for (const key of steps.keys()) set(key, 'idle');
      return;
    }
    const problem = setup.problem || null;
    const usable = Number.isFinite(setup.usable) ? setup.usable : null;
    set('background',
      problem === 'plain' ? 'warn' : usable !== null && usable >= 0.5 ? 'ok' : 'wait',
      usable !== null ? `${Math.round(usable * 100)}% measurable` : '');
    const shake = Math.hypot(setup.camera?.dx || 0, setup.camera?.dy || 0);
    set('steady',
      problem === 'shaking' || problem === 'moved' ? 'warn' : 'ok',
      problem === 'moved' ? 'moved off the held reference' : `${shake.toFixed(1)} px`);
    set('settle',
      problem === 'settling' ? 'wait' : 'ok',
      problem === 'settling' ? 'settling…' : '');
    set('hold',
      setup.held ? 'ok' : 'idle',
      setup.held ? 'held — light the candle' : '');
  }

  function update() {
    const schlieren = session.mode.id === 'schlieren' && session.loaded;
    // The setup case: schlieren meets a live camera for the first time.
    if (schlieren && !autoOpened && session.source?.kind === 'camera') {
      autoOpened = true;
      open = true;
    }
    if (!schlieren) autoOpened = false;
    chip.hidden = !schlieren || open;
    card.hidden = !schlieren || !open;
    clearInterval(timer);
    timer = 0;
    if (!card.hidden) {
      refresh();
      timer = setInterval(refresh, 300);
    }
  }

  update();
  return { update };
}
