/**
 * Invert-blend temporal difference (Posy method).
 *
 * For each pixel: blend = (current + invert(old) + 1) >> 1.
 * When current equals old (no motion), the terms cancel to exactly 128
 * on every channel, because V + (255 − V) + 1 = 256 and 256 >> 1 = 128.
 * Motion shifts channels away from 128; the magnitude of deviation
 * encodes motion intensity.
 *
 * The +1 before the right-shift rounds to nearest instead of truncating.
 *
 * Threshold is in raw difference units — the mean absolute channel
 * difference between the two frames, 0..255 — exactly as in rawDiff, so one
 * threshold value suppresses the same pixels in both modes. A Posy channel
 * deviates from 128 by half the difference, so the comparison doubles the
 * mean deviation. Pixels below threshold are suppressed to gray
 * (128, 128, 128) — not to zero, since gray is the "no motion" baseline in
 * Posy space.
 *
 * @param {Uint8ClampedArray} curData  - Current frame RGBA pixel data
 * @param {Uint8ClampedArray} oldData  - Previous frame RGBA pixel data
 * @param {Uint8ClampedArray} outData  - Output buffer (written in-place)
 * @param {number}            threshold - Minimum mean channel difference to keep
 */
export function posyBlend(curData, oldData, outData, threshold) {
  const len = curData.length;
  for (let i = 0; i < len; i += 4) {
    // blend = (current + invert(old) + 1) >> 1 — the +1 before >>1 rounds to nearest
    let bR = ((curData[i]     + (255 - oldData[i]))     + 1) >> 1;
    let bG = ((curData[i + 1] + (255 - oldData[i + 1])) + 1) >> 1;
    let bB = ((curData[i + 2] + (255 - oldData[i + 2])) + 1) >> 1;

    const devR = Math.abs(bR - 128);
    const devG = Math.abs(bG - 128);
    const devB = Math.abs(bB - 128);

    // mean deviation × 2 < threshold, kept in integers so the shader can
    // reproduce the comparison exactly
    if ((devR + devG + devB) * 2 < threshold * 3) {
      outData[i]     = 128;
      outData[i + 1] = 128;
      outData[i + 2] = 128;
    } else {
      outData[i]     = bR;
      outData[i + 1] = bG;
      outData[i + 2] = bB;
    }
    outData[i + 3] = 255;
  }
}

/**
 * Absolute temporal difference: |current − old| per channel. Static pixels
 * are 0 (black). Pixels whose mean channel difference is below threshold
 * (0..255) are suppressed to 0.
 *
 * @param {Uint8ClampedArray} curData  - Current frame RGBA pixel data
 * @param {Uint8ClampedArray} oldData  - Previous frame RGBA pixel data
 * @param {Uint8ClampedArray} outData  - Output buffer (written in-place)
 * @param {number}            threshold - Minimum mean channel difference to keep
 */
export function rawDiff(curData, oldData, outData, threshold) {
  const len = curData.length;
  for (let i = 0; i < len; i += 4) {
    let dR = Math.abs(curData[i]     - oldData[i]);
    let dG = Math.abs(curData[i + 1] - oldData[i + 1]);
    let dB = Math.abs(curData[i + 2] - oldData[i + 2]);

    // mean difference < threshold, in integers (see posyBlend)
    if (dR + dG + dB < threshold * 3) {
      outData[i]     = 0;
      outData[i + 1] = 0;
      outData[i + 2] = 0;
    } else {
      outData[i]     = dR;
      outData[i + 1] = dG;
      outData[i + 2] = dB;
    }
    outData[i + 3] = 255;
  }
}
