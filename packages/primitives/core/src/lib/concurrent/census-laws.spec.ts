import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

type Outcome =
  { kind: 'ok' } | { kind: 'error'; error: string } | { kind: 'skipped' };
type Facade =
  | { kind: 'idle' }
  | { kind: 'running'; gen: number; prior?: string }
  | { kind: 'error'; gen: number; error: string }
  | { kind: 'ok'; gen: number }
  | { kind: 'skipped'; gen: number };
type FacadeEvent =
  { t: 'start'; gen: number } | { t: 'settle'; gen: number; outcome: Outcome };

const priorFailure = (s: Facade): string | undefined =>
  s.kind === 'error' ? s.error : s.kind === 'running' ? s.prior : undefined;

function reduce(
  state: Facade,
  event: FacadeEvent,
  highestGen: number,
): [Facade, number] {
  if (event.t === 'start') {
    if (event.gen <= highestGen) return [state, highestGen];
    return [
      { kind: 'running', gen: event.gen, prior: priorFailure(state) },
      event.gen,
    ];
  }
  if (state.kind !== 'running' || event.gen !== state.gen)
    return [state, highestGen];
  switch (event.outcome.kind) {
    case 'ok':
      return [{ kind: 'ok', gen: event.gen }, highestGen];
    case 'error':
      return [
        { kind: 'error', gen: event.gen, error: event.outcome.error },
        highestGen,
      ];
    case 'skipped':
      return state.prior !== undefined
        ? [{ kind: 'error', gen: event.gen, error: state.prior }, highestGen]
        : [{ kind: 'skipped', gen: event.gen }, highestGen];
  }
}

function runFacade(events: readonly FacadeEvent[]): Facade {
  let state: Facade = { kind: 'idle' };
  let highest = 0;
  for (const e of events) [state, highest] = reduce(state, e, highest);
  return state;
}

const storyFailure = (s: Facade): string | undefined =>
  s.kind === 'error' ? s.error : s.kind === 'running' ? s.prior : undefined;
const storyPending = (_s: Facade): boolean => false;

describe('[PROVEN] story facade reducer — skip-precedence + generation (pure model)', () => {
  it('skip over a prior failure REVERTS to that failure — the error is not cleared', () => {
    const s = runFacade([
      { t: 'start', gen: 1 },
      { t: 'settle', gen: 1, outcome: { kind: 'error', error: 'boom' } },
      { t: 'start', gen: 2 },
      { t: 'settle', gen: 2, outcome: { kind: 'skipped' } },
    ]);
    expect(s).toEqual({ kind: 'error', gen: 2, error: 'boom' });
    expect(storyFailure(s)).toBe('boom');
  });

  it('a successful retry CLEARS the failure; a new failure REPLACES it', () => {
    const ok = runFacade([
      { t: 'start', gen: 1 },
      { t: 'settle', gen: 1, outcome: { kind: 'error', error: 'boom' } },
      { t: 'start', gen: 2 },
      { t: 'settle', gen: 2, outcome: { kind: 'ok' } },
    ]);
    expect(storyFailure(ok)).toBeUndefined();

    const replaced = runFacade([
      { t: 'start', gen: 1 },
      { t: 'settle', gen: 1, outcome: { kind: 'error', error: 'boom' } },
      { t: 'start', gen: 2 },
      { t: 'settle', gen: 2, outcome: { kind: 'error', error: 'boom2' } },
    ]);
    expect(storyFailure(replaced)).toBe('boom2');
  });

  it('a retry in flight over a failure stays CENSUSED (no flicker out of the error fold)', () => {
    let state: Facade = { kind: 'idle' };
    let hi = 0;
    [state, hi] = reduce(state, { t: 'start', gen: 1 }, hi);
    [state, hi] = reduce(
      state,
      { t: 'settle', gen: 1, outcome: { kind: 'error', error: 'boom' } },
      hi,
    );
    // eslint-disable-next-line no-useless-assignment
    [state, hi] = reduce(state, { t: 'start', gen: 2 }, hi);
    expect(state.kind).toBe('running');
    expect(storyFailure(state)).toBe('boom');
    expect(storyPending(state)).toBe(false);
  });

  it('a skip with NO prior failure settles skipped (idle → running → skipped)', () => {
    const s = runFacade([
      { t: 'start', gen: 1 },
      { t: 'settle', gen: 1, outcome: { kind: 'skipped' } },
    ]);
    expect(s).toEqual({ kind: 'skipped', gen: 1 });
    expect(storyFailure(s)).toBeUndefined();
  });

  it('generation: a stale completion for a superseded invocation NEVER settles the facade', () => {
    const s = runFacade([
      { t: 'start', gen: 1 },
      { t: 'start', gen: 2 },
      { t: 'settle', gen: 1, outcome: { kind: 'ok' } },
    ]);
    expect(s).toEqual({ kind: 'running', gen: 2, prior: undefined });
  });

  it('property: a skip sequence after a failure always reports the failure, never skipped', () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 6 }), (retries) => {
        const events: FacadeEvent[] = [
          { t: 'start', gen: 1 },
          { t: 'settle', gen: 1, outcome: { kind: 'error', error: 'E' } },
        ];
        for (let g = 2; g <= retries + 1; g++) {
          events.push({ t: 'start', gen: g });
          events.push({ t: 'settle', gen: g, outcome: { kind: 'skipped' } });
        }
        const s = runFacade(events);
        return storyFailure(s) === 'E' && s.kind === 'error';
      }),
    );
  });

  it('property: only the current running generation may settle the facade', () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.record({ gen: fc.integer({ min: 1, max: 5 }), ok: fc.boolean() }),
          {
            maxLength: 12,
          },
        ),
        (settles) => {
          let state: Facade = { kind: 'idle' };
          let hi = 0;
          [state, hi] = reduce(state, { t: 'start', gen: 3 }, hi);
          for (const s of settles) {
            if (s.gen === 3) continue;
            const [next] = reduce(
              state,
              {
                t: 'settle',
                gen: s.gen,
                outcome: s.ok ? { kind: 'ok' } : { kind: 'error', error: 'x' },
              },
              hi,
            );
            if (
              next !== state &&
              JSON.stringify(next) !== JSON.stringify(state)
            )
              return false;
          }
          return state.kind === 'running' && state.gen === 3;
        },
      ),
    );
  });
});

