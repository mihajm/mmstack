import { computed, type ResourceStatus, signal } from '@angular/core';
import fc from 'fast-check';
import { joinAbsorbers } from '../semantics/algebra';
import { isAbsorbing, isError, isLoading } from '../semantics/sentinel';
import { type Precedence } from './census';
import {
  type CreateLatestOptions,
  latest,
  use,
  useAll,
  type UseSource,
} from './latest';

// M6: `latest` / `use` / `useAll` over the lattice. An independent model of demand outcomes,
// the read path and the ranked join is the oracle; the implementation's sentinels are matched
// by identity through single-member probes.

const STATUSES: readonly ResourceStatus[] = [
  'idle',
  'loading',
  'reloading',
  'resolved',
  'local',
  'error',
];

type MemberState = {
  readonly status: ResourceStatus;
  readonly content: boolean;
};

type Member = UseSource<number> & {
  readonly index: number;
  readonly failure: Error;
  set(state: MemberState): void;
};

function member(index: number, withHasContent: boolean): Member {
  const status = signal<ResourceStatus>('idle');
  const content = signal(false);
  const failure = new Error(`m${index}`);
  return {
    index,
    failure,
    status,
    value: computed(() => {
      if (status() === 'error') throw failure; // Angular ResourceRef semantics
      return content() ? index + 1 : undefined;
    }),
    hasValue: () => status() !== 'error' && content(),
    ...(withHasContent ? { hasContent: () => content() } : {}),
    error: computed(() => (status() === 'error' ? failure : undefined)),
    set: (s) => {
      status.set(s.status);
      content.set(s.content);
    },
  };
}

/** Model demand kind: V value, E error, L loading, A awaiting (idle-like with nothing to show). */
type Kind = 'V' | 'E' | 'L' | 'A';

function demandKind(s: MemberState): Kind {
  if (s.status === 'error') return 'E';
  if (s.content) return 'V';
  return s.status === 'loading' || s.status === 'reloading' ? 'L' : 'A';
}

/** Model rank, written independently of `joinAbsorbers`: higher wins, ties keep the left. */
function rank(kind: Kind | 'T', p: Precedence): number {
  if (kind === 'V') return -1;
  const pending = kind === 'L' || kind === 'A';
  return p === 'pending-first' ? (pending ? 1 : 0) : pending ? 0 : 1;
}

type Step = { readonly at: number; readonly caught: boolean };

type ModelResult = {
  /** Demands in first-read order: member index + kind. */
  readonly demands: readonly { readonly at: number; readonly kind: Kind }[];
  /** Where the evaluation stopped: a member's absorber, the computation's throw, or nothing. */
  readonly stop: { readonly at: number } | 'thrown' | undefined;
  readonly value: number;
};

function runModel(
  states: readonly MemberState[],
  steps: readonly Step[],
  throwAtEnd: boolean,
): ModelResult {
  const demands: { at: number; kind: Kind }[] = [];
  let value = 0;
  for (const step of steps) {
    let d = demands.find((x) => x.at === step.at);
    if (!d) {
      d = { at: step.at, kind: demandKind(states[step.at]) };
      demands.push(d);
    }
    if (d.kind === 'V') value += step.at + 1;
    else if (!step.caught) return { demands, stop: { at: step.at }, value };
  }
  return { demands, stop: throwAtEnd ? 'thrown' : undefined, value };
}

/** The model's expected winner: a member index, 'thrown', or undefined (the value). */
function modelOutcome(
  m: ModelResult,
  mode: 'first' | Precedence,
): number | 'thrown' | undefined {
  if (mode === 'first')
    return m.stop === undefined || m.stop === 'thrown' ? m.stop : m.stop.at;
  let best: { at: number | 'thrown'; r: number } | undefined;
  const candidates: { at: number | 'thrown'; kind: Kind | 'T' }[] = [
    ...m.demands.map((d) => ({ at: d.at, kind: d.kind })),
  ];
  if (m.stop === 'thrown') candidates.push({ at: 'thrown', kind: 'T' });
  for (const c of candidates) {
    const r = rank(c.kind, mode);
    if (r >= 0 && (!best || r > best.r)) best = { at: c.at, r };
  }
  return best?.at;
}

const THROWN = new Error('computation');

function program(
  members: readonly Member[],
  steps: readonly Step[],
  throwAtEnd: boolean,
) {
  return () => {
    let sum = 0;
    for (const step of steps) {
      const m = members[step.at];
      if (!step.caught) {
        sum += use(m);
        continue;
      }
      try {
        sum += use(m);
      } catch (e) {
        if (!isAbsorbing(e)) throw e;
      }
    }
    if (throwAtEnd) throw THROWN;
    return sum;
  };
}

