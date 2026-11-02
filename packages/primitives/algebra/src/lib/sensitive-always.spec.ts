import fc from 'fast-check';
import {
  alwaysSensitive,
  error,
  type ErrorMintReport,
  isAlwaysSensitive,
  isError,
  isLoading,
  isSentinel,
  loading,
  sensitive,
  sensitiveEqual,
  sentinelAware,
  setErrorReporter,
  setSensitiveMode,
  setStrictSentinels,
  unbox,
  unboxAll,
} from '@mmstack/primitives/core';
import {
  normalize,
  type Report,
  runReal,
} from '../../../core/src/lib/semantics/testing/sensitive-adapter';
import {
  type Expr,
  exprArb,
  N_SRC,
  type Plain,
  sourceArb,
  type SourceSpec,
  sourcesArb,
  valueArb,
} from '../../../core/src/lib/semantics/testing/sensitive-language';
import {
  and,
  conditional,
  invoke,
  member,
  strictBinary,
  strictUnary,
} from './algebra';
import { ARRAY_METHOD_SHIMS, spreadArray, type ApplyFn } from './containers';
import { isLabeled, levelOf, unlabel } from './sensitive';

// The always-sensitive class: one bit beside the label. A value declared `alwaysSensitive` is
// labeled exactly as `sensitive` labels it, and every hook and container shim that labels a result
// over an always-sensitive operand labels it always sensitive too, so a reader that clears
// ordinary labels can still refuse a credential and everything derived from it.
//
// Law (stated over the model's program generator and sources, re-pointed at the real hooks):
// - A1 erasure of the bit: declaring sources always sensitive changes no value, no report and no
//   label position; only the class of labels.
// - A2 exactness: with the sources at a mask declared always sensitive and the rest ordinary, a
//   position (through boxes, arrays and records) carries an always label exactly where it is
//   labeled when only the masked sources are declared sensitive at all. Soundness: a derivation
//   that read an always operand is always sensitive (monotone under every hook and shim). Precision:
//   one that read only ordinary labels is not. The same holds for every sensitive report's cause.
// - A3 mode off: zero allocation, the identity (pinned in the core spec and below).
// A1 and A2 run twice: over the general generator, and over focused generators that build what it
// rarely does (an ordinary box over nested always labels; map/filter/find/some/every with an always
// element or an always verdict over a public array).

const call: ApplyFn = (target, args) =>
  (target as (...a: unknown[]) => unknown)(...args);
const shim = (name: string) => ARRAY_METHOD_SHIMS[name];
const TOKEN = 'tok_5f0c9a1e7d3b';

const ENV =
  (globalThis as { process?: { env: Record<string, string | undefined> } })
    .process?.env ?? {};
const RUNS = Number(ENV['SENSITIVE_DIFF_RUNS'] ?? 400);
const TIMEOUT = 120_000;

let reports: ErrorMintReport[];

beforeEach(() => {
  reports = [];
  setErrorReporter((r) => reports.push(r));
  setStrictSentinels(true);
});

afterEach(() => {
  setErrorReporter(undefined);
  setSensitiveMode(false);
  setStrictSentinels(false);
});

const always = (v: unknown): boolean => levelOf(v) === 2;

/** Every labeled node through boxes, arrays and records, by its path (box layers are not steps). */
function labelPaths(value: unknown, alwaysOnly: boolean): string[] {
  const out: string[] = [];
  const seen = new Set<object>();
  const visit = (v: unknown, path: string): void => {
    if (typeof v !== 'object' || v === null) return;
    if (isLabeled(v) && (!alwaysOnly || always(v))) out.push(path);
    const inner = unlabel(v);
    if (typeof inner !== 'object' || inner === null || isSentinel(inner))
      return;
    if (seen.has(inner)) return;
    seen.add(inner);
    if (Array.isArray(inner)) inner.forEach((x, i) => visit(x, `${path}/${i}`));
    else if (Object.getPrototypeOf(inner) === Object.prototype)
      for (const [k, x] of Object.entries(inner)) visit(x, `${path}.${k}`);
  };
  visit(value, '');
  return out.sort();
}