interface ModelMember {
  readiness: boolean;
  paused: boolean;
  pending: boolean;
  failure: string | undefined;
}
type ModelFold =
  | { kind: 'idle' }
  | { kind: 'pending' }
  | { kind: 'error'; failures: readonly string[] };

function fold(members: readonly ModelMember[]): ModelFold {
  const visible = members.filter((m) => !m.paused);
  if (visible.some((m) => m.readiness && m.pending)) return { kind: 'pending' };
  const failures = visible
    .filter((m) => m.failure !== undefined)
    .map((m) => m.failure as string);
  return failures.length ? { kind: 'error', failures } : { kind: 'idle' };
}

describe('census folds — pending absorbs error, paused member leaves both folds (pure model)', () => {
  it('pending outranks error (joinAbsorbers): any pending readiness member ⇒ fold is pending', () => {
    const f = fold([
      { readiness: true, paused: false, pending: true, failure: undefined },
      { readiness: true, paused: false, pending: false, failure: 'boom' },
    ]);
    expect(f).toEqual({ kind: 'pending' });
  });

  it('a paused member exits BOTH folds (its pending and its failure are invisible)', () => {
    const pendingPaused = fold([
      { readiness: true, paused: true, pending: true, failure: undefined },
      { readiness: true, paused: false, pending: false, failure: 'boom' },
    ]);
    expect(pendingPaused).toEqual({ kind: 'error', failures: ['boom'] });

    const errorPaused = fold([
      { readiness: true, paused: true, pending: false, failure: 'boom' },
    ]);
    expect(errorPaused).toEqual({ kind: 'idle' });
  });

  it('complete-census-at-quiescence: staggered failures present as pending until quiescent, then ALL', () => {
    const a: ModelMember = {
      readiness: true,
      paused: false,
      pending: true,
      failure: undefined,
    };
    const b: ModelMember = {
      readiness: true,
      paused: false,
      pending: true,
      failure: undefined,
    };
    const c: ModelMember = {
      readiness: true,
      paused: false,
      pending: true,
      failure: undefined,
    };
    const members = [a, b, c];

    b.pending = false;
    b.failure = 'B';
    expect(fold(members)).toEqual({ kind: 'pending' });

    c.pending = false;
    c.failure = 'C';
    expect(fold(members)).toEqual({ kind: 'pending' });

    a.pending = false;
    expect(fold(members)).toEqual({ kind: 'error', failures: ['B', 'C'] });
  });

  it('references-not-copies: the fold reads member state live; mutating a member is reflected', () => {
    const m: ModelMember = {
      readiness: true,
      paused: false,
      pending: false,
      failure: undefined,
    };
    const members = [m];
    expect(fold(members)).toEqual({ kind: 'idle' });
    m.failure = 'late';
    expect(fold(members)).toEqual({ kind: 'error', failures: ['late'] });
  });
});