const OPTIONS: Record<'first' | Precedence, CreateLatestOptions<number>> = {
  first: {},
  'pending-first': { errors: 'aggregate' },
  'error-first': { errors: 'aggregate', precedence: 'error-first' },
};

/** The sentinel `use(m)` throws for `m` right now (identity probe through the public surface). */
function probe(m: Member): unknown {
  return latest(() => use(m)).outcome();
}

const stateArb = fc.record({
  status: fc.constantFrom(...STATUSES),
  content: fc.boolean(),
});

const scenarioArb = fc.integer({ min: 1, max: 4 }).chain((n) =>
  fc.record({
    hasContent: fc.array(fc.boolean(), { minLength: n, maxLength: n }),
    // successive member-state snapshots: each is applied, then every mode is checked
    snapshots: fc.array(fc.array(stateArb, { minLength: n, maxLength: n }), {
      minLength: 1,
      maxLength: 4,
    }),
    steps: fc.array(
      fc.record({
        at: fc.integer({ min: 0, max: n - 1 }),
        caught: fc.boolean(),
      }),
      { minLength: 0, maxLength: 6 },
    ),
    throwAtEnd: fc.boolean(),
  }),
);

function expectWinner(
  actual: unknown,
  winner: number | 'thrown' | undefined,
  members: readonly Member[],
  value: number,
) {
  if (winner === undefined) {
    expect(isAbsorbing(actual)).toBe(false);
    expect(actual).toBe(value);
  } else if (winner === 'thrown') {
    expect(isError(actual)).toBe(true);
  } else {
    expect(actual).toBe(probe(members[winner]));
  }
}

describe('latest over the lattice (M6)', () => {
  it("'first' = the evaluation path; 'aggregate' = the ranked join of demand outcomes, both orders (property)", () => {
    fc.assert(
      fc.property(
        scenarioArb,
        ({ hasContent, snapshots, steps, throwAtEnd }) => {
          const members = hasContent.map((h, i) => member(i, h));
          const fn = program(members, steps, throwAtEnd);
          const derived = {
            first: latest(fn, OPTIONS.first),
            'pending-first': latest(fn, OPTIONS['pending-first']),
            'error-first': latest(fn, OPTIONS['error-first']),
          };
          for (const states of snapshots) {
            states.forEach((s, i) => members[i].set(s));
            const model = runModel(states, steps, throwAtEnd);
            const used = model.demands.map((d) => members[d.at]);
            const inFlight = used.some((m) => {
              const s = m.status();
              return s === 'loading' || s === 'reloading';
            });
            for (const mode of [
              'first',
              'pending-first',
              'error-first',
            ] as const) {
              const l = derived[mode];
              const out = l.outcome();
              expectWinner(
                out,
                modelOutcome(model, mode),
                members,
                model.value,
              );

              if (mode !== 'first') {
                // the same answer straight from the algebra, over the demand objects
                const demandObjects = used.map((m) =>
                  demandKind(states[m.index]) === 'V' ? m.value() : probe(m),
                );
                const stop =
                  model.stop === 'thrown'
                    ? out // a computation throw is its own edge (checked below)
                    : model.stop === undefined
                      ? undefined
                      : probe(members[model.stop.at]);
                expect(
                  joinAbsorbers([...demandObjects, stop], mode) ?? model.value,
                ).toBe(out);
              }

              // two axes: pending is the used members' flight, whatever the value plane says
              expect(l.pending()).toBe(inFlight);
              const expectedStatus = isError(out)
                ? 'error'
                : inFlight
                  ? l.hasValue()
                    ? 'reloading'
                    : 'loading'
                  : isAbsorbing(out)
                    ? 'idle'
                    : 'resolved';
              expect(l.status()).toBe(expectedStatus);

              if (isError(out)) {
                const winner = modelOutcome(model, mode);
                expect(l.error()).toBe(
                  winner === 'thrown'
                    ? THROWN
                    : members[winner as number].failure,
                );
              } else {
                // otherwise the first used member's own error, in read order
                const firstErrored = used.find((m) => m.status() === 'error');
                expect(l.error()).toBe(firstErrored?.failure);
              }
            }
          }
        },
      ),
      { numRuns: 300 },
    );
  });

  it('useAll throws the join of every demand under the frame precedence, in both modes (property)', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 4 }).chain((n) =>
          fc.record({
            hasContent: fc.array(fc.boolean(), { minLength: n, maxLength: n }),
            states: fc.array(stateArb, { minLength: n, maxLength: n }),
          }),
        ),
        ({ hasContent, states }) => {
          const members = hasContent.map((h, i) => member(i, h));
          states.forEach((s, i) => members[i].set(s));
          const kinds = states.map(demandKind);
          for (const mode of [
            'first',
            'pending-first',
            'error-first',
          ] as const) {
            let returned: readonly number[] | undefined;
            const l = latest(() => {
              returned = useAll(...members);
              return returned.reduce((a, b) => a + b, 0);
            }, OPTIONS[mode]);
            const out = l.outcome();
            // in 'first' mode the frame precedence is the default, pending-first
            const order: Precedence = mode === 'first' ? 'pending-first' : mode;
            const demands = members.map((m, i) =>
              kinds[i] === 'V' ? m.value() : probe(m),
            );
            const join = joinAbsorbers(demands, order);
            if (join) expect(out).toBe(join);
            else {
              expect(returned).toEqual(members.map((m) => m.index + 1));
              expect(out).toBe(returned?.reduce((a, b) => a + b, 0));
            }
            // and the model agrees on which member won
            let best = -1;
            let bestRank = -1;
            kinds.forEach((k, i) => {
              const r =
                k === 'V'
                  ? -1
                  : (order === 'pending-first') === (k !== 'E')
                    ? 1
                    : 0;
              if (r > bestRank) {
                best = i;
                bestRank = r;
              }
            });
            expect(join).toBe(best < 0 ? undefined : probe(members[best]));
          }
        },
      ),
      { numRuns: 300 },
    );
  });

  it('useAll outside latest() throws like use() does', () => {
    const m = member(0, true);
    expect(() => useAll(m)).toThrowError(
      /useAll\(\) must be called synchronously/,
    );
  });
});

