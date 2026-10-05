import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  ARRAY_METHOD_SHIMS,
  invoke,
  joinAbsorbersDeep,
  strictBinary,
  type ApplyFn,
} from '@mmstack/primitives/algebra';
import { ABSORBER_PRECEDENCE, joinAbsorbers } from './algebra';
import {
  type Absorbing,
  DONE,
  type ErrorMintReport,
  error,
  errorConstant,
  errorEdge,
  ifError,
  ifLoading,
  isAbsorbing,
  loading,
  setErrorReporter,
} from './sentinel';

const applyCall: ApplyFn = (target, args) =>
  (target as (...a: unknown[]) => unknown)(...args);

/**
 * The manifest spec of the join, transcribed as simply as possible so it is obviously correct:
 * pending (the `loading` kind) outranks error outranks value, leftmost within the winning kind.
 * `joinAbsorbers` is the optimized fold; a differential against this dead-simple scan proves the
 * fold, and neutering the fold to first-found breaks the precedence rows below.
 */
function expectedJoin(operands: readonly unknown[]): Absorbing | undefined {
  const firstOfKind = (kind: string) =>
    operands.find((o) => isAbsorbing(o) && o.kind === kind) as
      Absorbing | undefined;
  return firstOfKind('loading') ?? firstOfKind('error');
}

type Operand = { tag: 'value' | 'loading' | 'error'; v: unknown };
const operandArb: fc.Arbitrary<Operand> = fc.oneof(
  fc
    .constantFrom<unknown>(0, 1, 'x', null, true, undefined)
    .map((v) => ({ tag: 'value' as const, v })),
  fc.string().map((s) => ({ tag: 'loading' as const, v: loading(s) })),
  fc.string().map((s) => ({ tag: 'error' as const, v: error(s) })),
);
const operandsArb = fc
  .array(operandArb, { maxLength: 6 })
  .map((os) => os.map((o) => o.v));

describe('error join algebra — precedence, provenance, composition', () => {
  it('[PIN precedence] ABSORBER_PRECEDENCE is exactly [error, loading] — value < error < pending; this order is SETTLED, a change is a deliberate flip requiring this witness edit', () => {
    expect([...ABSORBER_PRECEDENCE]).toEqual(['error', 'loading']);
  });

  it('[PROVEN differential] joinAbsorbers equals the manifest precedence scan on every operand set', () => {
    fc.assert(
      fc.property(operandsArb, (ops) => {
        expect(joinAbsorbers(ops)).toBe(expectedJoin(ops));
      }),
    );
  });

  it('[PROVEN one-operation] the join is associative under any split — nesting per-site joins equals one operation-wide join (this is what makes the collision-site sweep compose)', () => {
    fc.assert(
      fc.property(operandsArb, fc.nat(6), (ops, rawK) => {
        const k = Math.min(rawK, ops.length);
        const nested = joinAbsorbers([
          joinAbsorbers(ops.slice(0, k)),
          ...ops.slice(k),
        ]);
        expect(nested).toBe(joinAbsorbers(ops));
      }),
    );
  });

  it('[ORACLE loading-invariance] joinAbsorbers ≡ first-found on single-kind inputs — the pre-ranked-join regression guarantee', () => {
    const singleKindArb = fc.oneof(
      fc.array(
        fc.string().map((s) => loading(s)),
        { maxLength: 6 },
      ),
      fc.array(
        fc.string().map((s) => error(s)),
        { maxLength: 6 },
      ),
    );
    const withNoise = (abs: readonly unknown[]) => abs;
    fc.assert(
      fc.property(singleKindArb, (abs) => {
        const firstFound = withNoise(abs).find(isAbsorbing);
        expect(joinAbsorbers(abs)).toBe(firstFound);
      }),
    );
  });

  it('[PROVEN kind laws] a pending anywhere ⇒ result is loading; an error with no pending ⇒ result is error; no absorber ⇒ undefined', () => {
    fc.assert(
      fc.property(operandsArb, (ops) => {
        const hasLoading = ops.some(
          (o) => isAbsorbing(o) && o.kind === 'loading',
        );
        const hasError = ops.some((o) => isAbsorbing(o) && o.kind === 'error');
        const result = joinAbsorbers(ops);
        if (hasLoading) expect(result?.kind).toBe('loading');
        else if (hasError) expect(result?.kind).toBe('error');
        else expect(result).toBeUndefined();
      }),
    );
  });

  it('[ASSERTED precedence] commits the leftmost among the winning kind; pending outranks error; mid-flight winning error is not pinned', () => {
    const l1 = loading('l1');
    const l2 = loading('l2');
    const e1 = error('e1');
    const e2 = error('e2');
    expect(joinAbsorbers([e1, l1])).toBe(l1);
    expect(joinAbsorbers([l1, e1])).toBe(l1);
    expect(joinAbsorbers([l1, l2])).toBe(l1);
    expect(joinAbsorbers([e1, e2])).toBe(e1);
    expect(joinAbsorbers([e1, l1, e2, l2])).toBe(l1);
  });

  it('[deep join] joinAbsorbersDeep ranks across nested arrays — a deeper pending outranks a shallower error', () => {
    const e = error('e');
    const l = loading('l');
    expect(joinAbsorbersDeep([e, [l]])).toBe(l);
    expect(joinAbsorbersDeep([[e], 1])).toBe(e);
    expect(joinAbsorbersDeep([1, [2, [3]]])).toBeUndefined();
  });

  it('[regression] DONE stays non-absorbing beside error — the join skips it', () => {
    expect(isAbsorbing(DONE)).toBe(false);
    const e = error('e');
    expect(joinAbsorbers([DONE, e])).toBe(e);
    expect(joinAbsorbers([DONE])).toBeUndefined();
  });
});

