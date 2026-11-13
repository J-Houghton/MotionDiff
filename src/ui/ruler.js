/**
 * The time ruler: "now" on the right, the past to the left. It shows where
 * each colour channel looks back to and how long a trail lasts, and edits
 * all three in place. Markers are sliders: drag them, or focus one and use
 * the arrow keys.
 *
 * Works for any mode whose params include `frameOffset`; `channelSpread` and
 * `trailLength` add their markers when the mode has them. Other modes get a
 * plain readout of their first few params instead.
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
  now.append(el('b', '', 'NOW'));
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
  const markTrail = marker('ruler-mark-trail', 'trailLength', 'Trail length', (p) => p.trailLength, (units) => units);

  track.append(trail, ticks, axis, ...labels, markTrail.node, markB.node, markG, markR.node, now);
  container.append(track, readout);

  const place = (node, units) => { node.style.right = `${Math.min(100, ((units * UNIT_SECONDS) / span) * 100)}%`; };

  function update() {
    const mode = session.mode;
    const params = session.params;
    const has = (key) => mode.params.some((p) => p.key === key);

    if (!has('frameOffset')) {
      // No lookback to draw: show the mode's main settings as text.
      track.hidden = true;
      readout.hidden = false;
      readout.textContent = mode.params
        .filter((p) => p.type === 'range' && (!p.when || p.when(params)))
        .slice(0, 4)
        .map((p) => `${p.label} ${p.format ? p.format(params[p.key]) : params[p.key]}`)
        .join('   ·   ');
      return;
    }
    track.hidden = false;
    readout.hidden = true;

    const spread = has('channelSpread') ? params.channelSpread : 0;
    const trailUnits = has('trailLength') ? params.trailLength : 0;
    const reach = Math.max((params.frameOffset + spread * 2) * 1.2, trailUnits * 1.1) * UNIT_SECONDS;
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

    trail.hidden = markTrail.node.hidden = !has('trailLength');
    if (has('trailLength')) {
      trail.style.width = `${Math.min(100, ((trailUnits * UNIT_SECONDS) / span) * 100)}%`;
      place(markTrail.node, trailUnits);
      markTrail.tag.textContent = `TRAIL ${asMs(trailUnits)}`;
      markTrail.node.setAttribute('aria-valuetext', asMs(trailUnits));
    }
  }

  update();
  return { update };
}
