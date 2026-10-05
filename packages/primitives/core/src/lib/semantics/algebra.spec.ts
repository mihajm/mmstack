import {
  and,
  coalesce,
  conditional,
  invoke,
  joinAbsorbers,
  member,
  or,
  strictBinary,
  strictUnary,
  type Thunk,
} from './algebra';
import {
  DONE,
  SentinelLeakError,
  ifLoading,
  isDone,
  isSentinel,
  loading,
  sentinelAware,
} from './sentinel';

const uncalled = () => {
  const thunk = vi.fn(() => 'thunk-result');
  return {
    thunk: thunk as Thunk,
    expectUncalled: () => expect(thunk).not.toHaveBeenCalled(),
  };
};

describe('algebra', () => {
  describe('[ORACLE] comparisons propagate, never collapse to false', () => {
    const pending = loading();

    it('propagates through relational operators', () => {
      expect(
        strictBinary(pending, 5, (l, r) => (l as number) < (r as number)),
      ).toBe(pending);
      expect(
        strictBinary(5, pending, (l, r) => (l as number) > (r as number)),
      ).toBe(pending);
    });

    it('propagates through equality including strict and self-comparison', () => {
      // eslint-disable-next-line eqeqeq
      const looseEq = (l: unknown, r: unknown) => l == r;
      expect(strictBinary(pending, null, looseEq)).toBe(pending);
      expect(strictBinary(pending, pending, (l, r) => l === r)).toBe(pending);
    });
  });

  describe('[ORACLE] coercing a pending-bearing container ejects loudly, never silently', () => {
    it('arithmetic on an array holding a sentinel throws the leak trap instead of producing "[object Object]" strings', () => {
      expect(() =>
        strictBinary([loading()], 1, (l, r) => (l as number) + (r as number)),
      ).toThrow(/sentinel leaked/);
    });
  });

  describe('[ORACLE escape-hatch] identity operations do not escape', () => {
    it('LOADING ** 0 propagates the exact instance instead of returning 1', () => {
      const pending = loading();
      expect(
        strictBinary(pending, 0, (l, r) => (l as number) ** (r as number)),
      ).toBe(pending);
    });

    it('LOADING * 0 propagates', () => {
      expect(
        isSentinel(
          strictBinary(loading(), 0, (l, r) => (l as number) * (r as number)),
        ),
      ).toBe(true);
    });
  });

  describe('[ORACLE no-silent-branching] test-position sentinels propagate whole constructs', () => {
    it('conditional with sentinel test returns the sentinel and evaluates neither branch', () => {
      const pending = loading();
      const whenTrue = uncalled();
      const whenFalse = uncalled();
      expect(conditional(pending, whenTrue.thunk, whenFalse.thunk)).toBe(
        pending,
      );
      whenTrue.expectUncalled();
      whenFalse.expectUncalled();
    });

    it('negation of a sentinel propagates instead of producing a boolean', () => {
      const pending = loading();
      expect(strictUnary(pending, (v) => !v)).toBe(pending);
    });
  });

  describe('[ASSERTED dependency-minimality] sentinel-left short-circuits force zero extra evaluation', () => {
    it.each([
      ['and', and],
      ['or', or],
      ['coalesce', coalesce],
    ])('%s with sentinel left never invokes the right thunk', (_, op) => {
      const pending = loading();
      const right = uncalled();
      expect(op(pending, right.thunk)).toBe(pending);
      right.expectUncalled();
    });
  });

  describe('[ASSERTED] JS-faithful value semantics for sentinel-free operands', () => {
    it('logical operators return operands, not booleans', () => {
      const right = uncalled();
      expect(and(0, right.thunk)).toBe(0);
      right.expectUncalled();
      expect(and(1, () => 'r')).toBe('r');
      expect(or('x', right.thunk)).toBe('x');
      right.expectUncalled();
      expect(or('', () => 'fallback')).toBe('fallback');
    });

    it('coalesce is nullish-only: falsy non-nullish flows, sentinel flows', () => {
      const right = uncalled();
      expect(coalesce(0, right.thunk)).toBe(0);
      expect(coalesce('', right.thunk)).toBe('');
      right.expectUncalled();
      expect(coalesce(null, () => 'fb')).toBe('fb');
      expect(coalesce(undefined, () => 'fb')).toBe('fb');
      const pending = loading();
      expect(coalesce(pending, right.thunk)).toBe(pending);
      right.expectUncalled();
    });

    it('conditional branches on truthiness for non-sentinel tests', () => {
      expect(
        conditional(
          0,
          () => 'a',
          () => 'b',
        ),
      ).toBe('b');
      expect(
        conditional(
          'x',
          () => 'a',
          () => 'b',
        ),
      ).toBe('a');
    });
  });

  describe('[ASSERTED] member access', () => {
    it('propagates a sentinel receiver without touching the reader', () => {
      const pending = loading();
      const read = vi.fn();
      expect(member(pending, read)).toBe(pending);
      expect(read).not.toHaveBeenCalled();
    });

    it('does not shield strictness: the reader may throw on nullish receivers', () => {
      expect(() =>
        member(null, (o) => (o as Record<string, unknown>)['a']),
      ).toThrow();
      expect(member({ a: 1 }, (o) => (o as Record<string, unknown>)['a'])).toBe(
        1,
      );
    });

    it('[ORACLE] computed member access routes through strictBinary so sentinel KEYS propagate', () => {
      const computedMember = (object: unknown, key: unknown) =>
        strictBinary(
          object,
          key,
          (o, k) => (o as Record<string, unknown>)[k as string],
        );
      const pendingKey = loading('key');
      expect(computedMember({ a: 1 }, pendingKey)).toBe(pendingKey);
      const pendingObj = loading('obj');
      expect(computedMember(pendingObj, 'a')).toBe(pendingObj);
      expect(computedMember({ a: 1 }, 'a')).toBe(1);
    });
  });

  describe('[ASSERTED] invocation', () => {
    it('propagates a sentinel callee without invoking', () => {
      const pending = loading();
      const apply = vi.fn();
      expect(invoke(pending, [1], apply)).toBe(pending);
      expect(apply).not.toHaveBeenCalled();
    });

    it('propagates the leftmost sentinel argument for unaware callees', () => {
      const a = loading('a');
      const b = loading('b');
      const apply = vi.fn();
      expect(invoke(Math.max, [1, a, b], apply)).toBe(a);
      expect(apply).not.toHaveBeenCalled();
    });

    it('sentinel-aware callees receive sentinels raw', () => {
      const pending = loading();
      const probe = sentinelAware((value: unknown) => isSentinel(value));
      const result = invoke(probe, [pending], (target, args) =>
        (target as (v: unknown) => boolean)(args[0]),
      );
      expect(result).toBe(true);
    });

    it('invokes unaware callees normally when no argument is a sentinel', () => {
      const result = invoke(Math.max, [1, 2], (target, args) =>
        (target as (...n: number[]) => number)(...(args as number[])),
      );
      expect(result).toBe(2);
    });

    it('propagates a sentinel in first-argument position', () => {
      const pending = loading();
      const apply = vi.fn();
      expect(invoke(Math.max, [pending, 1], apply)).toBe(pending);
      expect(apply).not.toHaveBeenCalled();
    });

    it('a sentinel callee takes precedence over sentinel arguments', () => {
      const callee = loading('callee');
      const arg = loading('arg');
      expect(invoke(callee, [arg], vi.fn())).toBe(callee);
    });

    it('primitive callees are unaware: sentinel args propagate instead of throwing here', () => {
      const pending = loading();
      const apply = vi.fn();
      expect(invoke(42, [pending], apply)).toBe(pending);
      expect(apply).not.toHaveBeenCalled();
    });
  });

  describe('[ASSERTED] provenance is observational: leftmost instance wins, payload never branches', () => {
    it('binary propagation returns the exact left instance', () => {
      const a = loading({ connector: 'users' });
      const b = loading({ connector: 'orders' });
      expect(strictBinary(a, b, () => 0)).toBe(a);
      expect(strictBinary(b, a, () => 0)).toBe(b);
    });

    it('joinAbsorbers over a single kind returns the leftmost, ignoring non-sentinels (loading-invariance)', () => {
      const a = loading('a');
      expect(joinAbsorbers([1, 'x', a, loading('b')])).toBe(a);
      expect(joinAbsorbers([1, 'x', null])).toBeUndefined();
    });

    it('joinAbsorbers finds a sentinel at index 0', () => {
      const a = loading('a');
      expect(joinAbsorbers([a, 1])).toBe(a);
      expect(joinAbsorbers([a])).toBe(a);
    });
  });

  describe('[ORACLE done-not-absorbed] absorption is strictly loading — DONE flows inert and goes loud at coercion boundaries, never silently propagates', () => {
    it('strictBinary applies over DONE instead of propagating; the coercion inside throws the leak trap (loud, not silent)', () => {
      expect(() =>
        strictBinary(DONE, 1, (l, r) => (l as number) + (r as number)),
      ).toThrow(SentinelLeakError);
    });

    it('invoke with DONE among the args does NOT propagate — the callee is applied', () => {
      const target = () => 'applied';
      const result = invoke(target, [DONE], (fn, args) =>
        (fn as (...a: unknown[]) => unknown)(...args),
      );
      expect(result).toBe('applied');
    });

    it('the settlement readers still work: isDone(DONE) is true and ifLoading(DONE, fallback) returns DONE unabsorbed', () => {
      expect(isDone(DONE)).toBe(true);
      expect(ifLoading(DONE, 'fallback')).toBe(DONE);
    });

    it('member applies the read over DONE (`DONE?.x` shape): reading a property off the frozen sentinel yields undefined without throwing', () => {
      const read = (o: unknown) =>
        (o as Record<string, unknown> | null | undefined)?.['x'];
      expect(member(DONE, read)).toBeUndefined();
    });
  });

  describe('[ORACLE kleene-kill, pinned counterexample] value-level Kleene logicals violate resolution soundness (production ops are killed by dependency-minimality + the soundness property)', () => {
    it('a Kleene OR commits to the right operand while resolutions disagree', () => {
      const kleeneOr = (left: unknown, right: Thunk): unknown => {
        if (!isSentinel(left)) return left ? left : right();
        const r = right();
        return r ? r : left;
      };
      const pending = loading();
      const committed = kleeneOr(pending, () => 'fallback');
      expect(committed).toBe('fallback');
      const resolveTo = (resolution: unknown) =>
        resolution ? resolution : 'fallback';
      expect(resolveTo(false)).toBe('fallback');
      expect(resolveTo('hello')).toBe('hello');
      expect(resolveTo('hello')).not.toBe(committed);
    });
  });
});