describe('error precedence through the strict sites', () => {
  it('strictBinary joins by precedence, leftmost within kind', () => {
    const e = error('e');
    const l = loading('l');
    expect(strictBinary(e, l, () => 0)).toBe(l);
    expect(strictBinary(l, e, () => 0)).toBe(l);
    expect(strictBinary(e, error('e2'), () => 0)).toBe(e);
    expect(strictBinary(e, 1, () => 0)).toBe(e);
    expect(strictBinary(1, 2, (a, b) => (a as number) + (b as number))).toBe(3);
  });

  it('invoke joins callee + args before the not-callable check; a pending arg outranks an error callee or arg', () => {
    const e = error('e');
    const l = loading('l');
    const unaware = (...a: unknown[]) => a;
    expect(invoke(unaware, [e, l], applyCall)).toBe(l);
    expect(invoke(e, [l], applyCall)).toBe(l);
    expect(invoke(e, ['x'], applyCall)).toBe(e);
    expect(invoke(undefined, [l], applyCall)).toBe(l);
  });
});

describe('[ORACLE container-laws] element transparency vs no-laundering', () => {
  it('`.at` commits a value cell beside an error cell (the errored index never participates)', () => {
    const e = error('cell');
    expect(ARRAY_METHOD_SHIMS['at']([1, e], [0], applyCall)).toBe(1);
    expect(ARRAY_METHOD_SHIMS['at']([e, 1], [1], applyCall)).toBe(1);
  });

  it('`.indexOf` PROPAGATES an error cell reached in the search range — NOT derivable from pending-resolution reasoning: a settled error can never become the target, yet answering would launder "we could not compute this cell" into "the value is not there"', () => {
    const e = error('cell');
    expect(ARRAY_METHOD_SHIMS['indexOf']([e, 1], [1], applyCall)).toBe(e);
    expect(ARRAY_METHOD_SHIMS['indexOf']([1, e], [1], applyCall)).toBe(0);
  });

  it('`.map` keeps an error cell in place under an unaware callback (element transparency, identical to loading)', () => {
    const e = error('cell');
    const out = ARRAY_METHOD_SHIMS['map'](
      [1, e, 3],
      [(x: unknown) => x],
      applyCall,
    ) as unknown[];
    expect(out[0]).toBe(1);
    expect(out[1]).toBe(e);
    expect(out[2]).toBe(3);
  });
});

describe('[aware-law] explicit-fallback resolves by the helper, not the generic join', () => {
  it('ifError replaces ONLY errors; ifLoading replaces ONLY loading; both pass the other kind through', () => {
    const e = error('e');
    const l = loading('l');
    expect(ifError(e, 'fb')).toBe('fb');
    expect(ifError(l, 'fb')).toBe(l);
    expect(ifError(5, 'fb')).toBe(5);
    expect(ifLoading(l, 'fb')).toBe('fb');
    expect(ifLoading(e, 'fb')).toBe(e);
  });

  it('error-in-both-positions resolves by the explicit fallback, never the generic join', () => {
    const e = error('e');
    const l = loading('l');
    expect(ifError(e, l)).toBe(l);
    expect(ifLoading(l, e)).toBe(e);
  });

  it('an aware helper called through invoke receives its absorbing argument RAW (not pre-absorbed)', () => {
    const e = error('e');
    expect(invoke(ifError, [e, 'fb'], applyCall)).toBe('fb');
  });
});

describe('[ASSERTED telemetry] error telemetry seam — value-free sentinel, reported once at mint', () => {
  it('reports once with {origin, subclass, cause}; the cause never lives on the value; ifError absorption never re-reports or retracts', () => {
    const reports: ErrorMintReport[] = [];
    setErrorReporter((r) => reports.push(r));
    try {
      const e = error('boom');
      expect(reports).toEqual([
        { origin: 'authored', subclass: 'author-fault', cause: 'boom' },
      ]);
      expect(Object.prototype.hasOwnProperty.call(e, 'cause')).toBe(false);
      expect((e as unknown as { cause?: unknown }).cause).toBeUndefined();
      expect(ifError(e, 'fb')).toBe('fb');
      expect(reports.length).toBe(1);
    } finally {
      setErrorReporter(undefined);
    }
  });

  it('errorEdge mints an edge-origin fault as external-fault (never inherits author-fault): value-free, reported once, generic presentation', () => {
    const reports: ErrorMintReport[] = [];
    setErrorReporter((r) => reports.push(r));
    try {
      const e = errorEdge('timeout');
      expect(reports).toEqual([
        { origin: 'edge', subclass: 'external-fault', cause: 'timeout' },
      ]);
      expect(e.origin).toBe('edge');
      expect(e.renderableMessage).toBeUndefined();
      expect((e as unknown as { cause?: unknown }).cause).toBeUndefined();
      expect(ifError(e, 'fb')).toBe('fb');
      expect(reports.length).toBe(1);
    } finally {
      setErrorReporter(undefined);
    }
  });

  it('renderableMessage is set ONLY by errorConstant (a definition-plane constant); error() leaves it unset (dynamic → generic presentation)', () => {
    expect(error('dyn').renderableMessage).toBeUndefined();
    expect(errorConstant('static').renderableMessage).toBe('static');
    expect(error().origin).toBe('authored');
    expect(error('x', 'evaluation').origin).toBe('evaluation');
  });
});
