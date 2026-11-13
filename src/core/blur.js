export function boxBlur(data, width, height) {
  const src = new Uint8ClampedArray(data);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let rSum = 0, gSum = 0, bSum = 0, count = 0;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx;
          const ny = y + dy;
          if (nx >= 0 && nx < width && ny >= 0 && ny < height) {
            const idx = (ny * width + nx) * 4;
            rSum += src[idx];
            gSum += src[idx + 1];
            bSum += src[idx + 2];
            count++;
          }
        }
      }
      const idx = (y * width + x) * 4;
      data[idx]     = (rSum / count + 0.5) | 0;
      data[idx + 1] = (gSum / count + 0.5) | 0;
      data[idx + 2] = (bSum / count + 0.5) | 0;
      data[idx + 3] = 255;
    }
  }
}

/**
 * The same 3x3 box blur for normalized float RGBA data: edge pixels average
 * only the neighbours that exist, and nothing is rounded.
 *
 * @param {Float32Array} data - RGBA layout, modified in place
 * @param {number} width
 * @param {number} height
 */
export function boxBlurFloat(data, width, height) {
  const src = new Float32Array(data);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let rSum = 0, gSum = 0, bSum = 0, count = 0;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx;
          const ny = y + dy;
          if (nx >= 0 && nx < width && ny >= 0 && ny < height) {
            const idx = (ny * width + nx) * 4;
            rSum += src[idx];
            gSum += src[idx + 1];
            bSum += src[idx + 2];
            count++;
          }
        }
      }
      const idx = (y * width + x) * 4;
      data[idx]     = rSum / count;
      data[idx + 1] = gSum / count;
      data[idx + 2] = bSum / count;
    }
  }
}
