// @ts-check
/**
 * The backend ladder for the model workers (records/design/model-ladder.md): which
 * backends are tried and in what order, what happens when one fails, and
 * the words that say where it landed and why.
 *
 * A rung counts only once it has PROVED a look: a backend can build its
 * session and still be unable to run the model (WebGPU and RT-DETR's
 * ceil-mode AveragePool, the case that prompted this).
 *
 * Pure functions; app/modelladder.js drives the workers with them.
 */

/**
 * @typedef {{device: string, dtype: string}} Rung
 * A backend ('webgpu' | 'wasm') and the weights' precision.
 */

/**
 * @typedef {'load'|'prove'|'look'} Stage
 * Where a rung failed: fetching and compiling; the throwaway look inside
 * load; a real look after it had reported ready.
 */

/**
 * @typedef {{rung: Rung, stage: Stage, message: string}} Failure
 */

/**
 * @typedef {object} Ladder
 * @property {Rung[]} rungs
 * @property {number} at - The rung being proved, or in use
 * @property {boolean} running - The rung at `at` has proved a look
 * @property {Failure[]} failures - Every failure that cost a rung, in order
 * @property {number} strikes - Failed looks in a row on the last rung
 */

/**
 * @typedef {{type: 'proved'} | {type: 'looked'} | {type: 'failed', stage: Stage, message: string}} LadderEvent
 * `proved`: the rung loaded and answered its throwaway look. `looked`: a
 * real look came back. `failed`: the rung could not load, prove, or look.
 */

/**
 * @typedef {'run'|'try'|'report'|'quiet'|'stop'|'none'} LadderAction
 * `run`: use the rung at `at`. `try`: prove the rung at `at` (a step
 * down). `report`: the last rung failed a look, say so once. `quiet`: it
 * failed again, already said. `stop`: nothing left, switch the option off.
 */

/** Failed looks in a row on the last rung before the option switches off. */
export const LAST_RUNG_STRIKES = 3;

/**
 * The rungs in order. With a GPU adapter: WebGPU at half then full
 * precision, then wasm with the quantised weights (the rung that runs
 * anywhere). `pin` narrows the GPU rungs to one precision for triage;
 * without a GPU it picks the wasm weights instead.
 * @param {{gpu: boolean, pin?: string|null}} options
 * @returns {Rung[]}
 */
export function ladderRungs({ gpu, pin }) {
  if (!gpu) return [{ device: 'wasm', dtype: pin || 'q8' }];
  const top = pin
    ? [{ device: 'webgpu', dtype: pin }]
    : [{ device: 'webgpu', dtype: 'fp16' }, { device: 'webgpu', dtype: 'fp32' }];
  return [...top, { device: 'wasm', dtype: 'q8' }];
}

/**
 * A ladder about to prove its first rung.
 * @param {Rung[]} rungs
 * @returns {Ladder}
 */
export function startLadder(rungs) {
  return { rungs, at: 0, running: false, failures: [], strikes: 0 };
}

/**
 * The step-down decision. Returns the ladder after the event and what the
 * driver should do about it; the ladder passed in is not changed.
 *
 * - A rung that fails to load or to prove costs that rung: try the next.
 * - A look that fails after ready steps down once, to the next rung,
 *   which must prove itself like any other.
 * - On the last rung a failed look is reported once per streak, and
 *   LAST_RUNG_STRIKES in a row stop the ladder.
 *
 * @param {Ladder} ladder
 * @param {LadderEvent} event
 * @returns {{ladder: Ladder, action: LadderAction}}
 */
export function stepLadder(ladder, event) {
  if (event.type === 'proved') {
    return { ladder: { ...ladder, running: true, strikes: 0 }, action: 'run' };
  }
  if (event.type === 'looked') {
    return { ladder: ladder.strikes ? { ...ladder, strikes: 0 } : ladder, action: 'none' };
  }
  const below = ladder.at + 1 < ladder.rungs.length;
  if (ladder.running && !below) {
    const strikes = ladder.strikes + 1;
    const action = strikes >= LAST_RUNG_STRIKES ? 'stop' : strikes === 1 ? 'report' : 'quiet';
    return { ladder: { ...ladder, strikes }, action };
  }
  const failures = [...ladder.failures, { rung: ladder.rungs[ladder.at], stage: event.stage, message: event.message }];
  if (!below) return { ladder: { ...ladder, running: false, failures }, action: 'stop' };
  return { ladder: { ...ladder, at: ladder.at + 1, running: false, failures, strikes: 0 }, action: 'try' };
}

/** @param {Rung} rung */
export function rungName(rung) {
  return `${rung.device}/${rung.dtype}`;
}

/** One failure as a line for the console and the copied readings. @param {Failure} failure */
export function failureLine(failure) {
  const stage = failure.stage === 'prove' ? 'first look' : failure.stage;
  return `${rungName(failure.rung)} ${stage}: ${failure.message}`;
}

const WHY = {
  load: 'would not load it',
  prove: "can't run this model",
  look: 'failed a look',
};

/**
 * Where the ladder stands, in plain words: `where` is "the GPU" or "the
 * CPU", `why` is null when the first rung proved (nothing to explain) and
 * otherwise the failure that pushed it here.
 * @param {Ladder} ladder
 * @returns {{where: string, rung: string, why: string|null}}
 */
export function landedWords(ladder) {
  const rung = ladder.rungs[ladder.at];
  const where = rung.device === 'webgpu' ? 'the GPU' : 'the CPU';
  const last = ladder.failures.at(-1);
  if (!last) return { where, rung: rungName(rung), why: null };
  // Off the GPU altogether: the backend is what failed. Still on it: name
  // the precision that failed, since the backend itself is in use.
  const what = rung.device === last.rung.device ? rungName(last.rung) : 'the GPU backend';
  return { where, rung: rungName(rung), why: `${what} ${WHY[last.stage]}` };
}

/**
 * Why a ladder with nothing left gave up, with every rung's failure.
 * "Offline?" is offered only when no rung got as far as a look.
 * @param {Ladder} ladder
 */
export function gaveUpWords(ladder) {
  const ran = ladder.failures.some((failure) => failure.stage !== 'load');
  const head = ran ? 'no backend could run the model' : 'no backend would load the model (offline?)';
  return `${head} — ${ladder.failures.map(failureLine).join('; ')}`;
}

/**
 * The triage switch `?modelfault=` (records/design/model-ladder.md): a comma list of
 * `<rung>:<stage>`, where `<rung>` is `all`, a device or one rung
 * (`webgpu/fp16`). Returns the stage this rung is asked to fail at, or
 * null. The first matching entry wins.
 * @param {string|null|undefined} spec
 * @param {Rung} rung
 * @returns {Stage|null}
 */
export function faultFor(spec, rung) {
  if (!spec) return null;
  for (const entry of spec.split(',')) {
    const [target, stage] = entry.trim().split(':');
    if (stage !== 'load' && stage !== 'prove' && stage !== 'look') continue;
    if (target === 'all' || target === rung.device || target === rungName(rung)) return stage;
  }
  return null;
}
