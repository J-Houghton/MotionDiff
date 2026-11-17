/**
 * The count line (records/design/data-out.md): the user draws a line across the
 * picture with two clicks — calibrate.js's interaction and picture-space
 * SVG mapping — and every tracked box whose centre steps across it is
 * counted, by direction (the counting itself lives in the session, from
 * core/dataout.js). The drawn line stays visible while it counts; X again
 * clears it, Escape cancels drawing.
 */

const SVG = 'http://www.w3.org/2000/svg';

export function initCountLine({ root, stage, session }) {
  const svg = document.createElementNS(SVG, 'svg');
  svg.setAttribute('class', 'countline');
  svg.setAttribute('preserveAspectRatio', 'none');
  svg.style.display = 'none';
  const line = document.createElementNS(SVG, 'line');
  const a = document.createElementNS(SVG, 'circle');
  const b = document.createElementNS(SVG, 'circle');
  a.setAttribute('r', '4');
  b.setAttribute('r', '4');
  svg.append(line, a, b);
  stage.append(svg);

  let arming = false;
  let first = null;

  /** Stage event position → picture pixels (the boxes overlay's mapping). */
  function toPicture(event) {
    const { width: pw, height: ph } = session.pipeline;
    const box = svg.getBoundingClientRect();
    if (!pw || !ph || !box.width || !box.height) return null;
    const x = ((event.clientX - box.left) / box.width) * pw;
    const y = ((event.clientY - box.top) / box.height) * ph;
    return { x: Math.min(pw, Math.max(0, x)), y: Math.min(ph, Math.max(0, y)) };
  }

  function place() {
    // The .boxes overlay solved the letterbox mapping already: copy it.
    const boxes = stage.querySelector('.boxes');
    svg.style.inset = boxes ? boxes.style.inset || '0' : '0';
    const { width: pw, height: ph } = session.pipeline;
    if (pw && ph) svg.setAttribute('viewBox', `0 0 ${pw} ${ph}`);
  }

  function draw(set) {
    if (!set) { svg.style.display = 'none'; return; }
    place();
    line.setAttribute('x1', String(set.x1));
    line.setAttribute('y1', String(set.y1));
    line.setAttribute('x2', String(set.x2));
    line.setAttribute('y2', String(set.y2));
    line.style.display = '';
    a.setAttribute('cx', String(set.x1));
    a.setAttribute('cy', String(set.y1));
    b.setAttribute('cx', String(set.x2));
    b.setAttribute('cy', String(set.y2));
    a.style.display = '';
    b.style.display = '';
    svg.style.display = '';
    svg.style.pointerEvents = 'none'; // set lines never swallow taps
  }

  function stop() {
    arming = false;
    first = null;
    draw(session.countLine);
    root.dataset.counting = 'false';
  }

  function start() {
    if (!session.loaded) {
      session.setStatus('Load footage first, then draw a line to count movers over', 'info');
      return;
    }
    // Counting follows the tracked boxes: turn them on where the mode has them.
    const algorithm = session.params.algorithm;
    if (algorithm !== 'mask' && algorithm !== 'background') {
      session.setStatus('Counting follows tracked boxes: pick the Cut out effect first (its "Movers: boxed & numbered" choice)', 'error');
      return;
    }
    if (!session.params.maskTrack) session.setParams({ maskTrack: true });
    arming = true;
    first = null;
    place();
    svg.style.display = '';
    svg.style.pointerEvents = '';
    line.style.display = 'none';
    a.style.display = 'none';
    b.style.display = 'none';
    root.dataset.counting = 'true';
    session.setStatus('Count line: click both ends of the line movers should cross', 'info');
  }

  svg.addEventListener('pointerdown', (event) => {
    if (!arming) return;
    event.stopPropagation();
    const at = toPicture(event);
    if (!at) return;
    if (!first) {
      first = at;
      a.setAttribute('cx', String(at.x));
      a.setAttribute('cy', String(at.y));
      a.style.display = '';
      line.setAttribute('x1', String(at.x));
      line.setAttribute('y1', String(at.y));
      return;
    }
    if (Math.hypot(at.x - first.x, at.y - first.y) < 8) {
      session.setStatus('That line is too short to count over: click two points further apart', 'error');
      return;
    }
    session.setCountLine({ x1: first.x, y1: first.y, x2: at.x, y2: at.y });
    session.setStatus('Counting movers over the line; X clears it', 'success');
    stop();
  });
  svg.addEventListener('pointermove', (event) => {
    if (!arming || !first) return;
    const at = toPicture(event);
    if (!at) return;
    line.setAttribute('x2', String(at.x));
    line.setAttribute('y2', String(at.y));
    line.style.display = '';
  });

  session.on((event) => {
    if (event === 'countline' || event === 'source') draw(session.countLine);
  });
  window.addEventListener('resize', () => { if (session.countLine) draw(session.countLine); });

  return {
    toggle() {
      if (arming) { stop(); return; }
      if (session.countLine) {
        session.setCountLine(null);
        session.setStatus('Count line cleared', 'info');
        stop();
        return;
      }
      start();
    },
    cancel: stop,
    isArming: () => arming,
    place,
  };
}
