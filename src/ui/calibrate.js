/**
 * Calibration to real units (docs/tracking.md): the user marks a known
 * length in the picture — two clicks and a distance in metres — and
 * everything that shows a speed switches from picture pixels to metres.
 *
 * The marked line lives in picture coordinates through the same SVG
 * mapping the boxes overlay uses, so the Viewfinder's letterbox and crop
 * keep it honest. The scale is true at the marked line's depth; the help
 * says so.
 */

const SVG = 'http://www.w3.org/2000/svg';

export function initCalibrate({ root, stage, session }) {
  const svg = document.createElementNS(SVG, 'svg');
  svg.setAttribute('class', 'cal');
  svg.setAttribute('preserveAspectRatio', 'none');
  svg.style.display = 'none';
  const line = document.createElementNS(SVG, 'line');
  const a = document.createElementNS(SVG, 'circle');
  const b = document.createElementNS(SVG, 'circle');
  a.setAttribute('r', '4');
  b.setAttribute('r', '4');
  svg.append(line, a, b);
  stage.append(svg);

  // The question, asked in place rather than in a browser popup.
  const ask = document.createElement('form');
  ask.className = 'cal-ask chrome';
  ask.hidden = true;
  const askInput = Object.assign(document.createElement('input'), { type: 'number', step: '0.1', min: '0.1', placeholder: '5' });
  askInput.setAttribute('aria-label', 'Real length of the marked line, metres');
  const askGo = Object.assign(document.createElement('button'), { type: 'submit', textContent: 'Set' });
  const askNo = Object.assign(document.createElement('button'), { type: 'button', textContent: 'Cancel' });
  ask.append(Object.assign(document.createElement('span'), { textContent: 'marked line is' }), askInput,
    Object.assign(document.createElement('span'), { textContent: 'metres' }), askGo, askNo);
  stage.append(ask);

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

  function stop() {
    arming = false;
    first = null;
    svg.style.display = 'none';
    ask.hidden = true;
    root.dataset.calibrating = 'false';
  }

  function start() {
    if (!session.loaded) {
      session.setStatus('Load footage first, then mark a known length', 'info');
      return;
    }
    arming = true;
    first = null;
    place();
    svg.style.display = '';
    line.style.display = 'none';
    a.style.display = 'none';
    b.style.display = 'none';
    root.dataset.calibrating = 'true';
    session.setStatus('Calibrate: click both ends of something whose real length you know', 'info');
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
    b.setAttribute('cx', String(at.x));
    b.setAttribute('cy', String(at.y));
    b.style.display = '';
    line.setAttribute('x2', String(at.x));
    line.setAttribute('y2', String(at.y));
    line.style.display = '';
    const pixels = Math.hypot(at.x - first.x, at.y - first.y);
    arming = false; // the line is set; the question is open
    ask.hidden = false;
    askInput.value = '';
    askInput.focus();
    ask.onsubmit = (submitEvent) => {
      submitEvent.preventDefault();
      const metres = Number.parseFloat(askInput.value);
      if (Number.isFinite(metres) && metres > 0 && pixels > 4) {
        session.calibration = { metresPerPixel: metres / pixels };
        session.setStatus(`Calibrated: ${((metres / pixels) * 100).toFixed(1)} cm per pixel at that depth`, 'success');
      } else {
        session.setStatus('Calibration needs a length in metres and a line longer than a few pixels', 'error');
      }
      stop();
    };
  });
  ask.addEventListener('click', (event) => { if (event.target === askNo) stop(); });
  svg.addEventListener('pointermove', (event) => {
    if (!arming || !first) return;
    const at = toPicture(event);
    if (!at) return;
    line.setAttribute('x2', String(at.x));
    line.setAttribute('y2', String(at.y));
    line.style.display = '';
  });

  return {
    toggle: () => (arming ? stop() : start()),
    cancel: stop,
    isArming: () => arming,
  };
}

/** A speed in picture px/s, written in the calibrated unit when one is set. */
export function formatSpeed(speed, calibration) {
  if (calibration?.metresPerPixel) {
    const ms = speed * calibration.metresPerPixel;
    return ms >= 10 ? `${ms.toFixed(0)} m/s` : `${ms.toFixed(1)} m/s`;
  }
  return `${Math.round(speed)} px/s`;
}
