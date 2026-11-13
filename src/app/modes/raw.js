import { BLUR, GAP, SPREAD, THRESHOLD, TINTS, TRAIL } from './params.js';
import { renderDiff } from './diff.js';

export default {
  id: 'raw',
  label: 'Raw diff',
  blurb: 'The plain difference between now and a moment ago. Black is stillness, brightness is change.',
  help: [
    'Shows both where an object is and where it was: every mover has a ghost.',
    'Sensor noise shows as speckle below a low threshold.',
    'A stopped object disappears.',
  ],
  data: { kind: 'scalar', what: 'mean channel difference per pixel, 0..1' },
  composite: true,
  worker: true,
  params: [GAP, SPREAD, THRESHOLD, TRAIL, BLUR, ...TINTS],
  render: (frame) => renderDiff(frame, 'raw'),
};
