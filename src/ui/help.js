function renderHelpContent() {
  return `
    <section>
      <h2>What it does</h2>
      <p>MotionDiff compares video frames across time and visualizes change instead of state. Static regions cancel out, while moving pixels stay visible as edges, halos, and trails. The result is a motion map that makes small shifts in leaves, water, smoke, clouds, or slow drifting light easier to see than in the original footage alone.</p>
      <p>In Posy mode, the neutral "no motion" value is a gray midtone at 128. That gray field is useful: it means the background mathematically disappears into a constant baseline, and anything that departs from 128 represents motion energy. Brighter or darker deviations from gray show how far a pixel has moved through time, while the RGB channel offsets add directional color.</p>
    </section>

    <section>
      <h2>Algorithms</h2>
      <h3>Posy Blend</h3>
      <p>Posy Blend compares the current frame against an older frame after inverting the old one. Static pixels collapse to a constant midpoint, so the background settles to gray and motion glows away from that baseline.</p>
      <div class="help-code"><code>blend = (current + invert(old)) / 2</code></div>
      <div class="help-code"><code>static pixel: (V + (255 - V)) / 2 = 128</code></div>

      <h3>Raw Diff</h3>
      <p>Raw Diff uses absolute channel difference. Static regions go black, and brighter pixels indicate larger motion between the two samples.</p>
      <div class="help-code"><code>diff = |current - old|</code></div>
    </section>

    <section>
      <h2>Frame offset guide</h2>
      <table>
        <thead>
          <tr>
            <th>k value</th>
            <th>Best for</th>
            <th>Notes</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td>1-3</td>
            <td>Fast motion, people walking, hand gestures</td>
            <td>Keeps fast subjects from smearing too far between samples.</td>
          </tr>
          <tr>
            <td>5-15</td>
            <td>General nature footage, moderate motion</td>
            <td>Good default range for wind, water, and everyday outdoor scenes.</td>
          </tr>
          <tr>
            <td>20-40</td>
            <td>Slow drift, clouds, fog, rising steam</td>
            <td>Useful when the motion is real but hard to notice frame-to-frame.</td>
          </tr>
          <tr>
            <td>50-90</td>
            <td>Imperceptibly slow motion, moonrise, tide</td>
            <td>Best reserved for locked-off shots with very stable backgrounds.</td>
          </tr>
        </tbody>
      </table>
    </section>

    <section>
      <h2>Examples</h2>
      <h3>Subtle wind</h3>
      <div class="help-code"><code>offset=2 threshold=16 trail=8 spread=0 algorithm=Posy blur=off</code></div>
      <p>Best for grass fields, hair, fur, and fabric in a gentle breeze. Look for fine filament-like traces on moving edges.</p>

      <h3>Ghost trails</h3>
      <div class="help-code"><code>offset=10 threshold=24 trail=15 spread=2 algorithm=Posy blur=off</code></div>
      <p>Best for people walking slowly and branches swaying. Look for a double silhouette and a rainbow smear caused by RGB spread.</p>

      <h3>Atmosphere</h3>
      <div class="help-code"><code>offset=30 threshold=12 trail=20 spread=1 algorithm=Posy blur=on</code></div>
      <p>Best for fog, smoke, steam, and distant water shimmer. Look for large soft blobs of color that reveal drift.</p>

      <h3>High contrast motion</h3>
      <div class="help-code"><code>offset=3 threshold=5 trail=3 spread=0 algorithm=Raw blur=off</code></div>
      <p>Best for fast motion analysis and silhouettes. Look for bright white outlines on a pure black background.</p>
    </section>

    <section>
      <h2>Parameter guide</h2>
      <h3>Choosing threshold</h3>
      <p>Threshold is the mean channel difference between the two frames (0-255), the same in Posy and Raw. Start at <code>20</code>. Raise it if static areas show noise. Lower it if subtle motion is missing. The typical range is <code>10-50</code>; Auto measures the noise floor and sets it for you.</p>

      <h3>Trail length and algorithm interaction</h3>
      <p>In Posy mode, longer trails show a smooth color fade because each trail frame retains its deviation-from-128 value and the accumulator picks the maximum deviation per channel.</p>
      <p>In Raw Diff mode, trails simply persist the brightest motion seen. They do not encode direction or age.</p>

      <h3>RGB spread and motion direction</h3>
      <p><code>Spread=0</code> means color is determined only by which channels changed most. <code>Spread=2</code> typically reads as red leading and blue trailing. <code>Spread=4+</code> becomes a strong rainbow smear that is more artistic than analytical.</p>
    </section>
  `;
}

export function initHelp() {
  const openButton = document.getElementById('btnHelp');
  const backdrop = document.getElementById('helpBackdrop');
  const drawer = document.getElementById('helpDrawer');
  const closeButton = document.getElementById('helpClose');
  const content = document.getElementById('helpContent');

  if (!openButton || !backdrop || !drawer || !closeButton || !content) {
    return {
      open() {},
      close() {},
    };
  }

  content.innerHTML = renderHelpContent();

  let hideTimer = null;

  function open() {
    if (hideTimer !== null) {
      clearTimeout(hideTimer);
      hideTimer = null;
    }
    backdrop.hidden = false;
    drawer.setAttribute('aria-hidden', 'false');
    requestAnimationFrame(() => {
      backdrop.classList.add('open');
    });
  }

  function close() {
    backdrop.classList.remove('open');
    drawer.setAttribute('aria-hidden', 'true');
    hideTimer = window.setTimeout(() => {
      backdrop.hidden = true;
      hideTimer = null;
    }, 250);
  }

  openButton.addEventListener('click', open);
  closeButton.addEventListener('click', close);
  backdrop.addEventListener('click', (event) => {
    if (event.target === backdrop) {
      close();
    }
  });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && !backdrop.hidden) {
      close();
    }
  });

  return { open, close };
}
