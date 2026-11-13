import { AGE_COLORS, BLUR, GAP, SPREAD, THRESHOLD, TINTS, TRAIL } from './params.js';
import { renderDiff } from './diff.js';

export default {
  id: 'posy',
  label: 'Posy',
  blurb: 'Each frame laid over its own negative from a moment ago. What has not moved cancels to grey.',
  help: [
    'Only the edges of a uniform object show: where it arrived and where it left.',
    'A gap longer than the object takes to cross its own width shows two copies.',
    'A stopped object disappears.',
  ],
  // What the mode measures, as data: see core/magnitude.js diffMagnitude.
  data: { kind: 'scalar', what: 'mean deviation from grey per pixel, 0..1' },
  composite: true,
  worker: true,
  params: [
    GAP, SPREAD, THRESHOLD, TRAIL, BLUR,
    ...TINTS,
    { key: 'ageColorEnabled', label: 'Age colour', type: 'toggle', default: false },
    {
      key: 'ageColorStyle', label: 'Age style', type: 'select', default: 'mixed',
      options: { 'Mixed (new + old)': 'mixed', 'Latest only': 'latest' },
      when: (p) => p.ageColorEnabled,
    },
    ...AGE_COLORS.map((param) => ({ ...param, when: (p) => p.ageColorEnabled })),
  ],
  render: (frame) => renderDiff(frame, 'posy'),
};
