import { type ResourceStatus, signal } from '@angular/core';
import fc from 'fast-check';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { joinAbsorbers } from '../semantics/algebra';
import {
  DONE,
  error,
  type ErrorMintReport,
  loading,
  setErrorReporter,
} from '../semantics/sentinel';
import { type Precedence } from './census';
import { demandOf } from './demand';
import { joined, settle, type Result } from './joined';
import { latest, use, type UseSource } from './latest';

type State = 'value' | 'held' | 'loading' | 'error' | 'awaiting';
const STATES: readonly State[] = [
  'value',
  'held',
  'loading',
  'error',
  'awaiting',
];
const ORDERS: readonly Precedence[] = ['pending-first', 'error-first'];

type Fake = UseSource<number> & {
  readonly status: ReturnType<typeof signal<ResourceStatus>>;
  readonly value: ReturnType<typeof signal<number | undefined>>;
  readonly error: ReturnType<typeof signal<unknown>>;
  readonly cause: Error;
  readonly n: number;
};

let counter = 0;

function fake(state: State): Fake {
  const n = ++counter;
  const cause = new Error(`cause-${n}`);
  const status = signal<ResourceStatus>(
    state === 'value'
      ? 'resolved'
      : state === 'held'
        ? 'reloading'
        : state === 'awaiting'
          ? 'idle'
          : state,
  );
  const value = signal<number | undefined>(
    state === 'value' || state === 'held' ? n : undefined,
  );
  const err = signal<unknown>(state === 'error' ? cause : undefined);
  return {
    status,
    value,
    error: err,
    hasValue: () => value() !== undefined,
    cause,
    n,
  };
}

const tag = (s: State): Result<unknown>['kind'] =>
  s === 'value' || s === 'held' ? 'value' : s === 'error' ? 'error' : 'pending';

/** Independent model: the rank join over member tags, ties to the leftmost. */
function model(states: readonly State[], order: Precedence) {
  const rank = (k: Result<unknown>['kind']) =>
    k === 'value'
      ? -1
      : (k === 'error') === (order === 'pending-first')
        ? 0
        : 1;
  let winner = -1;
  let at = -1;
  states.forEach((s, i) => {
    const r = rank(tag(s));
    if (r > winner) {
      winner = r;
      at = i;
    }
  });
  return { kind: at < 0 ? 'value' : tag(states[at]), at };
}

function combos(n: number): State[][] {
  if (n === 0) return [[]];
  return combos(n - 1).flatMap((rest) => STATES.map((s) => [s, ...rest]));
}

let reports: ErrorMintReport[];
beforeEach(() => {
  reports = [];
  setErrorReporter((r) => reports.push(r));
});
afterEach(() => setErrorReporter(undefined));

describe('settle', () => {
  it('a value, undefined and DONE settle as value', () => {
    expect(settle(3)).toEqual({ kind: 'value', value: 3 });
    expect(settle(undefined)).toEqual({ kind: 'value', value: undefined });
    expect(settle(DONE)).toEqual({ kind: 'value', value: undefined });
  });

  it('loading settles as pending with its source, one result object per sentinel', () => {
    const s = loading({ kind: 'resource', name: 'orders' });
    expect(settle(s)).toEqual({
      kind: 'pending',
      source: { kind: 'resource', name: 'orders' },
    });
    expect(settle(s)).toBe(settle(s));
  });

  it('an edge error settles with its cause; an authored one with the sentinel itself', () => {
    const f = fake('error');
    const [out] = [demandOf(f)];
    expect(settle(out as never)).toEqual({ kind: 'error', error: f.cause });
    const authored = error('bad');
    expect(settle(authored)).toEqual({ kind: 'error', error: authored });
  });
});

