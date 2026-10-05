import fc from 'fast-check';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  ARRAY_METHOD_SHIMS,
  conditional,
  invoke,
  strictBinary,
  type ApplyFn,
} from '@mmstack/primitives/algebra';
import {
  type ErrorSentinel,
  type Loading,
  error,
  ifError,
  ifLoading,
  isAbsorbing,
  loading,
  setStrictSentinels,
} from './sentinel';

// Strict sentinels: these rows pin the throwing leak guards an evaluator is proven against.
beforeEach(() => setStrictSentinels(true));
afterEach(() => setStrictSentinels(false));

/**
 * Error CONTAINMENT, compositional (five-class partition + swap-congruence): an
 * abstract error token survives every strict context with identity/origin preserved unless a named
 * aware law eliminates it, and NOTHING in the algebra branches on the value-free payload. We compose
 * the REAL algebra sites into random nested trees and run each with TWO distinct error-identity
 * assignments. The results must be congruent up to that swap — proving no site inspected a payload
 * an error does not carry, and no site fabricated an error identity the inputs did not supply.
 */

const applyCall: ApplyFn = (target, args) =>
  (target as (...a: unknown[]) => unknown)(...args);
const combine = (...parts: unknown[]) => ({ combined: parts });
const IDENTITY_FN = (...args: unknown[]) => ({ called: args });

type C =
  | { t: 'lit'; v: unknown }
  | { t: 'fn' }
  | { t: 'pending' }
  | { t: 'err'; id: 0 | 1 }
  | { t: 'bin'; l: C; r: C }
  | { t: 'call'; fn: C; args: readonly C[] }
  | { t: 'cond'; c: C; a: C; b: C }
  | { t: 'ifError'; x: C; fb: C }
  | { t: 'ifLoading'; x: C; fb: C }
  | { t: 'arr'; els: readonly C[] }
  | { t: 'at'; els: readonly C[]; i: number }
  | { t: 'indexOf'; els: readonly C[]; target: C };

function run(e: C, pending: Loading, errs: readonly ErrorSentinel[]): unknown {
  const ev = (x: C) => run(x, pending, errs);
  switch (e.t) {
    case 'lit':
      return e.v;
    case 'fn':
      return IDENTITY_FN;
    case 'pending':
      return pending;
    case 'err':
      return errs[e.id];
    case 'bin':
      return strictBinary(ev(e.l), ev(e.r), combine);
    case 'call':
      return invoke(ev(e.fn), e.args.map(ev), applyCall);
    case 'cond':
      return conditional(
        ev(e.c),
        () => ev(e.a),
        () => ev(e.b),
      );
    case 'ifError':
      return invoke(ifError, [ev(e.x), ev(e.fb)], applyCall);
    case 'ifLoading':
      return invoke(ifLoading, [ev(e.x), ev(e.fb)], applyCall);
    case 'arr':
      return e.els.map(ev);
    case 'at':
      return ARRAY_METHOD_SHIMS['at'](e.els.map(ev), [e.i], applyCall);
    case 'indexOf':
      return ARRAY_METHOD_SHIMS['indexOf'](
        e.els.map(ev),
        [ev(e.target)],
        applyCall,
      );
  }
}

/**
 * Replace each provided sentinel identity with a stable positional token, so two runs that differ
 * ONLY in which error identities were supplied canonicalize to the same structure iff nothing
 * branched on the payload. A `#other-absorber` token would flag a fabricated/foreign sentinel.
 */
function canon(
  v: unknown,
  pending: Loading,
  errs: readonly ErrorSentinel[],
): unknown {
  if (v === pending) return '#pending';
  const ei = errs.indexOf(v as ErrorSentinel);
  if (ei >= 0) return `#err${ei}`;
  if (isAbsorbing(v)) return '#other-absorber';
  if (Array.isArray(v)) return v.map((x) => canon(x, pending, errs));
  if (v && typeof v === 'object') {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(v as Record<string, unknown>)) {
      out[k] = canon((v as Record<string, unknown>)[k], pending, errs);
    }
    return out;
  }
  return typeof v === 'function' ? '#fn' : v;
}