/** The masked sources keep their declaration; every other source is declared nothing. */
const only = (specs: readonly SourceSpec[], mask: readonly boolean[]) =>
  specs.map((s, i): SourceSpec => {
    if (mask[i]) return s;
    return s.kind === 'value'
      ? { ...s, sens: 'none' }
      : s.kind === 'error'
        ? { ...s, sens: false }
        : s;
  });

const maskArb = fc.array(fc.boolean(), {
  minLength: N_SRC,
  maxLength: N_SRC,
});

const observe = (raw: unknown, rs: readonly Report[]) => ({
  all: labelPaths(raw, false),
  always: labelPaths(raw, true),
  reportsAlways: rs.map((r) => r.sensitive && always(r.cause)),
  reportsSensitive: rs.map((r) => r.sensitive),
  value: normalize(unboxAll(raw)),
  isAlways: isAlwaysSensitive(raw),
});

/**
 * A1 and A2 for one program. `nest` wraps the per-field view of a source in an ordinary box in the
 * mixed and ordinary runs; the always sources alone keep only their fields (no outer box).
 */
function checkLaw(
  tree: Expr,
  specs: readonly SourceSpec[],
  mask: readonly boolean[],
  nest: readonly boolean[] = [],
) {
  const mixed = runReal(tree, specs, true, observe, mask, nest).observed!;
  const ordinary = runReal(tree, specs, true, observe, false, nest).observed!;
  const alone = runReal(tree, only(specs, mask), true, observe).observed!;
  // A1: the class is erased by every reader but the bit itself.
  expect(mixed.value).toEqual(ordinary.value);
  expect(mixed.all).toEqual(ordinary.all);
  expect(mixed.reportsSensitive).toEqual(ordinary.reportsSensitive);
  expect(ordinary.always).toEqual([]);
  // A2: exactly where the always sources alone label.
  expect(mixed.always).toEqual(alone.all);
  expect(mixed.reportsAlways).toEqual(alone.reportsSensitive);
  expect(mixed.isAlways).toBe(alone.all.length > 0);
  return mixed;
}

// Focused generators. Sources: lists and records of primitives declared per field or whole, beside
// the general source generator. Programs: decisions over a public array literal (elements may be
// sources, so an element can be always sensitive) or a source, with verdict bodies that read a
// source; and direct uses of a source at every depth the hooks scan (coercion, join, sort, calls,
// computed reads, slice, search, member reads).
const primArb = fc.constantFrom<Plain>(0, 1, 2, 'a', 'b', '', true, null);
const focusSourceArb: fc.Arbitrary<SourceSpec> = fc.oneof(
  sourceArb,
  fc.record({
    kind: fc.constant('value' as const),
    v: fc.oneof(
      fc.array(primArb, { minLength: 1, maxLength: 3 }) as fc.Arbitrary<Plain>,
      fc.record(
        { a: primArb, b: primArb },
        { noNullPrototype: true },
      ) as fc.Arbitrary<Plain>,
    ),
    sens: fc.constantFrom(
      'fields' as const,
      'fields' as const,
      'whole' as const,
    ),
  }),
);
const focusSourcesArb = fc.array(focusSourceArb, {
  minLength: N_SRC,
  maxLength: N_SRC,
});
const nestArb = fc.array(fc.boolean(), { minLength: N_SRC, maxLength: N_SRC });

const srcE = fc
  .integer({ min: 0, max: N_SRC - 1 })
  .map((i): Expr => ({ t: 'src', i }));
const litE = primArb.map((v): Expr => ({ t: 'lit', v }));
const param: Expr = { t: 'param' };
const elementE = fc.oneof(
  srcE,
  litE,
  srcE.map((o): Expr => ({ t: 'mem', o, k: 0 })),
  srcE.map((o): Expr => ({ t: 'mem', o, k: 'a' })),
);
const publicArrayE = fc
  .array(elementE, { minLength: 1, maxLength: 3 })
  .map((es): Expr => ({ t: 'arr', es }));
