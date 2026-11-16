import { describe, expect, it } from 'vitest';
import {
  LAST_RUNG_STRIKES, faultFor, failureLine, gaveUpWords, ladderRungs, landedWords, rungName, startLadder, stepLadder,
} from '../ladder.js';

const names = (rungs) => rungs.map(rungName);
const failed = (stage, message = 'boom') => ({ type: /** @type {const} */ ('failed'), stage, message });

/** Feed events in order; returns the final ladder and every action taken. */
function play(ladder, events) {
  const actions = [];
  for (const event of events) {
    const out = stepLadder(ladder, event);
    ladder = out.ladder;
    actions.push(out.action);
  }
  return { ladder, actions };
}

describe('ladderRungs', () => {
  it('with a GPU: half precision, full precision, then the CPU', () => {
    expect(names(ladderRungs({ gpu: true }))).toEqual(['webgpu/fp16', 'webgpu/fp32', 'wasm/q8']);
  });

  it('without a GPU there is one rung, the one that runs anywhere', () => {
    expect(names(ladderRungs({ gpu: false }))).toEqual(['wasm/q8']);
  });

  it('a pin narrows the GPU rungs to one precision and keeps the CPU below it', () => {
    expect(names(ladderRungs({ gpu: true, pin: 'fp32' }))).toEqual(['webgpu/fp32', 'wasm/q8']);
    expect(names(ladderRungs({ gpu: false, pin: 'fp32' }))).toEqual(['wasm/fp32']);
  });
});

describe('stepLadder', () => {
  const fresh = () => startLadder(ladderRungs({ gpu: true }));

  it('the first rung proving is the whole story', () => {
    const { ladder, actions } = play(fresh(), [{ type: 'proved' }]);
    expect(actions).toEqual(['run']);
    expect(ladder).toMatchObject({ at: 0, running: true, failures: [] });
  });

  it('a rung that will not load costs that rung only', () => {
    const { ladder, actions } = play(fresh(), [failed('load'), { type: 'proved' }]);
    expect(actions).toEqual(['try', 'run']);
    expect(rungName(ladder.rungs[ladder.at])).toBe('webgpu/fp32');
    expect(ladder.running).toBe(true);
  });

  it('a rung that loads but fails its first look is not ready: the ladder steps down', () => {
    // The case that prompted this: RT-DETR on WebGPU builds its session and
    // then cannot run. Loading alone must never count as ready.
    const { ladder, actions } = play(fresh(), [
      failed('load', '94952944'),
      failed('prove', 'using ceil() in shape computation is not yet supported for AveragePool'),
      { type: 'proved' },
    ]);
    expect(actions).toEqual(['try', 'try', 'run']);
    expect(rungName(ladder.rungs[ladder.at])).toBe('wasm/q8');
    expect(ladder.failures.map((f) => f.stage)).toEqual(['load', 'prove']);
    expect(landedWords(ladder)).toEqual({
      where: 'the CPU', rung: 'wasm/q8', why: "the GPU backend can't run this model",
    });
  });

  it('a look that fails after ready steps down once, and the next rung must prove itself', () => {
    const { ladder, actions } = play(fresh(), [{ type: 'proved' }, { type: 'looked' }, failed('look')]);
    expect(actions).toEqual(['run', 'none', 'try']);
    expect(ladder).toMatchObject({ at: 1, running: false });
    expect(ladder.failures).toHaveLength(1);
    // One failure, one rung: a second failure report from the same dead
    // rung does not arrive, because the driver has already moved on.
    const next = stepLadder(ladder, { type: 'proved' });
    expect(next.action).toBe('run');
    expect(landedWords(next.ladder).why).toBe('webgpu/fp16 failed a look');
  });

  it('on the last rung a failed look is reported once, then the ladder stops', () => {
    const ladder = play(startLadder(ladderRungs({ gpu: false })), [{ type: 'proved' }]).ladder;
    const { actions } = play(ladder, Array.from({ length: LAST_RUNG_STRIKES }, () => failed('look')));
    expect(actions).toEqual(['report', 'quiet', 'stop']);
  });

  it('a look that succeeds ends the streak: failures apart are each reported, never added up', () => {
    const ladder = play(startLadder(ladderRungs({ gpu: false })), [{ type: 'proved' }]).ladder;
    const { actions } = play(ladder, [
      failed('look'), failed('look'), { type: 'looked' }, failed('look'), failed('look'), { type: 'looked' },
    ]);
    expect(actions).toEqual(['report', 'quiet', 'none', 'report', 'quiet', 'none']);
  });

  it('stops when the last rung cannot be proved, naming every rung', () => {
    const { ladder, actions } = play(fresh(), [failed('prove', 'a'), failed('prove', 'b'), failed('prove', 'c')]);
    expect(actions).toEqual(['try', 'try', 'stop']);
    expect(gaveUpWords(ladder)).toBe(
      'no backend could run the model — webgpu/fp16 first look: a; webgpu/fp32 first look: b; wasm/q8 first look: c',
    );
  });

  it('does not change the ladder it was given', () => {
    const ladder = fresh();
    stepLadder(ladder, failed('load'));
    expect(ladder).toEqual(fresh());
  });
});

