/**
 * The depth estimate shown (docs/depth-stage.md): the stage's coarse
 * inverse-depth grid over the picture, near warm and far cool, pixelated
 * on purpose — an 80-cell estimate, not a measurement — with a chip
 * naming how old the map is. Hidden unless a tracking mode has depth on
 * and "Show the depth estimate" set.
 *
 * A canvas in picture coordinates laid over the stage, placed exactly
 * like the boxes overlay (ui/boxes.js): inset to the letterbox or
 * overhung to the crop in the Viewfinder.
 */

export function initDepthView({ root, stage, session }) {
  const canvas = document.createElement('canvas');
  canvas.className = 'depthview';
  canvas.setAttribute('aria-hidden', 'true');
  const chip = document.createElement('span');
  chip.className = 'depthview-chip';
  stage.append(canvas, chip);

  function place() {
    // The canvas is pinned to the drawn picture in PIXELS, every layout:
    // leaning on the picture-inset variables let a letterboxed phone draw
    // the wash into the black bands, because an absolutely positioned
    // canvas with auto size does not reliably stretch to its insets the
    // way the boxes SVG (viewBox, no aspect preserved) does. The maths is
    // the boxes overlay's: whole = letterbox inside the stage, fill =
    // overhang out of it; the Plate's stage is the picture already.
    const { width: pw, height: ph } = session.pipeline;
    const box = stage.getBoundingClientRect();
    if (!pw || !ph || !box.width || !box.height) return false;
    const whole = root.dataset.layout !== 'viewfinder' || root.dataset.fit === 'whole';
    const scale = whole
      ? Math.min(box.width / pw, box.height / ph)
      : Math.max(box.width / pw, box.height / ph);
    const inX = (box.width - pw * scale) / 2;
    const inY = (box.height - ph * scale) / 2;
    canvas.style.left = `${inX.toFixed(1)}px`;
    canvas.style.top = `${inY.toFixed(1)}px`;
    canvas.style.width = `${(pw * scale).toFixed(1)}px`;
    canvas.style.height = `${(ph * scale).toFixed(1)}px`;
    // The age chip belongs to the picture's corner, not the stage's: on a
    // letterboxed phone the stage corner is inside a black band.
    chip.style.top = `${Math.max(8, inY + 8).toFixed(1)}px`;
    chip.style.right = `${Math.max(8, inX + 8).toFixed(1)}px`;
    return true;
  }

  function draw() {
    const latest = session.params.depthShow ? session.depthLatest() : null;
    const objects = session.pipeline.readings?.objects;
    if (!latest || !objects || !session.loaded || session.display === 'data') {
      canvas.style.display = 'none';
      chip.style.display = 'none';
      return;
    }
    if (!place()) {
      canvas.style.display = 'none';
      chip.style.display = 'none';
      return;
    }
    canvas.style.display = '';
    chip.style.display = '';
    const { grid, cols, rows, min, max } = latest;
    if (canvas.width !== cols || canvas.height !== rows) {
      canvas.width = cols;
      canvas.height = rows;
    }
    const g = canvas.getContext('2d');
    const image = g.createImageData(cols, rows);
    const range = Math.max(max - min, 1e-6);
    for (let i = 0; i < cols * rows; i++) {
      const v = (grid[i] - min) / range; // 0 far .. 1 near
      // Far cool blue to near warm orange, by hand: two anchor colours.
      image.data[i * 4] = Math.round(40 + v * 200);
      image.data[i * 4 + 1] = Math.round(70 + v * 60);
      image.data[i * 4 + 2] = Math.round(200 - v * 170);
      image.data[i * 4 + 3] = 110;
    }
    g.putImageData(image, 0, 0);
    const age = session.pipeline.readings?.depthAge;
    chip.textContent = `≈ depth · ${age === undefined ? '…' : age.toFixed(1) + ' s old'}`;
  }

  (function loop() { draw(); requestAnimationFrame(loop); })();
  return { update: draw };
}