type Outcome = { kind: 'value'; canon: unknown } | { kind: 'throw' };
function outcome(
  e: C,
  pending: Loading,
  errs: readonly ErrorSentinel[],
): Outcome {
  try {
    return {
      kind: 'value',
      canon: canon(run(e, pending, errs), pending, errs),
    };
  } catch {
    return { kind: 'throw' };
  }
}

const leafArb: fc.Arbitrary<C> = fc.oneof(
  fc
    .constantFrom<unknown>(0, 1, 'x', null, true)
    .map<C>((v) => ({ t: 'lit', v })),
  fc.constant<C>({ t: 'fn' }),
  fc.constant<C>({ t: 'pending' }),
  fc.constantFrom<C>({ t: 'err', id: 0 }, { t: 'err', id: 1 }),
);

const exprArb: fc.Arbitrary<C> = fc.letrec<{ expr: C }>((tie) => {
  const sub = tie('expr');
  const els = fc.array(sub, { maxLength: 3 });
  return {
    expr: fc.oneof(
      { depthSize: 'small', withCrossShrink: true },
      leafArb,
      leafArb,
      fc.tuple(sub, sub).map<C>(([l, r]) => ({ t: 'bin', l, r })),
      fc.tuple(sub, els).map<C>(([fn, args]) => ({ t: 'call', fn, args })),
      fc.tuple(sub, sub, sub).map<C>(([c, a, b]) => ({ t: 'cond', c, a, b })),
      fc.tuple(sub, sub).map<C>(([x, fb]) => ({ t: 'ifError', x, fb })),
      fc.tuple(sub, sub).map<C>(([x, fb]) => ({ t: 'ifLoading', x, fb })),
      els.map<C>((e) => ({ t: 'arr', els: e })),
      fc
        .tuple(els, fc.integer({ min: -2, max: 3 }))
        .map<C>(([e, i]) => ({ t: 'at', els: e, i })),
      fc
        .tuple(els, sub)
        .map<C>(([e, target]) => ({ t: 'indexOf', els: e, target })),
    ),
  };
}).expr;

describe('[PROVEN containment] error-identity-swap congruence over composed algebra sites', () => {
  it('two runs differing only in which error identities were supplied are congruent up to that swap — nothing branches on the value-free payload, no identity is fabricated', () => {
    fc.assert(
      fc.property(exprArb, (e) => {
        const pending = loading('p');
        const errsA = [error('a0'), error('a1')] as const;
        const errsB = [error('b0'), error('b1')] as const;
        const a = outcome(e, pending, errsA);
        const b = outcome(e, pending, errsB);
        expect(a.kind).toBe(b.kind);
        if (a.kind === 'value' && b.kind === 'value') {
          expect(a.canon).toEqual(b.canon);
        }
      }),
      { numRuns: 2000 },
    );
  });

  it('no result ever contains a foreign or fabricated absorber — every surfacing absorber is a supplied identity (class partition: only VALUE/PENDING/ERROR/SETTLED-CONTAINED, or a THROW)', () => {
    const hasForeign = (c: unknown): boolean =>
      c === '#other-absorber' ||
      (Array.isArray(c) && c.some(hasForeign)) ||
      (!!c &&
        typeof c === 'object' &&
        Object.values(c as Record<string, unknown>).some(hasForeign));
    fc.assert(
      fc.property(exprArb, (e) => {
        const pending = loading('p');
        const errs = [error('e0'), error('e1')] as const;
        const o = outcome(e, pending, errs);
        if (o.kind === 'value') expect(hasForeign(o.canon)).toBe(false);
      }),
      { numRuns: 2000 },
    );
  });
});