describe('the words', () => {
  it('nothing to explain when the first rung proved', () => {
    const { ladder } = play(startLadder(ladderRungs({ gpu: true })), [{ type: 'proved' }]);
    expect(landedWords(ladder)).toEqual({ where: 'the GPU', rung: 'webgpu/fp16', why: null });
  });

  it('still on the GPU: names the precision that failed, not the backend', () => {
    const { ladder } = play(startLadder(ladderRungs({ gpu: true })), [failed('load'), { type: 'proved' }]);
    expect(landedWords(ladder)).toEqual({
      where: 'the GPU', rung: 'webgpu/fp32', why: 'webgpu/fp16 would not load it',
    });
  });

  it('on the CPU: the reason is the failure that pushed it off the GPU', () => {
    const { ladder } = play(startLadder(ladderRungs({ gpu: true })), [failed('prove'), failed('load'), { type: 'proved' }]);
    expect(landedWords(ladder).why).toBe('the GPU backend would not load it');
  });

  it('offline is offered only when no rung got as far as a look', () => {
    const { ladder } = play(startLadder(ladderRungs({ gpu: false })), [failed('load', 'Failed to fetch')]);
    expect(gaveUpWords(ladder)).toBe('no backend would load the model (offline?) — wasm/q8 load: Failed to fetch');
  });

  it('a failure reads as rung, stage and the runtime\'s own message', () => {
    expect(failureLine({ rung: { device: 'webgpu', dtype: 'fp32' }, stage: 'prove', message: 'x' })).toBe('webgpu/fp32 first look: x');
    expect(failureLine({ rung: { device: 'wasm', dtype: 'q8' }, stage: 'look', message: 'y' })).toBe('wasm/q8 look: y');
  });
});

describe('faultFor (the ?modelfault= triage switch)', () => {
  const fp16 = { device: 'webgpu', dtype: 'fp16' };
  const fp32 = { device: 'webgpu', dtype: 'fp32' };
  const cpu = { device: 'wasm', dtype: 'q8' };

  it('is inert without a spec', () => {
    expect(faultFor(null, fp16)).toBeNull();
    expect(faultFor('', cpu)).toBeNull();
  });

  it('matches a device, one rung, or all', () => {
    expect(faultFor('webgpu:prove', fp16)).toBe('prove');
    expect(faultFor('webgpu:prove', fp32)).toBe('prove');
    expect(faultFor('webgpu:prove', cpu)).toBeNull();
    expect(faultFor('webgpu/fp16:look', fp16)).toBe('look');
    expect(faultFor('webgpu/fp16:look', fp32)).toBeNull();
    expect(faultFor('all:load', cpu)).toBe('load');
  });

  it('takes a list, first match wins, and ignores what it does not know', () => {
    expect(faultFor('webgpu:prove,wasm:look', cpu)).toBe('look');
    expect(faultFor('webgpu/fp16:load, webgpu:prove', fp16)).toBe('load');
    expect(faultFor('webgpu:explode', fp16)).toBeNull();
  });
});
