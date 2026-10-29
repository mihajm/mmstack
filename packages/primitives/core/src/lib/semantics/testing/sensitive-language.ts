import fc from 'fast-check';
import { isSentinel } from '../index';

// The expression language, value alphabet and source generators of the sensitive-value model
// (`sensitive.model.spec.ts`), copied for the differential suite that runs them against the real
// hooks. The two host functions whose behavior belongs to the engine's globals roster (the console
// and the dynamic id draw) are left out of the generated language.

export type Plain =
  | number
  | string
  | boolean
  | null
  | undefined
  | Plain[]
  | { [k: string]: Plain };
export type UnOp = '!' | '-';
export type BinOp = '+' | '===' | '<' | '/';
export type MemberKey = 'a' | 'b' | 0 | 'length';
export type PlainFn = 'upper' | 'add1' | 'id' | 'first' | 'parse';
export type AwareFn = 'twice' | 'isLoading' | 'isError' | 'ifLoading';

export type Expr =
  | { t: 'src'; i: number }
  | { t: 'lit'; v: Plain }
  | { t: 'param' }
  | { t: 'un'; op: UnOp; a: Expr }
  | { t: 'bin'; op: BinOp; a: Expr; b: Expr }
  | { t: 'mem'; o: Expr; k: MemberKey }
  | { t: 'key'; o: Expr; k: Expr }
  | { t: 'call'; fn: PlainFn; args: Expr[] }
  | { t: 'aware'; fn: AwareFn; args: Expr[] }
  | { t: 'cond'; c: Expr; a: Expr; b: Expr }
  | { t: 'and' | 'or' | 'coal'; a: Expr; b: Expr }
  | { t: 'arr'; es: Expr[] }
  | { t: 'obj'; a: Expr; b: Expr }
  | { t: 'map' | 'filter' | 'find'; a: Expr; body: Expr }
  | { t: 'slice'; a: Expr; s: Expr }
  | { t: 'join'; a: Expr; sep: Expr }
  | { t: 'includes' | 'indexOf'; a: Expr; x: Expr; from?: Expr }
  | { t: 'sort'; a: Expr; by?: 'default' | 'absorbing' }
  | { t: 'spread'; a: Expr; b: Expr };

export type Sensitivity = 'none' | 'whole' | 'fields';
export type SourceSpec =
  | { kind: 'value'; v: Plain; sens: Sensitivity }
  | { kind: 'pending' }
  | { kind: 'error'; cause: Plain; sens: boolean };

export const N_SRC = 3;

/** A plain record: not an array, a sentinel or a class instance. */
export const isRec = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' &&
  v !== null &&
  !Array.isArray(v) &&
  !isSentinel(v) &&
  Object.getPrototypeOf(v) === Object.prototype;

export const nullish = (v: unknown): boolean => v === null || v === undefined;
export const truthy = (v: unknown): boolean => !!v;
export const sameValueZero = (a: unknown, b: unknown): boolean =>
  a === b ||
  (typeof a === 'number' && typeof b === 'number' && a !== a && b !== b);

export const nativeUnary = (op: UnOp, a: unknown): unknown =>
  op === '!' ? !a : -(a as number);

export const divByZero = (a: unknown, b: unknown): boolean =>
  b === 0 && typeof a === 'number';

export const nativeBinary = (op: BinOp, a: unknown, b: unknown): unknown => {
  switch (op) {
    case '+':
      return (a as number) + (b as number);
    case '===':
      return a === b;
    case '<':
      return (a as number) < (b as number);
    case '/':
      return (a as number) / (b as number);
  }
};

export const PLAIN_FNS: Record<PlainFn, (...args: unknown[]) => unknown> = {
  upper: (x) => String(x).toUpperCase(),
  add1: (x) => Number(x) + 1,
  id: (x) => x,
  first: (x) => (Array.isArray(x) ? x[0] : x),
  // A host function that throws with its input in the message, like `JSON.parse`.
  parse: (x) => {
    if (typeof x !== 'string' || !/^[0-9]+$/.test(x))
      throw new Error(`not a number: ${String(x)}`);
    return Number(x);
  },
};

export const divideMessage = (a: unknown): string =>
  `cannot divide ${String(a)} by zero`;
export const memberMessage = (k: unknown, o: unknown): string =>
  `cannot read ${String(k)} of ${String(o)}`;
export const notArrayMessage = (v: unknown): string =>
  `expected a list, got ${String(v)}`;

export const valueArb: fc.Arbitrary<Plain> = fc.letrec<{ v: Plain }>((tie) => ({
  v: fc.oneof(
    { maxDepth: 2, depthSize: 'small' },
    fc.constantFrom<Plain>(
      0,
      1,
      2,
      -1,
      'a',
      'b',
      '',
      '12',
      true,
      false,
      null,
      undefined,
    ),
    fc.array(tie('v'), { maxLength: 3 }),
    fc.record({ a: tie('v'), b: tie('v') }, { noNullPrototype: true }),
  ),
})).v;

