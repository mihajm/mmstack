import {
  isLoading,
  loading,
  registerCanonical,
  sensitive,
  sentinelAware,
  setErrorReporter,
  setSensitiveMode,
  unbox,
  unboxAll,
} from '@mmstack/primitives/core';
import {
  coalesce,
  invoke,
  member,
  or,
  strictBinary,
  strictUnary,
} from './algebra';
import { ARRAY_METHOD_SHIMS, spreadArray, type ApplyFn } from './containers';
import { isLabeled } from './sensitive';

const call: ApplyFn = (target, args) =>
  (target as (...a: unknown[]) => unknown)(...args);
const shim = (name: string) => ARRAY_METHOD_SHIMS[name];
const add = (a: unknown, b: unknown) => (a as number) + (b as number);
/** An array with holes at the indexes `values` leaves out. */
const sparse = (length: number, values: Record<number, unknown>): unknown[] => {
  const out = new Array<unknown>(length);
  for (const [i, v] of Object.entries(values)) out[Number(i)] = v;
  return out;
};
const asc = (a: unknown, b: unknown) => (a as number) - (b as number);

function thrown(f: () => unknown): unknown {
  try {
    f();
  } catch (e) {
    return e;
  }
  throw new Error('expected a throw');
}

beforeEach(() => {
  setErrorReporter(() => undefined);
  setSensitiveMode(true);
});
afterEach(() => {
  setSensitiveMode(false);
  setErrorReporter(undefined);
});

describe('mode on, nothing labeled: absorbing arguments', () => {
  const p = loading();
  it.each<[string, unknown[], unknown[]]>([
    ['slice', [1, 2, 3], [p]],
    ['at', [1, 2], [p]],
    ['flat', [[1]], [p]],
    ['indexOf', [1, 2], [p]],
    ['toSpliced', [1, 2], [0, p]],
    ['with', [1], [p, 2]],
    ['join', [1, p], []],
    ['join', [1], [p]],
    ['join', ['a', p], []],
    ['join', [['a', p]], []],
    ['toSorted', [[p], 1], []],
    ['find', [1], [() => p]],
  ])('%s(%o, %o) is the pending', (method, receiver, args) => {
    expect(shim(method)(receiver, args, call)).toBe(p);
  });

  it('a pending in a spreading position makes the result pending; a fixed-length position keeps it', () => {
    expect(shim('concat')([0], [p], call)).toBe(p);
    expect(shim('flat')([[1], p], [], call)).toBe(p);
    expect(shim('flatMap')([1], [sentinelAware(() => p)], call)).toBe(p);
    expect(shim('with')([1], [0, p], call)).toEqual([p]);
    expect(shim('map')([1], [sentinelAware(() => p)], call)).toEqual([p]);
    expect(shim('flat')([p], [0], call)).toEqual([p]);
  });

  it('labeled: a labeled pending in a spreading position gives a labeled pending', () => {
    for (const out of [
      shim('concat')([0], [sensitive(p)], call),
      shim('flat')([[1], sensitive(p)], [], call),
      shim('flat')(sensitive([[1], p]), [], call),
      shim('flatMap')([1], [sentinelAware(() => sensitive(p))], call),
      shim('flatMap')(sensitive([1]), [sentinelAware(() => p)], call),
    ]) {
      expect(isLabeled(out)).toBe(true);
      expect(unbox(out)).toBe(p);
    }
  });

  it('spreading a pending gives the pending', () => {
    expect(spreadArray(p)).toBe(p);
  });
});

describe('mode on: labels on errors', () => {
  it('a native throw with no label anywhere stays unlabeled', () => {
    for (const f of [
      () => shim('map')([1], [5], call),
      () => shim('slice')([1], [Symbol()], call),
      () => shim('toSorted')([2, 1], [() => Symbol()], call),
      () =>
        strictUnary(
          {
            valueOf: () => {
              throw new Error('v');
            },
          },
          (v) => +(v as number),
        ),
      () =>
        invoke(
          sentinelAware(() => {
            throw new Error('aware');
          }),
          [1],
          call,
        ),
    ]) {
      const e = thrown(f);
      expect(isLabeled(e)).toBe(false);
    }
  });

  it('a throw caused by a labeled argument or callback is labeled', () => {
    for (const f of [
      () => shim('map')([1], [sensitive(5)], call),
      () => spreadArray(sensitive(5)),
      () => shim('toSorted')([1, 2], [sensitive(5)], call),
    ]) {
      const e = thrown(f);
      expect(e).toBeInstanceOf(TypeError);
      expect(isLabeled(e)).toBe(true);
    }
  });

  it('a thrown null under a labeled call is rethrown as null', () => {
    expect(
      thrown(() =>
        member(sensitive({}), () => {
          throw null;
        }),
      ),
    ).toBeNull();
  });
});