describe('latest over the lattice: named rows (M6)', () => {
  const at = (status: ResourceStatus, content: boolean, i = 0, h = true) => {
    const m = member(i, h);
    m.set({ status, content });
    return m;
  };

  /** Reads every source, moves past absorbers, then rethrows the FIRST one read (the path). */
  const readAllThrowFirst =
    (...sources: Member[]) =>
    () => {
      let first: unknown;
      let sum = 0;
      for (const s of sources) {
        try {
          sum += use(s);
        } catch (e) {
          if (!isAbsorbing(e)) throw e;
          first ??= e;
        }
      }
      if (first !== undefined) throw first;
      return sum;
    };

  it('two axes: a keepPrevious reload keeps outcome at the value while pending is true', () => {
    const m = at('resolved', true);
    for (const opt of Object.values(OPTIONS)) {
      const l = latest(() => use(m) * 10, opt);
      expect(l.outcome()).toBe(10);
      m.set({ status: 'reloading', content: true });
      expect(l.outcome()).toBe(10);
      expect(l.pending()).toBe(true);
      expect(l.isLoading()).toBe(true);
      expect(l.status()).toBe('reloading');
      m.set({ status: 'resolved', content: true });
    }
  });

  it("idle with no content under 'aggregate' yields the awaiting absorber, never undefined (both orders)", () => {
    const idle = at('idle', false);
    const errored = at('error', false, 1);
    for (const opt of [OPTIONS['pending-first'], OPTIONS['error-first']]) {
      const alone = latest(() => use(idle), opt);
      const out = alone.outcome();
      expect(out).not.toBeUndefined();
      expect(isLoading(out)).toBe(true);
      expect((out as { source: unknown }).source).toEqual({ kind: 'awaiting' });
      expect(alone.status()).toBe('idle');
      expect(alone.pending()).toBe(false);
    }
    // and it joins: pending-first keeps it over an error, error-first lets the error win
    const pf = latest(
      readAllThrowFirst(idle, errored),
      OPTIONS['pending-first'],
    );
    const ef = latest(readAllThrowFirst(idle, errored), OPTIONS['error-first']);
    expect(isLoading(pf.outcome())).toBe(true);
    expect(isError(ef.outcome())).toBe(true);
    expect(ef.error()).toBe(errored.failure);
  });

  it('nesting composes per mode: an inner latest is a UseSource through its outcome', () => {
    for (const [innerMode, outerMode] of [
      ['first', 'first'],
      ['pending-first', 'first'],
      ['error-first', 'pending-first'],
      ['pending-first', 'error-first'],
    ] as const) {
      const a = at('loading', false, 0);
      const b = at('error', false, 1);
      const c = at('resolved', true, 2);
      const inner = latest(readAllThrowFirst(a, b), OPTIONS[innerMode]);
      const outer = latest(
        readAllThrowFirst(inner as unknown as Member, c),
        OPTIONS[outerMode],
      );
      // the inner absorber is the outer demand for `inner`: thrown as is, never re-minted
      expect(outer.outcome()).toBe(inner.outcome());
      expect(outer.status()).toBe(inner.status());
      expect(outer.error()).toBe(inner.error());
      a.set({ status: 'resolved', content: true });
      b.set({ status: 'resolved', content: true });
      expect(inner.outcome()).toBe(3);
      expect(outer.outcome()).toBe(6);
      expect(outer.status()).toBe('resolved');
    }
  });

  it('nesting: an inner error keeps its cause across levels', () => {
    const r = at('resolved', true);
    const inner = latest(() => use(r));
    const outer = latest(() => use(inner) + 1, OPTIONS['pending-first']);
    expect(outer()).toBe(2);
    r.set({ status: 'error', content: false });
    expect(outer.outcome()).toBe(inner.outcome());
    expect(outer.error()).toBe(r.failure);
    expect(outer()).toBe(2);
  });

  it("[CHARACTERIZED → flip, narrowed] used a valued, used b errored, then a reloads with held content: every mode answers 'error' with pending true (a demands a value, b an error; the join has no pending)", () => {
    for (const opt of Object.values(OPTIONS)) {
      const a = at('resolved', true, 0);
      const b = at('resolved', true, 1);
      const l = latest(() => use(a) + use(b), opt);
      expect(l()).toBe(3);
      b.set({ status: 'error', content: false });
      a.set({ status: 'reloading', content: true });
      expect(l.status()).toBe('error');
      expect(isError(l.outcome())).toBe(true);
      expect(l.error()).toBe(b.failure);
      expect(l.pending()).toBe(true);
      expect(l()).toBe(3);
    }
  });

  it("[CHARACTERIZED → flip, narrowed] old: status was an error-wins fold over the deps regardless of the evaluation path; now a pending-without-content a + an errored b part ways: 'first' = whichever is read first, 'aggregate' pending-first = loading, error-first = error", () => {
    const cells = (order: 'ab' | 'ba') => {
      const a = at('loading', false, 0);
      const b = at('error', false, 1);
      const fn =
        order === 'ab' ? readAllThrowFirst(a, b) : readAllThrowFirst(b, a);
      return {
        first: latest(fn, OPTIONS.first),
        pf: latest(fn, OPTIONS['pending-first']),
        ef: latest(fn, OPTIONS['error-first']),
        b,
      };
    };
    const ab = cells('ab');
    expect(ab.first.status()).toBe('loading');
    expect(isLoading(ab.first.outcome())).toBe(true);
    const ba = cells('ba');
    expect(ba.first.status()).toBe('error');
    expect(ba.first.error()).toBe(ba.b.failure);
    for (const c of [ab, ba]) {
      expect(c.pf.status()).toBe('loading');
      expect(isLoading(c.pf.outcome())).toBe(true);
      expect(c.ef.status()).toBe('error');
      expect(c.ef.error()).toBe(c.b.failure);
      for (const l of [c.first, c.pf, c.ef]) expect(l.pending()).toBe(true);
    }
  });

  it("plain sequential use() stops at the first absorber, so 'aggregate' sees only what was read: the modes agree there", () => {
    const a = at('loading', false, 0);
    const b = at('error', false, 1);
    for (const opt of Object.values(OPTIONS)) {
      expect(isLoading(latest(() => use(a) + use(b), opt).outcome())).toBe(
        true,
      );
      expect(isError(latest(() => use(b) + use(a), opt).outcome())).toBe(true);
    }
  });

  it('a non-sentinel throw is the computation’s own error, minted once per thrown value', () => {
    const boom = new Error('own');
    const tick = signal(0);
    const l = latest(() => {
      tick();
      throw boom;
    });
    const out = l.outcome();
    expect(isError(out)).toBe(true);
    tick.set(1);
    expect(l.outcome()).toBe(out);
    expect(l.error()).toBe(boom);
  });

  it('options are a discriminated union: precedence only under aggregate', () => {
    const ok: CreateLatestOptions<number>[] = [
      {},
      { errors: 'first' },
      { errors: 'aggregate' },
      { errors: 'aggregate', precedence: 'error-first' },
    ];
    // @ts-expect-error precedence without errors: 'aggregate'
    const bad1: CreateLatestOptions<number> = { precedence: 'error-first' };
    type Opt = CreateLatestOptions<number>;
    // @ts-expect-error precedence under errors: 'first'
    const bad2: Opt = { errors: 'first', precedence: 'pending-first' };
    expect([ok.length, bad1, bad2].length).toBe(3);
  });
});
