// @ts-check
/**
 * The effects: the app organised around what a newcomer wants to see, not
 * around how it is measured (session 6; the owner's pick from three mockups,
 * recorded as X-1 in docs/verdicts.md).
 *
 * Eight modes fold into six effects. Each carries a verb title, a one-line
 * promise, the sample that shows it off, and its variants as visible
 * choices — which is where the combined modes (docs/combined-modes.md)
 * surface as what they do: "coloured by true direction" is flow + history,
 * "only the movers" is the flow gate, "mute still areas" is the background
 * model gating magnify. The full parameter panel stays behind one entry.
 *
 * A variant is one param set to one value; which choice is active is read
 * back from pipeline.params, so the pills never hold state of their own.
 */
import { getMode } from './modes/index.js';

/**
 * @typedef {object} EffectVariant
 * @property {string} label - Short, plain words ("by true direction")
 * @property {Record<string, *>} params - What choosing it sets
 *
 * @typedef {object} EffectChoice
 * @property {string} label - What the row of pills decides ("Coloured", "Stopped things")
 * @property {EffectVariant[]} options
 *
 * @typedef {object} Effect
 * @property {string} id
 * @property {string} numeral - Its plate number, I–VI
 * @property {string} label - Verb title
 * @property {string} promise - One line, plain words
 * @property {string[]} modes - The algorithm ids it folds in (first = default)
 * @property {Record<string, *>} base - Params applied when the effect is picked
 * @property {EffectChoice[]} choices - Variants shown as pills
 * @property {string[]} controls - Param keys promoted beside the pills
 * @property {string} sample - TEST_CLIPS label that shows it off
 * @property {string[]} also - Other samples that fit
 * @property {string} strip - Specimen filmstrip for the contents page
 * @property {string} ask - The question-strip word (viewfinder)
 */

