// Runs inside the app page: `npm run filmstrip eval -- --run scripts/page/audit.js`.
// Measures the interface acceptance rules in CLAUDE.md on whatever state the
// page is in. `args.touch` adds the 44 px touch-target rule.
const app = document.getElementById('app');
const vw = window.innerWidth;
const vh = window.innerHeight;
const visible = (el) => {
  const r = el.getBoundingClientRect();
  if (r.width < 1 || r.height < 1 || r.bottom <= 0 || r.right <= 0 || r.top >= vh || r.left >= vw) return false;
  for (let n = el; n && n !== document; n = n.parentElement) {
    const cs = getComputedStyle(n);
    if (cs.display === 'none' || cs.visibility === 'hidden' || Number(cs.opacity) < 0.05) return false;
    if (n.inert || n.hidden) return false;
  }
  return true;
};
const name = (el) => `${el.tagName.toLowerCase()}${el.id ? '#' + el.id : ''}${el.className && typeof el.className === 'string' ? '.' + el.className.split(' ')[0] : ''}:"${(el.getAttribute('aria-label') || el.textContent || '').trim().slice(0, 24)}"`;

// ── 1. picture share
const frame = document.getElementById('stage').getBoundingClientRect();
const shown = Math.max(0, Math.min(frame.right, vw) - Math.max(frame.left, 0)) * Math.max(0, Math.min(frame.bottom, vh) - Math.max(frame.top, 0));
const pictureShare = +(shown / (vw * vh)).toFixed(3);
const largerThanPicture = [...app.querySelectorAll('.mast, .cap, .panel, .sheet-body')]
  .filter(visible).filter((el) => { const r = el.getBoundingClientRect(); return r.width * r.height > shown; }).map(name);

// ── 2. text contrast (WCAG): text colour against the nearest solid background
const parse = (c) => { const m = c.match(/[\d.]+/g); return m ? m.map(Number) : [0, 0, 0, 0]; };
const lum = ([r, g, b]) => { const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }; return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b); };
const over = (top, bottom) => { const a = top[3] ?? 1; return [0, 1, 2].map((i) => top[i] * a + bottom[i] * (1 - a)); };
function background(el) {
  const layers = [];
  for (let n = el; n && n !== document; n = n.parentElement) {
    const c = parse(getComputedStyle(n).backgroundColor);
    if ((c[3] ?? 1) > 0) layers.push(c);
    if ((c[3] ?? 1) >= 1) break;
  }
  if (!layers.length || (layers[layers.length - 1][3] ?? 1) < 1) layers.push(parse(getComputedStyle(document.body).backgroundColor));
  return layers.reverse().reduce((bottom, top) => over(top, bottom), [255, 255, 255]);
}
const lowContrast = [];
let minContrast = 99;
const walker = document.createTreeWalker(app, NodeFilter.SHOW_TEXT);
const seen = new Set();
for (let node = walker.nextNode(); node; node = walker.nextNode()) {
  const el = node.parentElement;
  if (!node.textContent.trim() || seen.has(el) || !visible(el)) continue;
  seen.add(el);
  if (el.closest('button:disabled, input:disabled, [aria-hidden="true"] .tp-sldv')) continue; // disabled controls are exempt
  // Text drawn straight over the video has no fixed background: flag it.
  const onPicture = el.closest('.frame') && ![...(function* () { for (let n = el; n && !n.classList.contains('frame'); n = n.parentElement) yield n; })()]
    .some((n) => (parse(getComputedStyle(n).backgroundColor)[3] ?? 1) >= 1);
  if (onPicture) { lowContrast.push(`${name(el)} sits on the picture with no plate`); continue; }
  const cs = getComputedStyle(el);
  const fg = over(parse(cs.color), background(el));
  const bg = background(el);
  const [a, b] = [lum(fg), lum(bg)].sort((x, y) => y - x);
  const ratio = (a + 0.05) / (b + 0.05);
  // Large text (>= 24 px, or >= 18.66 px bold) needs 3:1.
  const size = parseFloat(cs.fontSize);
  const need = size >= 24 || (size >= 18.66 && Number(cs.fontWeight) >= 700) ? 3 : 4.5;
  if (ratio < minContrast) minContrast = ratio;
  if (ratio < need) lowContrast.push(`${name(el)} ${ratio.toFixed(2)}:1 (needs ${need})`);
}

// ── 3. clipped text and overlapping blocks
const clipped = [...app.querySelectorAll('button, h1, h2, .vf b, .tag, .clock, .ruler-mark b, .ruler-lab, .mast-info, .brand')]
  .filter(visible).filter((el) => el.scrollWidth > el.clientWidth + 1 && getComputedStyle(el).textOverflow !== 'ellipsis' && getComputedStyle(el).overflow !== 'visible').map(name);
const offscreen = [...app.querySelectorAll('button, [role="slider"], input, select, h1, .vf, .tag')]
  .filter(visible).filter((el) => { const r = el.getBoundingClientRect(); return r.left < -1 || r.top < -1 || r.right > vw + 1 || r.bottom > vh + 1; })
  .filter((el) => !el.closest('.panel, .sheet-body')) // those scroll
  .map(name);
const blocks = [...app.querySelectorAll('.mast, .cap, .panel, .vf-mode, .vf-meta, .vf-readout, .vf-exit, .status, .tag, .ruler-mark b, .ruler-now b, .ruler-lab')]
  .filter(visible).filter((el) => el.textContent.trim() || el.matches('.mast, .cap, .panel'));
const overlaps = [];
for (let i = 0; i < blocks.length; i++) {
  for (let j = i + 1; j < blocks.length; j++) {
    const [a, b] = [blocks[i], blocks[j]];
    if (a.contains(b) || b.contains(a)) continue;
    const ra = a.getBoundingClientRect(); const rb = b.getBoundingClientRect();
    const w = Math.min(ra.right, rb.right) - Math.max(ra.left, rb.left);
    const h = Math.min(ra.bottom, rb.bottom) - Math.max(ra.top, rb.top);
    if (w > 2 && h > 2) overlaps.push(`${name(a)} × ${name(b)} (${Math.round(w)}×${Math.round(h)})`);
  }
}

// ── 4. touch targets
let smallTargets = null;
if (args.touch) {
  smallTargets = [...app.querySelectorAll('button, a, select, input, [role="slider"], summary')]
    .filter(visible).filter((el) => !el.disabled)
    .map((el) => {
      // A control's hit area includes a label or row that forwards the tap.
      const hit = el.closest('.tp-lblv, .tp-btnv, .tp-fldv_b, .tp-rotv_b, label') || el;
      const r = (hit.contains(el) ? hit : el).getBoundingClientRect();
      return { el, w: r.width, h: r.height };
    })
    .filter(({ w, h }) => w < 44 - 0.5 || h < 44 - 0.5)
    .map(({ el, w, h }) => `${name(el)} ${Math.round(w)}×${Math.round(h)}`);
}

return {
  viewport: [vw, vh],
  layout: app.dataset.layout,
  theme: document.documentElement.dataset.theme,
  pictureShare,
  largerThanPicture,
  minContrast: +minContrast.toFixed(2),
  lowContrast: lowContrast.slice(0, 12),
  clipped,
  offscreen,
  overlaps: overlaps.slice(0, 12),
  smallTargets: smallTargets && smallTargets.slice(0, 16),
  idle: app.dataset.idle,
};