describe('joined', () => {
  for (const order of ORDERS) {
    for (const n of [2, 3]) {
      it(`[TABLE] ${n} sources × ${STATES.length} states, ${order}: tag and payload match the rank model and joinAbsorbers`, () => {
        for (const states of combos(n)) {
          const sources = states.map(fake);
          const result = joined(...sources, { precedence: order })();
          const expected = model(states, order);
          expect(result.kind, states.join(',')).toBe(expected.kind);
          const demands = sources.map(demandOf);
          expect(result).toBe(
            joinAbsorbers(demands, order)
              ? settle(joinAbsorbers(demands, order) as never)
              : result,
          );
          if (expected.kind === 'value')
            expect(result).toEqual({
              kind: 'value',
              value: sources.map((s) => s.n),
            });
          else if (expected.kind === 'error')
            expect(result).toEqual({
              kind: 'error',
              error: sources[expected.at].cause,
            });
          else
            expect(result).toEqual({
              kind: 'pending',
              source:
                states[expected.at] === 'awaiting'
                  ? { kind: 'awaiting' }
                  : { kind: 'resource' },
            });
        }
      });
    }
  }

  it('defaults to pending-first', () => {
    const r = joined(fake('error'), fake('loading'))();
    expect(r.kind).toBe('pending');
  });

  it('[fn] maps the values, and runs only when every source has one', () => {
    const a = fake('value');
    const b = fake('loading');
    const fn = vi.fn((x: number, y: number) => x + y);
    const sum = joined(a, b, fn);
    expect(sum().kind).toBe('pending');
    expect(fn).not.toHaveBeenCalled();
    b.value.set(10);
    b.status.set('resolved');
    expect(sum()).toEqual({ kind: 'value', value: a.n + 10 });
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('[fn throw] becomes an error result with the thrown cause, minted and reported once', () => {
    const a = fake('value');
    const boom = new Error('boom');
    const other = signal(0);
    const r = joined(a, () => {
      other();
      throw boom;
    });
    const first = r();
    expect(first).toEqual({ kind: 'error', error: boom });
    other.set(1);
    expect(r()).toBe(first);
    expect(reports.filter((x) => x.origin === 'edge')).toHaveLength(1);
  });

  it('[fn throw] a thrown absorber passes through as its own tag', () => {
    const r = joined(fake('value'), () => {
      throw loading({ kind: 'mine' });
    });
    expect(r()).toEqual({ kind: 'pending', source: { kind: 'mine' } });
  });

  it('[no throw] a source whose read throws is an error result, never a throw', () => {
    const bad = {
      ...fake('value'),
      status: () => {
        throw new TypeError('nope');
      },
    } as unknown as UseSource<number>;
    const r = joined(bad, fake('value'));
    expect(() => r()).not.toThrow();
    expect(r().kind).toBe('error');
  });

  it('[equal] the tuple form dedups element-wise by default; the fn form honours equal', () => {
    // a source whose outcome notifies on every set, so the join recomputes with the same values
    const base = fake('value');
    const out = signal<number>(5, { equal: () => false });
    const a = { ...base, outcome: out } as UseSource<number>;
    const b = fake('value');

    const tuple = joined(a, b);
    const first = tuple();
    out.set(5);
    expect(tuple()).toBe(first);

    const never = joined(a, b, { equal: () => false });
    const n1 = never();
    out.set(5);
    expect(never()).not.toBe(n1);
    expect(never()).toEqual(n1);

    const boxed = joined(a, b, (x, y) => ({ sum: x + y }), {
      equal: (p, q) => p.sum === q.sum,
    });
    const box = boxed();
    out.set(5);
    expect(boxed()).toBe(box);

    const plain = joined(a, b, (x, y) => ({ sum: x + y }));
    const p1 = plain();
    out.set(5);
    expect(plain()).not.toBe(p1);
    expect(plain()).toEqual(p1);
  });

  it('[equal] dedups the value tag only: pending and error keep one object per absorber', () => {
    const a = fake('loading');
    const r = joined(a, fake('value'), { equal: () => true });
    const p = r();
    expect(p.kind).toBe('pending');
    a.status.set('error');
    a.error.set(a.cause);
    expect(r()).toEqual({ kind: 'error', error: a.cause });
  });

  it('[awaiting] an idle source with nothing to show is pending, source awaiting', () => {
    expect(joined(fake('value'), fake('awaiting'))()).toEqual({
      kind: 'pending',
      source: { kind: 'awaiting' },
    });
  });

  it('[DONE] a source settled with no payload contributes undefined', () => {
    const d = { ...fake('value'), outcome: signal(DONE) } as UseSource<number>;
    expect(joined(d, fake('value'))()).toMatchObject({
      kind: 'value',
      value: [undefined, expect.any(Number)],
    });
  });

  it('[latest] a latest is a source through its outcome', () => {
    const a = fake('loading');
    const doubled = latest(() => use(a) * 2);
    const b = fake('value');
    const r = joined(doubled, b, (d, y) => d + y);
    expect(r().kind).toBe('pending');
    a.value.set(4);
    a.status.set('resolved');
    expect(r()).toEqual({ kind: 'value', value: 8 + b.n });
    a.error.set(a.cause);
    a.status.set('error');
    expect(r()).toEqual({ kind: 'error', error: a.cause });
  });

  it('[types] tuple and fn forms infer', () => {
    const t: () => Result<[number, number]> = joined(
      fake('value'),
      fake('value'),
    );
    const f: () => Result<string> = joined(fake('value'), (x) => `${x}`);
    const g: () => Result<{ s: number }> = joined(
      fake('value'),
      fake('value'),
      (x, y) => ({ s: x + y }),
      { equal: (p, q) => p.s === q.s },
    );
    // @ts-expect-error the fn parameters must match the sources
    joined(fake('value'), (x: string) => x);
    expect(t().kind).toBe('value');
    expect(f().kind).toBe('value');
    expect(g().kind).toBe('value');
  });

  it('[PROPERTY] joined(a, b).kind = settle(joinAbsorbers([demand(a), demand(b)], precedence) ?? value).kind', () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...STATES),
        fc.constantFrom(...STATES),
        fc.constantFrom(...ORDERS),
        (sa, sb, order) => {
          const a = fake(sa);
          const b = fake(sb);
          const got = joined(a, b, { precedence: order })();
          const demands = [demandOf(a), demandOf(b)];
          const want = settle(
            (joinAbsorbers(demands, order) ?? demands) as never,
          );
          expect(got.kind).toBe(want.kind);
          expect(got).toEqual(want);
        },
      ),
      { numRuns: 200 },
    );
  });
});