export const sourceArb: fc.Arbitrary<SourceSpec> = fc.oneof(
  {
    weight: 7,
    arbitrary: fc.record({
      kind: fc.constant('value' as const),
      v: valueArb,
      sens: fc.constantFrom<Sensitivity>('none', 'whole', 'fields'),
    }),
  },
  { weight: 1, arbitrary: fc.constant({ kind: 'pending' as const }) },
  {
    weight: 1,
    arbitrary: fc.record({
      kind: fc.constant('error' as const),
      cause: valueArb,
      sens: fc.boolean(),
    }),
  },
);
export const sourcesArb = fc.array(sourceArb, {
  minLength: N_SRC,
  maxLength: N_SRC,
});
export const plainSourcesArb: fc.Arbitrary<SourceSpec[]> = sourcesArb.map(
  (specs) =>
    specs.map((s): SourceSpec =>
      s.kind === 'value'
        ? { ...s, sens: 'none' }
        : s.kind === 'error'
          ? { ...s, sens: false }
          : s,
    ),
);

export const exprArb: fc.Arbitrary<Expr> = fc.letrec<{ e: Expr }>((tie) => {
  const e = tie('e');
  const leaves: fc.Arbitrary<Expr>[] = [
    fc.integer({ min: 0, max: N_SRC - 1 }).map((i): Expr => ({ t: 'src', i })),
    valueArb.map((v): Expr => ({ t: 'lit', v })),
    fc.constant<Expr>({ t: 'param' }),
  ];
  const two = <T extends string>(ts: T[]) =>
    fc.record({ t: fc.constantFrom(...ts), a: e, b: e });
  return {
    e: fc.oneof(
      { maxDepth: 5, depthSize: 'small' },
      fc.oneof(...leaves),
      fc.record({
        t: fc.constant('un' as const),
        op: fc.constantFrom<UnOp>('!', '-'),
        a: e,
      }),
      fc.record({
        t: fc.constant('bin' as const),
        op: fc.constantFrom<BinOp>('+', '===', '<', '/'),
        a: e,
        b: e,
      }),
      fc.record({
        t: fc.constant('mem' as const),
        o: e,
        k: fc.constantFrom<MemberKey>('a', 'b', 0, 'length'),
      }),
      fc.record({ t: fc.constant('key' as const), o: e, k: e }),
      fc.record({
        t: fc.constant('call' as const),
        fn: fc.constantFrom<PlainFn>('upper', 'add1', 'id', 'first', 'parse'),
        args: fc.array(e, { minLength: 1, maxLength: 2 }),
      }),
      fc.record({
        t: fc.constant('aware' as const),
        fn: fc.constantFrom<AwareFn>(
          'twice',
          'isLoading',
          'isError',
          'ifLoading',
        ),
        args: fc.array(e, { minLength: 2, maxLength: 2 }),
      }),
      fc.record({ t: fc.constant('cond' as const), c: e, a: e, b: e }),
      two(['and', 'or', 'coal']),
      fc.record({
        t: fc.constant('arr' as const),
        es: fc.array(e, { maxLength: 3 }),
      }),
      fc.record({ t: fc.constant('obj' as const), a: e, b: e }),
      fc.record({
        t: fc.constantFrom('map' as const, 'filter' as const, 'find' as const),
        a: e,
        body: e,
      }),
      fc.record({ t: fc.constant('slice' as const), a: e, s: e }),
      fc.record({ t: fc.constant('join' as const), a: e, sep: e }),
      fc.record(
        {
          t: fc.constantFrom('includes' as const, 'indexOf' as const),
          a: e,
          x: e,
          from: e,
        },
        { requiredKeys: ['t', 'a', 'x'] },
      ),
      fc.record(
        {
          t: fc.constant('sort' as const),
          a: e,
          by: fc.constantFrom('default' as const, 'absorbing' as const),
        },
        { requiredKeys: ['t', 'a'] },
      ),
      two(['spread']),
    ) as fc.Arbitrary<Expr>,
  };
}).e;

// The model's paired-secret generator: two runs that differ only in the primitive leaves under a
// declared sensitivity (structure, labels and load states equal; each replaced leaf differs).

const primArb = fc.constantFrom<Plain>(
  0,
  1,
  2,
  -1,
  'a',
  'b',
  '',
  '12',
  'é',
  '日本',
  '🙂',
  true,
  false,
  null,
  undefined,
);

const varyLeaves = (v: Plain, next: (orig: Plain) => Plain): Plain =>
  Array.isArray(v)
    ? v.map((x) => varyLeaves(x, next))
    : isRec(v)
      ? (Object.fromEntries(
          Object.entries(v).map(([k, x]) => [k, varyLeaves(x as Plain, next)]),
        ) as Plain)
      : next(v);

const hidden = (s: SourceSpec): boolean =>
  s.kind === 'value' ? s.sens !== 'none' : s.kind === 'error' && s.sens;

const replacer = (stream: readonly Plain[]): ((orig: Plain) => Plain) => {
  let i = 0;
  return (orig) => {
    for (let t = 0; t < stream.length; t++) {
      const c = stream[i++ % stream.length];
      if (!Object.is(c, orig)) return c;
    }
    return orig === 'Ω' ? 'Ψ' : 'Ω';
  };
};

const varySpec = (s: SourceSpec, next: (orig: Plain) => Plain): SourceSpec =>
  !hidden(s)
    ? s
    : s.kind === 'value'
      ? { ...s, v: varyLeaves(s.v, next) }
      : s.kind === 'error'
        ? { ...s, cause: varyLeaves(s.cause, next) }
        : s;

export const pairedSourcesArb: fc.Arbitrary<
  readonly [SourceSpec[], SourceSpec[]]
> = fc
  .tuple(sourcesArb, fc.array(primArb, { minLength: 32, maxLength: 32 }))
  .map(([specs, stream]) => {
    const next = replacer(stream);
    return [specs, specs.map((s) => varySpec(s, next))] as const;
  });
