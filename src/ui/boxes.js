/**
 * Tracked movers drawn over the picture (records/design/tracking.md): one thin box
 * per track, its ID and measured speed on a small plate, and an arrow one
 * lead-second ahead along its velocity. Reads pipeline.readings.objects —
 * the interface draws what the measurement published, nothing more.
 *
 * An SVG in picture coordinates laid over the stage: in the Plate the frame
 * is the picture, in the Viewfinder the overlay is inset (letterbox) or
 * overhung (crop) to keep registration with the drawn pixels.
 */

import { formatSpeed } from './calibrate.js';

/** Seconds of travel the arrow ahead of a box shows. */
const LEAD_SECONDS = 1;

const SVG = 'http://www.w3.org/2000/svg';

export function initBoxes({ root, stage, session }) {
  const svg = document.createElementNS(SVG, 'svg');
  svg.setAttribute('class', 'boxes');
  svg.setAttribute('preserveAspectRatio', 'none');
  svg.setAttribute('aria-hidden', 'true');
  const defs = document.createElementNS(SVG, 'defs');
  defs.innerHTML = '<marker id="boxesHead" viewBox="0 0 8 8" refX="6" refY="4" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0 0 L8 4 L0 8 Z"/></marker>';
  svg.append(defs);
  stage.append(svg);

  /** @type {Map<number, {g: SVGGElement, rect: SVGRectElement, label: SVGTextElement, arrow: SVGLineElement}>} */
  const nodes = new Map();
  // The model's own finds (records/design/naming.md): what the detector saw that
  // no track covers, drawn as dashed estimates. Rebuilt each draw — a look
  // returns a handful at most.
  const finds = document.createElementNS(SVG, 'g');
  finds.setAttribute('class', 'boxes-model');
  svg.append(finds);

  function place() {
    // Where the picture's pixels actually are inside the stage element.
    const layout = root.dataset.layout;
    if (layout !== 'viewfinder') {
      svg.style.inset = '0';
      return;
    }
    const { width: pw, height: ph } = session.pipeline;
    const box = stage.getBoundingClientRect();
    if (!pw || !ph || !box.width || !box.height) return;
    if (root.dataset.fit === 'whole') {
      svg.style.inset = `var(--pic-top, 0%) var(--pic-side, 0%)`;
    } else {
      // Crop to fill: the picture overhangs the stage on one axis.
      const scale = Math.max(box.width / pw, box.height / ph);
      const overX = Math.max(0, (pw * scale - box.width) / 2);
      const overY = Math.max(0, (ph * scale - box.height) / 2);
      svg.style.inset = `${-overY}px ${-overX}px`;
    }
  }

  function draw() {
    const readings = session.pipeline.readings;
    const objects = readings?.objects;
    if (!objects || !session.loaded || session.display === 'data') {
      svg.style.display = 'none';
      return;
    }
    svg.style.display = '';
    const pw = readings.width || session.pipeline.width;
    const ph = readings.height || session.pipeline.height;
    svg.setAttribute('viewBox', `0 0 ${pw} ${ph}`);
    place();
    const fontSize = Math.max(11, Math.round(pw / 52));

    const alive = new Set();
    for (const o of objects) {
      alive.add(o.id);
      let n = nodes.get(o.id);
      if (!n) {
        const g = document.createElementNS(SVG, 'g');
        const rect = document.createElementNS(SVG, 'rect');
        const arrow = document.createElementNS(SVG, 'line');
        arrow.setAttribute('marker-end', 'url(#boxesHead)');
        const plate = document.createElementNS(SVG, 'rect');
        plate.setAttribute('class', 'boxes-plate');
        const label = document.createElementNS(SVG, 'text');
        g.append(arrow, rect, plate, label);
        svg.append(g);
        n = { g, rect, label, arrow, plate };
        nodes.set(o.id, n);
      }
      n.g.setAttribute('opacity', o.coasting ? '0.45' : '1');
      // How the model's last look saw this track: 'both' keeps the accent,
      // 'motion' goes dashed — found by motion only. Unset before a look.
      const agree = session.agreeFor(o.id);
      if (agree) n.g.dataset.agree = agree;
      else delete n.g.dataset.agree;
      n.rect.setAttribute('x', o.x.toFixed(1));
      n.rect.setAttribute('y', o.y.toFixed(1));
      n.rect.setAttribute('width', o.w.toFixed(1));
      n.rect.setAttribute('height', o.h.toFixed(1));

      // The arrow: from the box's leading edge, one lead-second of travel.
      const speed = o.speed;
      if (speed > 2) {
        const ux = o.vx / speed;
        const uy = o.vy / speed;
        const fromX = o.cx + ux * (o.w / 2);
        const fromY = o.cy + uy * (o.h / 2);
        const len = Math.min(speed * LEAD_SECONDS, pw / 4);
        n.arrow.setAttribute('x1', fromX.toFixed(1));
        n.arrow.setAttribute('y1', fromY.toFixed(1));
        n.arrow.setAttribute('x2', (fromX + ux * len).toFixed(1));
        n.arrow.setAttribute('y2', (fromY + uy * len).toFixed(1));
        n.arrow.style.display = '';
      } else {
        n.arrow.style.display = 'none';
      }

      // A box too small to read a label beside gets only its box: the far
      // field stays legible.
      const labelled = o.w * o.h >= 1800;
      n.label.style.display = labelled ? '' : 'none';
      n.plate.style.display = labelled ? '' : 'none';
      const name = session.nameFor(o.id);
      // With depth on, the shown speed is scaled to the scene's median
      // depth and marked as the estimate it is (records/design/depth-stage.md);
      // where the map declined, the plain measured speed stands.
      const shownSpeed = o.depthFactor ? `≈${formatSpeed(speed * o.depthFactor, session.calibration)}` : formatSpeed(speed, session.calibration);
      const text = `${o.id} · ${shownSpeed}${name ? ` · ≈${name.label}` : ''}`;
      n.label.textContent = text;
      n.label.setAttribute('font-size', String(fontSize));
      const lx = Math.max(2, o.x);
      const ly = Math.max(fontSize + 2, o.y - 4);
      n.label.setAttribute('x', (lx + 3).toFixed(1));
      n.label.setAttribute('y', (ly - 3).toFixed(1));
      n.plate.setAttribute('x', lx.toFixed(1));
      n.plate.setAttribute('y', (ly - fontSize - 4).toFixed(1));
      n.plate.setAttribute('width', String(Math.round(text.length * fontSize * 0.62) + 6));
      n.plate.setAttribute('height', String(fontSize + 6));
    }
    for (const [id, n] of nodes) {
      if (!alive.has(id)) { n.g.remove(); nodes.delete(id); }
    }

    // Model-only finds: where the model saw something at its last look —
    // an ageing estimate, not a track, and drawn to say so. The detector
    // hands over only those still worth drawing, each with its strength:
    // a find fades to nothing and is gone (core/finds.js).
    finds.textContent = '';
    for (const f of session.modelFinds() || []) {
      const g = document.createElementNS(SVG, 'g');
      g.setAttribute('opacity', f.opacity.toFixed(2));
      const rect = document.createElementNS(SVG, 'rect');
      rect.setAttribute('x', f.x.toFixed(1));
      rect.setAttribute('y', f.y.toFixed(1));
      rect.setAttribute('width', f.w.toFixed(1));
      rect.setAttribute('height', f.h.toFixed(1));
      g.append(rect);
      if (f.w * f.h >= 1800) {
        const text = `≈${f.label}`;
        const plate = document.createElementNS(SVG, 'rect');
        plate.setAttribute('class', 'boxes-plate');
        const label = document.createElementNS(SVG, 'text');
        label.textContent = text;
        label.setAttribute('font-size', String(fontSize));
        const lx = Math.max(2, f.x);
        const ly = Math.min(ph - 4, f.y + f.h + fontSize + 2);
        label.setAttribute('x', (lx + 3).toFixed(1));
        label.setAttribute('y', (ly - 2).toFixed(1));
        plate.setAttribute('x', lx.toFixed(1));
        plate.setAttribute('y', (ly - fontSize - 3).toFixed(1));
        plate.setAttribute('width', String(Math.round(text.length * fontSize * 0.62) + 6));
        plate.setAttribute('height', String(fontSize + 5));
        g.append(plate, label);
      }
      finds.append(g);
    }
  }

  (function loop() { draw(); requestAnimationFrame(loop); })();
  return { update: draw };
}
