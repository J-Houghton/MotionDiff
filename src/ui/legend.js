/**
 * Direction legend: a small hue wheel in the picture's corner, shown while
 * the current view colours by heading, so the colours can be read without
 * the help sheet.
 *
 * The wheel must match the shaders' hue(): heading angle in turns
 * (atan(y down, x right) / 2π) as an HSL hue. On screen that means right is
 * red, down is yellow-green, left is cyan, up is violet. A CSS conic
 * gradient starts at the top and runs clockwise, so the gradient is turned
 * a quarter turn: `from 90deg` puts hue 0 at the right.
 */

/** [mode id, which of its params mean "coloured by heading"] */
const USES_HEADING = {
  flow: (p) => p.flowShow === 'colour' || p.flowShow === 'arrows' || (p.flowShow === 'particles' && p.traceColour === 'heading'),
  history: (p) => p.historyShow === 'direction' || p.historyShow === 'measured',
  schlieren: (p) => p.schlierenShow === 'direction' || (p.schlierenShow === 'traces' && p.traceColour === 'heading'),
};

const STOPS = Array.from({ length: 13 }, (_, i) => `hsl(${i * 30} 100% 50%) ${i * 30}deg`).join(', ');

/**
 * @param {object} options
 * @param {HTMLElement} options.stage - The frame the legend sits in
 * @param {import('../app/session.js').Session} options.session
 * @returns {{update: () => void}}
 */
export function initLegend({ stage, session }) {
  const box = document.createElement('div');
  box.className = 'legend chrome';
  box.setAttribute('role', 'img');
  box.setAttribute('aria-label', 'Heading colours: right is red, down is yellow-green, left is cyan, up is violet');
  box.hidden = true;

  const wheel = document.createElement('i');
  wheel.className = 'legend-wheel';
  wheel.style.background = `conic-gradient(from 90deg, ${STOPS})`;
  box.append(wheel);
  for (const [name, glyph] of [['r', '→'], ['d', '↓'], ['l', '←'], ['u', '↑']]) {
    box.append(Object.assign(document.createElement('span'), { className: `legend-${name}`, textContent: glyph }));
  }
  stage.append(box);

  function update() {
    const uses = USES_HEADING[session.mode.id];
    box.hidden = !session.loaded || !uses || !uses(session.params) || session.display === 'data';
  }

  update();
  return { update };
}
