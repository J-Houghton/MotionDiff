/**
 * The time ruler: "now" on the right, the past to the left. It shows where
 * each colour channel looks back to and how long a trail lasts, and edits
 * all three in place. Markers are sliders: drag them, or focus one and use
 * the arrow keys.
 *
 * Works for any mode whose params include `frameOffset`; `channelSpread` and
 * `trailLength` add their markers when the mode has them. Other modes show
 * their `summary(params)` sentence instead.
 */
import { asMs } from '../app/modes/params.js';

const UNIT_SECONDS = 1 / 30;
const SPANS = [1, 1.5, 2, 3, 4, 6];

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

/**
 * @param {object} options
 * @param {HTMLElement} options.container
 * @param {import('../app/session.js').Session} options.session
 * @returns {{update: () => void}}
 */
export function initRuler({ container, session }) {
  container.innerHTML = '';
  const track = el('div', 'ruler-track');
  const trail = el('div', 'ruler-trail');
  const ticks = el('div', 'ruler-ticks');
  const axis = el('div', 'ruler-axis');
  const labels = [el('span', 'ruler-lab'), el('span', 'ruler-lab'), el('span', 'ruler-lab ruler-lab-now', 'now')];
  const now = el('div', 'ruler-now');
  const readout = el('p', 'ruler-readout');

  /** One draggable marker bound to a param. */
  function marker(className, param, label, fromUnits, toUnits) {
    const node = el('div', `ruler-mark ${className}`);
    const tag = el('b');
    node.append(tag);
    node.tabIndex = 0;
    node.setAttribute('role', 'slider');
    node.setAttribute('aria-label', label);
    const set = (value) => {
      const def = session.mode.params.find((p) => p.key === param);
      if (!def) return;
      const clamped = Math.min(def.max, Math.max(def.min, Math.round(value)));
      if (clamped !== session.params[param]) session.setParams({ [param]: clamped });
    };
    node.addEventListener('pointerdown', (event) => { node.setPointerCapture(event.pointerId); event.preventDefault(); node.focus(); });
    node.addEventListener('pointermove', (event) => {
      if (!node.hasPointerCapture(event.pointerId)) return;
      const rect = track.getBoundingClientRect();
      const secondsBack = ((rect.right - event.clientX) / rect.width) * span;
      set(toUnits(secondsBack / UNIT_SECONDS));
    });
    node.addEventListener('keydown', (event) => {
      // Left is further into the past, as drawn.
      const step = event.key === 'ArrowLeft' ? 1 : event.key === 'ArrowRight' ? -1 : 0;
      if (!step) return;
      event.preventDefault();
      event.stopPropagation();
      set(session.params[param] + step * (event.shiftKey ? 5 : 1));
    });
    return { node, tag, fromUnits };
  }

  let span = 1;
  const markR = marker('ruler-mark-r', 'frameOffset', 'Gap', (p) => p.frameOffset, (units) => units);
  // Dragging the blue marker sets the spread: it sits two spreads beyond the gap.
  const markB = marker('ruler-mark-b', 'channelSpread', 'RGB spread', (p) => p.frameOffset + p.channelSpread * 2, (units) => (units - session.params.frameOffset) / 2);
  const markG = el('div', 'ruler-mark ruler-mark-g');
  markG.append(el('b'));
  // The second frame the mask compares against (always behind the gap).
  const mark2 = marker('ruler-mark-2', 'secondGap', 'Second gap', (p) => Math.max(p.secondGap, p.frameOffset + 1), (units) => units);
  const markTrail = marker('ruler-mark-trail', 'trailLength', 'Trail length', (p) => p.trailLength, (units) => units);
  const markHistory = marker('ruler-mark-trail', 'historyLength', 'History length', (p) => p.historyLength, (units) => units);

  track.append(trail, ticks, axis, ...labels, markTrail.node, markHistory.node, markB.node, markG, mark2.node, markR.node, now);
  container.append(track, readout);

  const place = (node, units) => { node.style.right = `${Math.min(100, ((units * UNIT_SECONDS) / span) * 100)}%`; };

  function update() {
    const mode = session.mode;
    const params = session.params;
    const has = (key) => mode.params.some((p) => p.key === key);

    if (!has('frameOffset')) {
      // No lookback to draw: the mode says in a sentence what its settings
      // amount to (the panel already lists the numbers).
      track.hidden = true;
      readout.hidden = false;
      readout.textContent = mode.summary ? mode.summary(params) : '';
      return;
    }
    track.hidden = false;
    readout.hidden = true;

    const spread = has('channelSpread') ? params.channelSpread : 0;
    const trailUnits = has('trailLength') ? params.trailLength : 0;
    const historyUnits = has('historyLength') ? params.historyLength : 0;
    const secondUnits = has('secondGap') ? Math.max(params.secondGap, params.frameOffset + 1) : 0;
    const reach = Math.max(
      (params.frameOffset + spread * 2) * 1.2,
      secondUnits * 1.2,
      trailUnits * 1.1,
      historyUnits * 1.1,
    ) * UNIT_SECONDS;
    span = SPANS.find((s) => s >= reach) || SPANS[SPANS.length - 1];
    labels[0].textContent = `−${span} s`;
    labels[1].textContent = `−${span / 2} s`;
    ticks.style.setProperty('--ruler-step', `${(0.1 / span) * 100}%`);

    place(markR.node, params.frameOffset);
    markR.tag.textContent = spread > 0 ? `R ${asMs(params.frameOffset)}` : `GAP ${asMs(params.frameOffset)}`;
    markR.node.setAttribute('aria-valuetext', asMs(params.frameOffset));

    markG.hidden = markB.node.hidden = !(has('channelSpread') && spread > 0);
    if (spread > 0) {
      place(markG, params.frameOffset + spread);
      markG.firstChild.textContent = `G ${asMs(params.frameOffset + spread)}`;
      place(markB.node, params.frameOffset + spread * 2);
      markB.tag.textContent = `B ${asMs(params.frameOffset + spread * 2)}`;
      markB.node.setAttribute('aria-valuetext', `${asMs(spread)} per channel`);
    }

    mark2.node.hidden = !secondUnits;
    if (secondUnits) {
      place(mark2.node, secondUnits);
      mark2.tag.textContent = `2ND ${asMs(secondUnits)}`;
      mark2.node.setAttribute('aria-valuetext', asMs(secondUnits));
    }

    // One hatched band: how long a mark stays in the picture (the trail, or
    // the history of the modes built on the mask).
    const bandUnits = trailUnits || historyUnits;
    trail.hidden = !bandUnits;
    markTrail.node.hidden = !trailUnits;
    markHistory.node.hidden = !historyUnits;
    if (bandUnits) {
      trail.style.width = `${Math.min(100, ((bandUnits * UNIT_SECONDS) / span) * 100)}%`;
      const mark = trailUnits ? markTrail : markHistory;
      place(mark.node, bandUnits);
      mark.tag.textContent = `${trailUnits ? 'TRAIL' : 'HISTORY'} ${asMs(bandUnits)}`;
      mark.node.setAttribute('aria-valuetext', asMs(bandUnits));
    }
  }

  update();
  return { update };
}