const verdictE: fc.Arbitrary<Expr> = fc.oneof(
  fc.constant(param),
  fc.record({
    t: fc.constant('bin' as const),
    op: fc.constantFrom('===' as const, '<' as const, '+' as const),
    a: fc.constant(param),
    b: fc.oneof(srcE, litE),
  }),
  fc.record({
    t: fc.constant('cond' as const),
    c: srcE,
    a: fc.constant(param),
    b: litE,
  }),
  fc.record({
    t: fc.constantFrom('and' as const, 'or' as const),
    a: srcE,
    b: fc.constant(param),
  }),
  fc.record({
    t: fc.constant('un' as const),
    op: fc.constant('!' as const),
    a: fc.constant(param),
  }),
);
const decisionE: fc.Arbitrary<Expr> = fc.record({
  t: fc.constantFrom(
    'map' as const,
    'filter' as const,
    'find' as const,
    'some' as const,
    'every' as const,
  ),
  a: fc.oneof(publicArrayE, srcE),
  body: verdictE,
});
const nestedUseE: fc.Arbitrary<Expr> = fc.oneof(
  srcE.map((a): Expr => ({ t: 'bin', op: '+', a, b: { t: 'lit', v: '' } })),
  srcE.map((a): Expr => ({ t: 'join', a, sep: { t: 'lit', v: '-' } })),
  srcE.map((a): Expr => ({ t: 'sort', a, by: 'default' })),
  srcE.map((a): Expr => ({ t: 'call', fn: 'first', args: [a] })),
  srcE.map((a): Expr => ({ t: 'call', fn: 'id', args: [a] })),
  srcE.map((o): Expr => ({ t: 'key', o, k: { t: 'lit', v: 0 } })),
  srcE.map((a): Expr => ({ t: 'slice', a, s: { t: 'lit', v: 1 } })),
  fc.tuple(srcE, litE).map(([a, x]): Expr => ({ t: 'includes', a, x })),
  fc
    .tuple(srcE, fc.constantFrom<0 | 'a' | 'length'>(0, 'a', 'length'))
    .map(([o, k]): Expr => ({ t: 'mem', o, k })),
  fc.tuple(srcE, srcE).map(([a, b]): Expr => ({ t: 'spread', a, b })),
);
const focusExprArb: fc.Arbitrary<Expr> = fc.oneof(
  { weight: 1, arbitrary: exprArb },
  { weight: 3, arbitrary: decisionE },
  { weight: 3, arbitrary: nestedUseE },
  {
    weight: 1,
    arbitrary: fc
      .tuple(decisionE, nestedUseE)
      .map(([a, b]): Expr => ({ t: 'arr', es: [a, b] })),
  },
);

describe('always-sensitive class: the law over the model generator', () => {
  it(
    '[PROVEN] A1 + A2: the bit changes no value, report or label, and sits exactly where the always sources alone label',
    () => {
      const seen = { always: 0, ordinaryOnly: 0, mixed: 0 };
      fc.assert(
        fc.property(exprArb, sourcesArb, maskArb, (tree, specs, mask) => {
          const mixed = checkLaw(tree, specs, mask);
          if (mixed.always.length > 0) seen.always++;
          if (mixed.all.length > mixed.always.length) seen.ordinaryOnly++;
          // Both classes declared and the result labeled: the case precision is about.
          const declared = specs.filter((s) => s.kind !== 'pending' && s.sens);
          const classes = new Set(
            specs.flatMap((s, i) =>
              s.kind !== 'pending' && s.sens && s.sens !== 'none'
                ? [mask[i]]
                : [],
            ),
          );
          if (declared.length > 1 && classes.size === 2 && mixed.all.length > 0)
            seen.mixed++;
        }),
        { numRuns: RUNS },
      );
      if (ENV['SENSITIVE_DIFF_STATS']) console.info('always', RUNS, seen);
      expect(seen.always).toBeGreaterThan(RUNS / 10);
      expect(seen.ordinaryOnly).toBeGreaterThan(RUNS / 10);
      expect(seen.mixed).toBeGreaterThan(RUNS / 20);
    },
    TIMEOUT,
  );

  it(
    '[PROVEN] A1 + A2 over the focused generators: nested always labels under ordinary boxes, decisions with always elements and verdicts',
    () => {
      const seen = { nested: 0, decision: 0, verdict: 0 };
      fc.assert(
        fc.property(
          focusExprArb,
          focusSourcesArb,
          maskArb,
          nestArb,
          (tree, specs, mask, nest) => {
            const mixed = checkLaw(tree, specs, mask, nest);
            if (mixed.always.length === 0) return;
            const nested = specs.some(
              (s, i) =>
                nest[i] &&
                mask[i] &&
                s.kind === 'value' &&
                s.sens === 'fields' &&
                typeof s.v === 'object' &&
                s.v !== null,
            );
            if (nested) seen.nested++;
            const decides = ['map', 'filter', 'find', 'some', 'every'];
            if (decides.includes(tree.t)) {
              seen.decision++;
              if ('a' in tree && tree.a.t === 'arr') seen.verdict++;
            }
          },
        ),
        { numRuns: RUNS },
      );
      if (ENV['SENSITIVE_DIFF_STATS']) console.info('focused', RUNS, seen);
      expect(seen.nested).toBeGreaterThan(RUNS / 20);
      expect(seen.decision).toBeGreaterThan(RUNS / 20);
      expect(seen.verdict).toBeGreaterThan(RUNS / 40);
    },
    TIMEOUT,
  );

  it(
    '[PROVEN] A3: mode off, the declaration is the identity and registers nothing; programs compute the plain result',
    () => {
      const registered = () =>
        (
          globalThis as unknown as Record<
            symbol,
            { counters: { registered: number } }
          >
        )[Symbol.for('@mmstack/primitives.sensitive')].counters.registered;
      fc.assert(
        fc.property(valueArb, (v) => {
          setSensitiveMode(false);
          const before = registered();
          expect(alwaysSensitive(v)).toBe(v);
          expect(registered()).toBe(before);
        }),
        { numRuns: RUNS },
      );
      fc.assert(
        fc.property(exprArb, sourcesArb, (tree, specs) => {
          const off = runReal(tree, specs, false, undefined, true);
          expect(off.registered).toBe(0);
          expect(off.value).toEqual(runReal(tree, specs, false).value);
        }),
        { numRuns: RUNS },
      );
    },
    TIMEOUT,
  );
});

