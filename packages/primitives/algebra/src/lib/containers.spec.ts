import { ARRAY_METHOD_SHIMS, spreadArray, type ApplyFn } from './containers';
import {
  isLoading,
  isSentinel,
  loading,
  sentinelAware,
} from '@mmstack/primitives/core';

const applyCall: ApplyFn = (target, args) =>
  (target as (...fnArgs: unknown[]) => unknown)(...args);

const shim = (name: string) => ARRAY_METHOD_SHIMS[name];

describe('containers', () => {
  describe('[ORACLE] mutation-survivor kill pins', () => {
    const pending = loading();

    it('find is directional — first match, not last', () => {
      expect(
        shim('find')(
          [1, 2, 3, 4],
          [(x: unknown) => (x as number) > 1],
          applyCall,
        ),
      ).toBe(2);
      expect(
        shim('findLast')(
          [1, 2, 3, 4],
          [(x: unknown) => (x as number) > 1],
          applyCall,
        ),
      ).toBe(4);
    });

    it('indexOf/lastIndexOf with a sentinel search element propagate instead of answering -1', () => {
      expect(shim('indexOf')([1, 2], [pending], applyCall)).toBe(pending);
      expect(shim('lastIndexOf')([1, 2], [pending], applyCall)).toBe(pending);
    });

    it('the per-element index argument reaches callbacks', () => {
      expect(
        shim('map')([5, 6], [(_: unknown, i: unknown) => i], applyCall),
      ).toEqual([0, 1]);
      expect(
        shim('filter')(
          [5, 6],
          [(_: unknown, i: unknown) => i === 1],
          applyCall,
        ),
      ).toEqual([6]);
      expect(
        shim('find')([5, 6], [(_: unknown, i: unknown) => i === 1], applyCall),
      ).toBe(6);
    });

    it('reduce propagates sentinels through unaware reducers and recovers through aware ones', () => {
      const add = (a: unknown, b: unknown) => (a as number) + (b as number);
      expect(shim('reduce')([1, pending, 3], [add], applyCall)).toBe(pending);
      expect(shim('reduce')([1, 3], [add, pending], applyCall)).toBe(pending);
      const recovering = sentinelAware((acc: unknown, x: unknown) =>
        isLoading(acc) ? x : (acc as number) + (x as number),
      );
      expect(shim('reduce')([1, 3], [recovering, pending], applyCall)).toBe(4);
    });

    it('coercing-position args on toSpliced/slice/flat propagate, never leak', () => {
      expect(shim('toSpliced')([1, 2], [0, pending], applyCall)).toBe(pending);
      expect(shim('slice')([1, 2, 3], [pending], applyCall)).toBe(pending);
      expect(shim('flat')([[1]], [pending], applyCall)).toBe(pending);
    });

    it('decision shims propagate the DIRECTIONAL first sentinel (provenance order)', () => {
      const a = loading('a');
      const b = loading('b');
      const identity = (x: unknown) => x;
      expect(shim('some')([a, b], [identity], applyCall)).toBe(a);
      expect(shim('findLast')([a, b], [identity], applyCall)).toBe(b);
    });

    it('fallthrough values are JS-faithful', () => {
      const never = () => false;
      const always = () => true;
      expect(shim('every')([1, 2], [always], applyCall)).toBe(true);
      expect(shim('some')([1, 2], [never], applyCall)).toBe(false);
      expect(shim('findLast')([1, 2], [never], applyCall)).toBeUndefined();
      expect(shim('findLastIndex')([1, 2], [never], applyCall)).toBe(-1);
    });

    it('flatMap flattens exactly one level', () => {
      expect(shim('flatMap')([[1]], [(x: unknown) => [x]], applyCall)).toEqual([
        [1],
      ]);
    });

    it('toSorted collects every absorbing comparison and joins them — it does NOT stop at the first (schedule-independence)', () => {
      const inner = vi.fn(() => loading('cmp'));
      const cmp = sentinelAware(inner);
      const result = shim('toSorted')([3, 1, 2], [cmp], applyCall);
      expect(isLoading(result)).toBe(true);
      expect(inner.mock.calls.length).toBeGreaterThan(1);
    });
  });

  describe('[ASSERTED] spread guards', () => {
    it('propagates a sentinel spread source', () => {
      const pending = loading();
      expect(spreadArray(pending)).toBe(pending);
    });

    it('throws JS-faithfully on non-array spread sources', () => {
      expect(() => spreadArray(5)).toThrow(TypeError);
      expect(() => spreadArray(null)).toThrow(TypeError);
    });

    it('passes arrays through, sentinel elements included', () => {
      const arr = [1, loading()];
      expect(spreadArray(arr)).toBe(arr);
    });
  });

  describe('[ORACLE] per-element calls follow invoke semantics', () => {
    it('map with an unaware callback pre-propagates sentinel elements into the result', () => {
      const pending = loading();
      const double = (x: unknown) => 2 * (x as number);
      const result = shim('map')(
        [1, pending, 3],
        [double],
        applyCall,
      ) as unknown[];
      expect(result[0]).toBe(2);
      expect(result[1]).toBe(pending);
      expect(result[2]).toBe(6);
    });

    it('map with an aware callback hands sentinel elements over raw (the skeleton-row pattern)', () => {
      const pending = loading();
      const label = sentinelAware((x: unknown) =>
        isLoading(x) ? 'skeleton' : `row:${x}`,
      );
      expect(shim('map')([1, pending], [label], applyCall)).toEqual([
        'row:1',
        'skeleton',
      ]);
    });
  });

  describe('[ORACLE] decision-position sentinels propagate the whole operation', () => {
    const pending = loading();

    it('filter with an unaware predicate over a pending element propagates', () => {
      const truthy = (x: unknown) => !!x;
      expect(shim('filter')([1, pending, 3], [truthy], applyCall)).toBe(
        pending,
      );
    });

    it('filter with an aware predicate returning a sentinel propagates', () => {
      const cb = sentinelAware((x: unknown) => x);
      expect(shim('filter')([1, pending], [cb], applyCall)).toBe(pending);
    });

    it.each([
      'find',
      'findIndex',
      'findLast',
      'findLastIndex',
      'some',
      'every',
    ])('%s propagates a sentinel verdict', (method) => {
      const identity = (x: unknown) => x;
      expect(shim(method)([pending], [identity], applyCall)).toBe(pending);
    });

    it('toSorted comparator returning a sentinel propagates', () => {
      const cmp = sentinelAware(() => loading('cmp'));
      const result = shim('toSorted')([2, 1], [cmp], applyCall);
      expect(isLoading(result)).toBe(true);
    });

    it('[ORACLE comparator-branch] a sentinelAware comparator over a pending-bearing array RUNS and orders — the receiver scan lives only in the default branch', () => {
      const seen: unknown[] = [];
      const cmp = sentinelAware((a: unknown, b: unknown) => {
        seen.push(a, b);
        const av = isLoading(a) ? Infinity : (a as number);
        const bv = isLoading(b) ? Infinity : (b as number);
        return av - bv;
      });
      const result = shim('toSorted')(
        [2, pending, 1],
        [cmp],
        applyCall,
      ) as unknown[];
      expect(seen.length).toBeGreaterThan(0);
      expect(result).toEqual([1, 2, pending]);
      expect(shim('toSorted')([2, pending, 1], [], applyCall)).toBe(pending);
    });

    it('[ORACLE keep-pending idiom] an aware predicate that claims pending rows restores the skeleton pipeline', () => {
      const keep = sentinelAware(
        (r: unknown) => isLoading(r) || (r as number) > 1,
      );
      const filtered = shim('filter')(
        [1, pending, 3],
        [keep],
        applyCall,
      ) as unknown[];
      expect(filtered).toEqual([pending, 3]);
      const label = sentinelAware((r: unknown) =>
        isLoading(r) ? 'skeleton' : `row:${r}`,
      );
      expect(shim('map')(filtered, [label], applyCall)).toEqual([
        'skeleton',
        'row:3',
      ]);
    });
  });

  describe('[ORACLE] map results stay transparent elements', () => {
    it('an aware callback returning sentinels produces sentinel elements, not a propagated op', () => {
      const pending = loading();
      const cb = sentinelAware(() => pending);
      const result = shim('map')([1, 2], [cb], applyCall) as unknown[];
      expect(result).toHaveLength(2);
      expect(result[0]).toBe(pending);
    });

    it('flatMap flattens while keeping sentinel elements', () => {
      const pending = loading();
      const cb = sentinelAware((x: unknown) => (isLoading(x) ? x : [x, x]));
      const result = shim('flatMap')(
        [1, pending],
        [cb],
        applyCall,
      ) as unknown[];
      expect(result).toEqual([1, 1, pending]);
    });
  });

  describe('[ASSERTED] JS-faithful behavior when sentinel-free', () => {
    it('decision shims match native semantics including reverse iteration', () => {
      const arr = [1, 2, 3, 2];
      const isTwo = (x: unknown) => x === 2;
      expect(shim('find')(arr, [isTwo], applyCall)).toBe(2);
      expect(shim('findIndex')(arr, [isTwo], applyCall)).toBe(1);
      expect(shim('findLastIndex')(arr, [isTwo], applyCall)).toBe(3);
      expect(shim('some')(arr, [isTwo], applyCall)).toBe(true);
      expect(shim('every')(arr, [isTwo], applyCall)).toBe(false);
      expect(
        shim('find')(arr, [(x: unknown) => x === 9], applyCall),
      ).toBeUndefined();
      expect(shim('findIndex')(arr, [(x: unknown) => x === 9], applyCall)).toBe(
        -1,
      );
    });

    it('reduce works with and without an initial value and throws on empty-no-initial', () => {
      const add = (a: unknown, b: unknown) => (a as number) + (b as number);
      expect(shim('reduce')([1, 2, 3], [add], applyCall)).toBe(6);
      expect(shim('reduce')([1, 2, 3], [add, 10], applyCall)).toBe(16);
      expect(() => shim('reduce')([], [add], applyCall)).toThrow(TypeError);
    });

    it('join and toSorted match native semantics', () => {
      expect(shim('join')(['a', 'b'], [], applyCall)).toBe('a,b');
      expect(shim('join')(['a', 'b'], ['-'], applyCall)).toBe('a-b');
      expect(shim('toSorted')([10, 2, 1], [], applyCall)).toEqual([1, 10, 2]);
      const numeric = (a: unknown, b: unknown) => (a as number) - (b as number);
      expect(shim('toSorted')([10, 2, 1], [numeric], applyCall)).toEqual([
        1, 2, 10,
      ]);
    });
  });

  describe('[ORACLE] callback-taking shims enforce the IsCallable precondition even on an empty receiver', () => {
    const callbackMethods = [
      'map',
      'flatMap',
      'filter',
      'find',
      'findIndex',
      'findLast',
      'findLastIndex',
      'some',
      'every',
      'reduce',
    ];

    it.each(callbackMethods)(
      '%s on an empty receiver with a non-callable callback throws a TypeError, matching native',
      (method) => {
        expect(() => shim(method)([], [5], applyCall)).toThrow(TypeError);
        const native = () =>
          ([] as unknown as Record<string, (...a: unknown[]) => unknown>)[
            method
          ](5);
        expect(native).toThrow(TypeError);
      },
    );

    it.each(callbackMethods)(
      '%s on an empty receiver with a pending callback propagates — pending outranks the structural throw',
      (method) => {
        const pending = loading();
        expect(shim(method)([], [pending], applyCall)).toBe(pending);
      },
    );

    it('toSorted with a defined non-callable comparator throws upfront, matching native ValidateComparator — even on an empty receiver; a pending comparator still outranks the throw', () => {
      expect(() => shim('toSorted')([], [5], applyCall)).toThrow(TypeError);
      expect(() => ([] as unknown[]).toSorted(5 as never)).toThrow(TypeError);
      const pending = loading();
      expect(shim('toSorted')([], [pending], applyCall)).toBe(pending);
    });
  });

  describe('[ORACLE] content-coercing shims propagate before native coercion', () => {
    it('join with a sentinel element propagates instead of throwing the leak trap', () => {
      const pending = loading();
      expect(shim('join')([1, pending], [], applyCall)).toBe(pending);
    });

    it('join with a sentinel separator propagates', () => {
      const pending = loading();
      expect(shim('join')([1, 2], [pending], applyCall)).toBe(pending);
    });

    it('default toSorted with a sentinel element propagates', () => {
      const pending = loading();
      expect(shim('toSorted')([2, pending], [], applyCall)).toBe(pending);
    });

    it('join scans through NESTED arrays — the depth native coercion reaches — instead of leaking', () => {
      const pending = loading();
      expect(shim('join')([[pending]], [','], applyCall)).toBe(pending);
      expect(shim('join')([1, [2, [pending]]], [','], applyCall)).toBe(pending);
    });

    it('default toSorted scans through nested arrays too', () => {
      const pending = loading();
      expect(shim('toSorted')([[1], [pending]], [], applyCall)).toBe(pending);
    });

    it('[BOUNDARY] a sentinel inside a plain OBJECT is absorbed, not propagated — objects stringify as [object Object] without recursing', () => {
      const pending = loading();
      expect(shim('join')([{ a: pending }], [','], applyCall)).toBe(
        '[object Object]',
      );
    });
  });

  describe('[ORACLE search-soundness] indexOf/lastIndexOf/includes walk the receiver, propagating a pending element inside the search range instead of committing a contradictable answer', () => {
    it('a pending element the target could resolve to propagates instead of answering -1/false', () => {
      const pending = loading();
      expect(shim('indexOf')([1, pending], [2], applyCall)).toBe(pending);
      expect(shim('includes')([1, pending], [2], applyCall)).toBe(pending);
      expect(shim('lastIndexOf')([pending, 1], [2], applyCall)).toBe(pending);
    });

    it('a definite match reached before any pending element answers concretely', () => {
      const pending = loading();
      expect(shim('indexOf')([2, pending], [2], applyCall)).toBe(0);
      expect(shim('includes')([2, pending], [2], applyCall)).toBe(true);
      expect(shim('lastIndexOf')([pending, 1], [1], applyCall)).toBe(1);
    });

    it('the backward walk of lastIndexOf hits a pending element before an earlier match, propagating', () => {
      const pending = loading();
      expect(shim('lastIndexOf')([1, pending], [1], applyCall)).toBe(pending);
    });

    it('a pending element OUTSIDE the spec search range cannot change a definite answer', () => {
      const pending = loading();
      expect(shim('indexOf')([pending, 2], [2, 1], applyCall)).toBe(1);
    });

    it('equality is per-method: includes is SameValueZero (NaN matches), indexOf is strict (NaN never matches)', () => {
      const pending = loading();
      expect(shim('includes')([NaN, pending], [NaN], applyCall)).toBe(true);
      expect(shim('indexOf')([NaN], [NaN], applyCall)).toBe(-1);
    });

    it('a pending target or a pending fromIndex propagates before the receiver is walked', () => {
      const pending = loading();
      expect(shim('indexOf')([1, 2], [pending], applyCall)).toBe(pending);
      expect(shim('includes')([1, 2], [pending], applyCall)).toBe(pending);
      expect(shim('indexOf')([1, 2], [2, pending], applyCall)).toBe(pending);
      expect(shim('lastIndexOf')([1, 2], [1, pending], applyCall)).toBe(
        pending,
      );
    });
  });

  describe('[ASSERTED] search fromIndex coercion matches native exactly for weird arguments', () => {
    const cases: ReadonlyArray<[string, readonly unknown[]]> = [
      ['indexOf', [2, undefined]],
      ['indexOf', [1, -1]],
      ['indexOf', [3, NaN]],
      ['indexOf', [1, 5]],
      ['indexOf', [3, '1']],
      ['indexOf', [1, -100]],
      ['indexOf', [3, Infinity]],
      ['indexOf', [1, -Infinity]],
      ['indexOf', [2, 1.9]],
      ['includes', [1, -1]],
      ['includes', [3, NaN]],
      ['includes', [2, '1']],
      ['lastIndexOf', [1, -1]],
      ['lastIndexOf', [1, -5]],
      ['lastIndexOf', [1, undefined]],
      ['lastIndexOf', [3, Infinity]],
      ['lastIndexOf', [1, '0']],
      ['lastIndexOf', [2, 10]],
    ];
    const receiver: readonly unknown[] = [1, 2, 3, 1];
    it.each(cases)('%s(%o) agrees with Array.prototype', (method, args) => {
      const native = (
        receiver as unknown as Record<string, (...a: unknown[]) => unknown>
      )[method](...args);
      expect(shim(method)(receiver, args, applyCall)).toEqual(native);
    });
  });

  describe('[ORACLE invoke-consistency] non-callback method args scan for sentinels', () => {
    it('at with a pending index propagates', () => {
      const pending = loading();
      expect(shim('at')([1, 2], [pending], applyCall)).toBe(pending);
    });

    it('includes of a sentinel propagates rather than answering', () => {
      const pending = loading();
      expect(shim('includes')([1, pending], [pending], applyCall)).toBe(
        pending,
      );
    });

    it('raw shims behave natively when sentinel-free, and flat keeps sentinel elements', () => {
      const pending = loading();
      expect(shim('at')([1, 2], [-1], applyCall)).toBe(2);
      expect(shim('slice')([1, 2, 3], [1], applyCall)).toEqual([2, 3]);
      expect(shim('toReversed')([1, 2], [], applyCall)).toEqual([2, 1]);
      const flat = shim('flat')([[1], pending], [], applyCall) as unknown[];
      expect(flat[0]).toBe(1);
      expect(flat[1]).toBe(pending);
    });

    it('[ORACLE] content-position args stay transparent: concat/with append pending elements', () => {
      const pending = loading();
      const concat = shim('concat')([1], [pending], applyCall) as unknown[];
      expect(concat[0]).toBe(1);
      expect(concat[1]).toBe(pending);
      const withResult = shim('with')(
        [1, 2],
        [0, pending],
        applyCall,
      ) as unknown[];
      expect(withResult[0]).toBe(pending);
      expect(withResult[1]).toBe(2);
      expect(shim('with')([1, 2], [pending, 9], applyCall)).toBe(pending);
      expect(
        isSentinel(shim('toSpliced')([1, 2], [pending, 1], applyCall)),
      ).toBe(true);
    });
  });
});
