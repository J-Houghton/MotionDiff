/**
 * Draw a magnified frame produced by the worker path. It is a plain RGBA
 * frame at the processing size: the worker adds the upsampled band onto the
 * full-resolution frame itself.
 */
export function renderMagnify(magnified, outputCtx, width, height) {
  if (!magnified || magnified.width !== width || magnified.height !== height) return;
  outputCtx.putImageData(magnified, 0, 0);
}

export function renderBlank(outputCtx, width, height, algorithm, ageColorEnabled = false) {
  if (algorithm === 'posy' && !ageColorEnabled) {
    outputCtx.fillStyle = '#808080';
  } else {
    outputCtx.fillStyle = '#000';
  }
  outputCtx.fillRect(0, 0, width, height);
}

export function render(mode, diffData, originalData, outputCtx, width, height, algorithm, ageColorEnabled = false) {
  if (!diffData) {
    renderBlank(outputCtx, width, height, algorithm, ageColorEnabled);
    return;
  }

  switch (mode) {
    case 'diff':
      renderDiff(diffData, outputCtx);
      break;
    case 'overlay':
      renderOverlay(originalData, diffData, outputCtx, width, height, algorithm, ageColorEnabled);
      break;
    case 'glow':
      renderGlow(originalData, diffData, outputCtx, width, height, algorithm, ageColorEnabled);
      break;
  }
}

function renderDiff(acc, ctx) {
  ctx.putImageData(acc, 0, 0);
}

function renderOverlay(currentFrame, accumulated, ctx, w, h, algorithm, ageColorEnabled) {
  const orig = currentFrame.data;
  const diff = accumulated.data;
  const len = orig.length;
  const output = new ImageData(w, h);
  const out = output.data;

  if (algorithm === 'posy' && !ageColorEnabled) {
    for (let i = 0; i < len; i += 4) {
      /**
       * Convert Posy diff from gray-centered space back to 0-255 motion
       * magnitude for screen blending. In Posy output, 128 = static;
       * deviation from 128 encodes motion. The useful deviation range
       * is roughly ±64, so multiplying by 4 maps it to ~0-255.
       */
      const motR = Math.min(255, Math.abs(diff[i]     - 128) * 4);
      const motG = Math.min(255, Math.abs(diff[i + 1] - 128) * 4);
      const motB = Math.min(255, Math.abs(diff[i + 2] - 128) * 4);
      // screen blend: 255 - ((255-base)*(255-blend)) >> 8
      out[i]     = 255 - (((255 - orig[i])     * (255 - motR)) >> 8);
      out[i + 1] = 255 - (((255 - orig[i + 1]) * (255 - motG)) >> 8);
      out[i + 2] = 255 - (((255 - orig[i + 2]) * (255 - motB)) >> 8);
      out[i + 3] = 255;
    }
  } else {
    for (let i = 0; i < len; i += 4) {
      const bR = Math.min(255, diff[i] * 2);
      const bG = Math.min(255, diff[i + 1] * 2);
      const bB = Math.min(255, diff[i + 2] * 2);
      out[i]     = 255 - (((255 - orig[i])     * (255 - bR)) >> 8);
      out[i + 1] = 255 - (((255 - orig[i + 1]) * (255 - bG)) >> 8);
      out[i + 2] = 255 - (((255 - orig[i + 2]) * (255 - bB)) >> 8);
      out[i + 3] = 255;
    }
  }

  ctx.putImageData(output, 0, 0);
}

function renderGlow(currentFrame, accumulated, ctx, w, h, algorithm, ageColorEnabled) {
  const orig = currentFrame.data;
  const diff = accumulated.data;
  const len = orig.length;
  const output = new ImageData(w, h);
  const out = output.data;

  if (algorithm === 'posy' && !ageColorEnabled) {
    for (let i = 0; i < len; i += 4) {
      const motR = Math.min(255, Math.abs(diff[i]     - 128) * 6);
      const motG = Math.min(255, Math.abs(diff[i + 1] - 128) * 6);
      const motB = Math.min(255, Math.abs(diff[i + 2] - 128) * 6);
      out[i]     = Math.min(255, orig[i]     + motR);
      out[i + 1] = Math.min(255, orig[i + 1] + motG);
      out[i + 2] = Math.min(255, orig[i + 2] + motB);
      out[i + 3] = 255;
    }
  } else {
    for (let i = 0; i < len; i += 4) {
      out[i]     = Math.min(255, orig[i]     + diff[i] * 3);
      out[i + 1] = Math.min(255, orig[i + 1] + diff[i + 1] * 3);
      out[i + 2] = Math.min(255, orig[i + 2] + diff[i + 2] * 3);
      out[i + 3] = 255;
    }
  }

  ctx.putImageData(output, 0, 0);
}