describe('always-sensitive class: counterexample witnesses', () => {
  const token = () => {
    setSensitiveMode(true);
    return alwaysSensitive(TOKEN);
  };
  const expectAlways = (v: unknown) => {
    expect(isLabeled(v)).toBe(true);
    expect(always(v)).toBe(true);
  };

  it('slice: a method read off the token and invoked is always sensitive', () => {
    const tok = token();
    const slice = member(tok, (s) => (s as string).slice);
    const out = invoke(slice, [0, 4], (target, args) =>
      Reflect.apply(target as () => unknown, unbox(tok), args),
    );
    expectAlways(out);
    expect(unbox(out)).toBe(TOKEN.slice(0, 4));
  });

  it('concat and template: `token + ""` and `${token}` are always sensitive', () => {
    const tok = token();
    expectAlways(strictBinary(tok, '', (a, b) => String(a) + String(b)));
    const head = strictBinary('Bearer ', tok, (a, b) => `${a}${b}`);
    expectAlways(head);
    expect(unbox(head)).toBe(`Bearer ${TOKEN}`);
    expectAlways(shim('join')(['Bearer ', tok], [''], call));
    expectAlways(strictUnary(tok, (s) => (s as string).length));
  });

  it('ternary and logic: a branch chosen by the token, or the token as a branch, is always sensitive', () => {
    const tok = token();
    const nonEmpty = strictBinary(tok, '', (a, b) => a !== b);
    expectAlways(
      conditional(
        nonEmpty,
        () => 'yes',
        () => 'no',
      ),
    );
    expectAlways(and(nonEmpty, () => 1));
    const ordinary = sensitive(true);
    expectAlways(
      conditional(
        ordinary,
        () => tok,
        () => 0,
      ),
    );
    // A branch an ordinary test chose, over an always operand, keeps the class.
    const picked = conditional(
      ordinary,
      () => strictBinary(tok, 1, (a) => a),
      () => 0,
    );
    expectAlways(picked);
  });

  it('array map, filter and find: callbacks get always elements, results are always sensitive', () => {
    setSensitiveMode(true);
    const list = alwaysSensitive([TOKEN, 'x']);
    const got: unknown[] = [];
    // A compiled arrow is sentinel-aware: it receives its argument raw.
    const arrow = sentinelAware((x: unknown) => {
      got.push(x);
      return x;
    });
    const mapped = shim('map')(list, [arrow], call);
    expectAlways(mapped);
    got.forEach(expectAlways);
    const tok = alwaysSensitive(TOKEN);
    // A public array whose verdict reads the token: the answer depends on it.
    const isTok = sentinelAware((x: unknown) =>
      strictBinary(x, tok, (a, b) => a === b),
    );
    expectAlways(shim('filter')([TOKEN, 'x'], [isTok], call));
    expectAlways(shim('find')([TOKEN, 'x'], [isTok], call));
    expectAlways(shim('includes')([sensitive('x'), tok], ['nope'], call));
    expectAlways((spreadArray(list) as readonly unknown[])[0]);
  });

  it('object spread: every field read off an always record is always sensitive', () => {
    setSensitiveMode(true);
    const creds = alwaysSensitive({ user: 'ada', secret: TOKEN });
    const copy = Object.fromEntries(
      ['user', 'secret'].map((k) => [
        k,
        member(creds, (o) => (o as Record<string, unknown>)[k]),
      ]),
    );
    Object.values(copy).forEach(expectAlways);
    expect(isAlwaysSensitive(copy)).toBe(true);
  });

  it('sentinel twin: an absorber reached by the token is its always twin', () => {
    const tok = token();
    const pending = strictBinary(tok, loading(), () => 0);
    expect(isLoading(pending)).toBe(true);
    expectAlways(pending);
    const twin = alwaysSensitive(loading());
    expectAlways(strictBinary(twin, 1, () => 0));
    // An ordinary label beside the always one: still always.
    expectAlways(strictBinary(sensitive(loading()), tok, () => 0));
  });

  it('nested container: an ordinary box or record that holds the token labels its derivations always', () => {
    const tok = token();
    const ordinaryBox = sensitive([tok]);
    const text = strictBinary(ordinaryBox, '', (a, b) => String(a) + String(b));
    expect(unbox(text)).toBe(TOKEN);
    expectAlways(text);
    const plain = invoke(
      (o: { k: string }) => o.k.slice(0, 4),
      [{ k: tok }],
      call,
    );
    expectAlways(plain);
    expectAlways(shim('join')([[tok]], ['-'], call));
    expectAlways(shim('concat')(['a'], [ordinaryBox], call));
  });

  it('errors: a throw under the token, or a mint inside its branch, is always sensitive and so is its report', () => {
    const tok = token();
    let minted: unknown;
    try {
      strictBinary(tok, 1, () => {
        throw new TypeError('bad');
      });
    } catch (thrown) {
      minted = error(thrown, 'evaluation');
    }
    expect(isError(minted)).toBe(true);
    expectAlways(minted);
    expect(always(reports.at(-1)?.cause)).toBe(true);
    const nonEmpty = strictBinary(tok, '', (a, b) => a !== b);
    const inBranch = conditional(
      nonEmpty,
      () => error('boom'),
      () => 0,
    );
    expectAlways(inBranch);
    expect(reports.at(-1)).toMatchObject({ sensitive: true });
    expect(always(reports.at(-1)?.cause)).toBe(true);
  });

  it('precision: ordinary labels never become always sensitive', () => {
    setSensitiveMode(true);
    const ssn = sensitive('123');
    const results = [
      strictBinary(ssn, '', (a, b) => String(a) + String(b)),
      shim('map')(sensitive([1, 2]), [(x: unknown) => x], call),
      conditional(
        ssn,
        () => 1,
        () => 0,
      ),
      strictBinary(ssn, loading(), () => 0),
    ];
    for (const r of results) {
      expect(isLabeled(r)).toBe(true);
      expect(always(r)).toBe(false);
      expect(isAlwaysSensitive(r)).toBe(false);
    }
  });

  it('[PIN S7] equality: a flip from ordinary to always at equal value is a change', () => {
    setSensitiveMode(true);
    const eq = sensitiveEqual<unknown>((a, b) => a === b);
    const before = strictBinary(sensitive(TOKEN), '', (a, b) => `${a}${b}`);
    const after = strictBinary(
      alwaysSensitive(TOKEN),
      '',
      (a, b) => `${a}${b}`,
    );
    expect(eq(before, after)).toBe(false);
  });
});
