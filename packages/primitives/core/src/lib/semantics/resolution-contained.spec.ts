import fc from 'fast-check';
import {
  ERR,
  FAULT,
  arrow,
  evalAlgebra,
  lit,
  param,
  plain,
  runOutcome,
  spread,
  type Expr,
} from '@mmstack/primitives/testing';
import { makeExprArbitrary } from './testing/resolution-arbitraries';
import { isSentinel, loading, setStrictSentinels } from './sentinel';

beforeEach(() => setStrictSentinels(true));
afterEach(() => setStrictSentinels(false));

const NULL = lit(8);
const ONE = lit(1);
const ZERO = lit(0);
const PAIR = lit(12);
const P: Expr = { t: 'pending' };
const nullRead: Expr = { t: 'member', k: 'a', o: NULL };

const contained = { containFaults: true } as const;

/** Same shape: sentinels by identity, any two functions alike, containers by entries. */
function same(a: unknown, b: unknown): boolean {
  if (isSentinel(a) || isSentinel(b)) return a === b;
  if (typeof a === 'function' && typeof b === 'function') return true;
  if (Array.isArray(a))
    return (
      Array.isArray(b) &&
      a.length === b.length &&
      a.every((el, i) => same(el, b[i]))
    );
  if (
    typeof a === 'object' &&
    a !== null &&
    typeof b === 'object' &&
    b !== null
  ) {
    const keys = Object.keys(a);
    return (
      keys.length === Object.keys(b).length &&
      keys.every((k) =>
        same(
          (a as Record<string, unknown>)[k],
          (b as Record<string, unknown>)[k],
        ),
      )
    );
  }
  return Object.is(a, b);
}

/** The outcome of `e` with the option absent and with faults contained. */
function both(e: Expr, pending = loading('contained')) {
  return {
    pending,
    thrown: runOutcome(() => evalAlgebra(e, pending, {})),
    held: runOutcome(() => evalAlgebra(e, pending, {}, contained)),
  };
}

describe('resolution model: contained faults', () => {
  it('a fault in a container slot is a value in that slot; without the option it throws', () => {
    const { thrown, held } = both({
      t: 'arr',
      slots: [plain(nullRead), plain(ONE)],
    });
    expect(thrown.kind).toBe('throw');
    expect(held).toEqual({ kind: 'value', value: [FAULT, 1] });
  });

  it('a pending operand outranks a fault the enclosing operation joins', () => {
    const { pending, thrown, held } = both({
      t: 'bin',
      op: 'add',
      l: nullRead,
      r: P,
    });
    expect(thrown.kind).toBe('throw');
    expect(held).toEqual({ kind: 'value', value: pending });
  });

  it('an authored error and a fault join in operand order', () => {
    const { thrown, held } = both({
      t: 'bin',
      op: 'add',
      l: { t: 'err', id: 0 },
      r: nullRead,
    });
    expect(thrown.kind).toBe('throw');
    expect(held.kind).toBe('value');
    expect(held.kind === 'value' && held.value).toBe(ERR[0]);
  });

  it('a non-iterable spread is a fault at the spread; the other slots still evaluate and join', () => {
    const withPending = both({ t: 'arr', slots: [spread(ZERO), spread(P)] });
    expect(withPending.thrown.kind).toBe('throw');
    expect(withPending.held).toEqual({
      kind: 'value',
      value: withPending.pending,
    });

    const call = both({ t: 'call', f: 'double', args: [spread(ZERO)] });
    expect(call.thrown.kind).toBe('throw');
    expect(call.held).toEqual({ kind: 'value', value: FAULT });
  });

  it('a method lookup on a nullish receiver is a fault joined with the arguments', () => {
    const cb = arrow(['p'], param('p'));
    const plainArgs = both({ t: 'hof', m: 'map', arr: NULL, cb });
    expect(plainArgs.thrown.kind).toBe('throw');
    expect(plainArgs.held).toEqual({ kind: 'value', value: FAULT });

    const pendingArg = both({
      t: 'search',
      m: 'includes',
      arr: NULL,
      target: P,
    });
    expect(pendingArg.thrown.kind).toBe('throw');
    expect(pendingArg.held).toEqual({
      kind: 'value',
      value: pendingArg.pending,
    });
  });

  it('a callback body contains its own fault, so the shim receives an error value per element', () => {
    const cb = arrow(['p'], {
      t: 'member',
      k: 'b',
      o: { t: 'member', k: 'a', o: param('p') },
    });
    const { thrown, held } = both({ t: 'hof', m: 'map', arr: PAIR, cb });
    expect(thrown.kind).toBe('throw');
    expect(held).toEqual({ kind: 'value', value: [FAULT, FAULT] });
  });

  it('calling a non-function is a fault at the call', () => {
    const { thrown, held } = both({
      t: 'arr',
      slots: [plain({ t: 'apply', fn: ONE, args: [] }), plain(ZERO)],
    });
    expect(thrown.kind).toBe('throw');
    expect(held).toEqual({ kind: 'value', value: [FAULT, 0] });
  });

  it('[PROVEN] with faults contained nothing throws; where nothing faulted the answer is the same', () => {
    fc.assert(
      fc.property(makeExprArbitrary({ errors: true }), (e) => {
        const { thrown, held } = both(e);
        expect(held.kind).not.toBe('throw');
        if (thrown.kind === 'value') {
          expect(held.kind).toBe('value');
          if (held.kind === 'value') {
            expect(same(held.value, thrown.value)).toBe(true);
          }
        }
        if (thrown.kind === 'leak') expect(held.kind).toBe('leak');
      }),
      { numRuns: 400 },
    );
  });
});
