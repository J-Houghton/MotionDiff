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
    const layout = root.dataset.layout;
    if (layout !== 'viewfinder') {
      canvas.style.inset = '0';
      return;
    }
    const { width: pw, height: ph } = session.pipeline;
    const box = stage.getBoundingClientRect();
    if (!pw || !ph || !box.width || !box.height) return;
    if (root.dataset.fit === 'whole') {
      canvas.style.inset = 'var(--pic-top, 0%) var(--pic-side, 0%)';
    } else {
      const scale = Math.max(box.width / pw, box.height / ph);
      const overX = Math.max(0, (pw * scale - box.width) / 2);
      const overY = Math.max(0, (ph * scale - box.height) / 2);
      canvas.style.inset = `${-overY}px ${-overX}px`;
    }
  }

  function draw() {
    const latest = session.params.depthShow ? session.depthLatest() : null;
    const objects = session.pipeline.readings?.objects;
    if (!latest || !objects || !session.loaded || session.display === 'data') {
      canvas.style.display = 'none';
      chip.style.display = 'none';
      return;
    }
    canvas.style.display = '';
    chip.style.display = '';
    place();
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