describe('mode on: labeled operands match the mode-off answer', () => {
  it('callbacks, seeds and receivers through boxes', () => {
    const r = [
      shim('map')([1, 2], [sensitive((x: number) => x * 2)], call),
      shim('reduce')([1, 2], [sensitive(add)], call),
      shim('flatMap')(sensitive([1]), [(x: unknown) => x], call),
      shim('toSorted')([sensitive('a'), undefined], [], call),
      shim('toSorted')(sensitive(['b', 'a']), [], call),
      shim('toSorted')([sensitive(1), '1'], [], call),
    ];
    expect(r.every(isLabeled)).toBe(true);
    expect(unboxAll(r)).toEqual([
      [2, 4],
      3,
      [1],
      ['a', undefined],
      ['a', 'b'],
      [1, '1'],
    ]);
  });

  it('a labeled pending propagates labeled', () => {
    const p = loading();
    for (const out of [
      shim('toSorted')(sensitive([2, p]), [], call),
      shim('join')([sensitive([p])], [], call),
      spreadArray(sensitive(p)),
      strictBinary(sensitive(p), 1, add),
    ]) {
      expect(isLabeled(out)).toBe(true);
      expect(isLoading(unbox(out))).toBe(true);
    }
  });

  it('a comparator over a labeled element labels the answer even when it is never called on it', () => {
    for (const x of [undefined, 2]) {
      const out = shim('toSorted')([sensitive(x), 1], [asc], call);
      expect(isLabeled(out)).toBe(true);
    }
  });

  it('a BigInt verdict over labeled operands throws as it does natively', () => {
    const xs = sensitive([3n, 1n, 2n]);
    expect(() => shim('toSorted')(xs, [asc], call)).toThrow(TypeError);
    setSensitiveMode(false);
    expect(() => shim('toSorted')([3n, 1n, 2n], [asc], call)).toThrow(
      TypeError,
    );
  });

  it('falsy and nullish secrets choose on the inner value', () => {
    const r = [
      or(sensitive(0), () => 'x'),
      coalesce(sensitive(null), () => 'd'),
      coalesce(sensitive(undefined), () => 'd'),
      strictBinary(sensitive(null), 1, add),
    ];
    expect(r.every(isLabeled)).toBe(true);
    expect(unboxAll(r)).toEqual(['x', 'd', 'd', 1]);
  });

  it('operators over a sparse array holding a box label the answer without throwing', () => {
    const out = strictBinary(
      sparse(2, { 1: sensitive(1) }),
      '',
      (a, b) => `${a}${b}`,
    );
    expect(isLabeled(out)).toBe(true);
    expect(unbox(out)).toBe(',1');
  });

  it('a labeled twin nested in an argument reaches the callee as its plain sentinel', () => {
    const p = loading();
    let seen: unknown;
    const out = invoke(
      (arr: unknown[]) => ((seen = arr[0]), arr[0] === p),
      [[sensitive(p)]],
      call,
    );
    expect(seen).toBe(p);
    expect(unbox(out)).toBe(true);
  });

  it('a per-field view reaches the callee as its raw value', () => {
    const raw = { a: 's', b: 2 };
    const view = registerCanonical({ a: sensitive('s'), b: 2 }, raw);
    let received: unknown;
    invoke((o: unknown) => (received = o), [view], call);
    expect(received).toBe(raw);
  });

  it('isLabeled answers false once the mode is off', () => {
    const b = sensitive(1);
    expect(isLabeled(b)).toBe(true);
    setSensitiveMode(false);
    expect(isLabeled(b)).toBe(false);
  });
});