/** @type {Effect[]} */
export const EFFECTS = [
  {
    id: 'highlight',
    numeral: 'I',
    label: 'Highlight motion',
    promise: 'Paint whatever moves over the scene; stillness fades to nothing.',
    modes: ['posy', 'raw'],
    base: { algorithm: 'posy' },
    choices: [
      {
        label: 'Drawn as',
        options: [
          { label: 'ghostly colour', params: { algorithm: 'posy' } },
          { label: 'bare difference', params: { algorithm: 'raw' } },
        ],
      },
    ],
    controls: ['frameOffset', 'threshold', 'trailLength'],
    sample: 'Trees in Wind',
    also: ['Flowing River', 'Flower Opening'],
    strip: 'atlas/highlight.jpg',
    ask: 'HIGHLIGHT',
  },
  {
    id: 'cutout',
    numeral: 'II',
    label: 'Cut out the movers',
    promise: 'Only what moves stays in the picture — the rest goes black.',
    modes: ['mask', 'background'],
    base: { algorithm: 'mask', maskShow: 'cutout' },
    choices: [
      {
        label: 'Things that stop',
        options: [
          { label: 'vanish at once', params: { algorithm: 'mask' } },
          { label: 'fade out slowly', params: { algorithm: 'background' } },
        ],
      },
      {
        label: 'Holes',
        options: [
          { label: 'left alone', params: { maskFill: 0 } },
          { label: 'filled in', params: { maskFill: 2 } },
        ],
      },
      {
        label: 'Movers',
        options: [
          { label: 'plain', params: { maskTrack: false } },
          { label: 'boxed & numbered', params: { maskTrack: true } },
        ],
      },
    ],
    controls: ['threshold', 'absorbSeconds'],
    sample: 'Bees at the Hive',
    also: ['Crossing from Above'],
    strip: 'atlas/cutout.jpg',
    ask: 'CUT OUT',
  },
  {
    id: 'trails',
    numeral: 'III',
    label: 'Leave trails',
    promise: 'Every mover leaves a band along its path.',
    modes: ['history'],
    base: { algorithm: 'history' },
    choices: [
      {
        label: 'Coloured by',
        options: [
          { label: 'how long ago', params: { historyShow: 'age' } },
          { label: 'direction of the trail', params: { historyShow: 'direction' } },
          { label: 'true measured direction', params: { historyShow: 'measured' } },
        ],
      },
    ],
    controls: ['historyLength', 'threshold'],
    sample: 'Gulls Overhead',
    also: ['Crossing from Above'],
    strip: 'atlas/trails.jpg',
    ask: 'TRAILS',
  },
  {
    id: 'speed',
    numeral: 'IV',
    label: 'Map speed & direction',
    promise: 'A wind map of the picture: how fast, and which way, every patch moves.',
    modes: ['flow'],
    base: { algorithm: 'flow' },
    choices: [
      {
        label: 'Drawn as',
        options: [
          { label: 'flowing traces', params: { flowShow: 'particles' } },
          { label: 'arrows', params: { flowShow: 'arrows' } },
          { label: 'colour', params: { flowShow: 'colour' } },
        ],
      },
      {
        label: 'Measured on',
        options: [
          { label: 'everything', params: { flowOnly: 'all' } },
          { label: 'only the movers', params: { flowOnly: 'mask' } },
          { label: 'except the background', params: { flowOnly: 'foreground' } },
        ],
      },
    ],
    controls: ['flowGap', 'flowRange'],
    sample: 'Motorway',
    also: ['Weir', 'Clouds over Peaks'],
    strip: 'atlas/speed.jpg',
    ask: 'SPEED',
  },
  {
    id: 'magnify',
    numeral: 'V',
    label: 'Magnify the invisible',
    promise: 'Breathing, pulse, sway — tiny slow motions amplified until you can see them.',
    modes: ['magnify'],
    base: { algorithm: 'magnify' },
    choices: [
      {
        label: 'Amplify',
        options: [
          { label: 'brightness changes', params: { magMode: 'brightness' } },
          { label: 'measured motion', params: { magMode: 'motion' } },
        ],
      },
      {
        label: 'Still areas',
        options: [
          { label: 'amplified too', params: { magQuiet: false } },
          { label: 'muted', params: { magQuiet: true } },
        ],
      },
    ],
    controls: ['magAmp', 'magFreqLow', 'magFreqHigh'],
    sample: 'Sleeping Kitten',
    also: [],
    strip: 'atlas/magnify.jpg',
    ask: 'MAGNIFY',
  },
  {
    id: 'heat',
    numeral: 'VI',
    label: 'Reveal heat & air',
    promise: 'Hot air and gas appear where the video shows nothing.',
    modes: ['schlieren'],
    base: { algorithm: 'schlieren' },
    choices: [
      {
        label: 'Shown as',
        options: [
          { label: 'knife edge', params: { schlierenShow: 'knife' } },
          { label: 'strength', params: { schlierenShow: 'strength' } },
          { label: 'direction', params: { schlierenShow: 'direction' } },
        ],
      },
    ],
    controls: ['schlierenRange', 'schlierenReference'],
    sample: 'Candle Plume',
    also: [],
    strip: 'atlas/heat.jpg',
    ask: 'HEAT',
  },
];

const BY_MODE = new Map();
for (const effect of EFFECTS) for (const id of effect.modes) BY_MODE.set(id, effect);

/** The effect a mode belongs to (every mode belongs to exactly one). */
export function effectForMode(algorithmId) {
  return BY_MODE.get(algorithmId) || EFFECTS[0];
}

/** @param {string} id @returns {Effect|null} */
export function getEffect(id) {
  return EFFECTS.find((effect) => effect.id === id) || null;
}

/**
 * Which option of a choice is active, read from the live params: the last
 * option whose every param matches. Defaults to the first.
 */
export function activeOption(choice, params) {
  let active = choice.options[0];
  for (const option of choice.options) {
    if (Object.entries(option.params).every(([key, value]) => params[key] === value)) active = option;
  }
  return active;
}

/**
 * The params that bring the session into an effect: its base, except that a
 * param the user already holds a value for inside the same effect is kept
 * (switching away and back does not reset their choices). Mode switches
 * always apply.
 */
export function effectParams(effect, params) {
  const next = {};
  for (const [key, value] of Object.entries(effect.base)) {
    if (key === 'algorithm') {
      // Stay on whichever of the effect's modes was last in use.
      next.algorithm = effect.modes.includes(params.algorithm) ? params.algorithm : value;
    } else if (params[key] === undefined) {
      next[key] = value;
    }
  }
  return next;
}

/** The promoted controls, resolved against the active mode's param defs. */
export function effectControls(effect, params) {
  const defs = /** @type {import('./modes/params.js').ParamDef[]} */ ((/** @type {*} */ (getMode(params.algorithm))).params);
  return effect.controls
    .map((key) => defs.find((def) => def.key === key))
    .filter((def) => def && (!def.when || def.when(params)));
}
