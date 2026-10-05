import fc from 'fast-check';
import {
  type BinOp,
  type Expr,
  type FnName,
  type GlobalFnName,
  HOF_NAMES,
  type HofName,
  type LogicOp,
  type ParamName,
  POOL,
  type Prop,
  SEARCH_NAMES,
  type SearchName,
  type Slot,
  type UnaryOp,
} from '@mmstack/primitives/testing';

export interface ExprLanguageOptions {
  /** Include arrows, application and hofs (function values) in the generated language. */
  readonly functions?: boolean;
  readonly binOps?: readonly BinOp[];
  /** Include the two branded error leaves (`ERR[0]`/`ERR[1]`). Off by default so the refinement
   * differential — which quantifies over resolutions an error does not have — stays error-free. */
  readonly errors?: boolean;
}

const ALL_BIN_OPS: readonly BinOp[] = [
  'add',
  'sub',
  'mul',
  'pow',
  'lt',
  'looseEq',
  'strictEq',
];

const paramsArb = fc.constantFrom<readonly ParamName[]>(
  ['p'],
  ['q'],
  ['p', 'q'],
  ['q', 'p'],
);

function nodesFor(
  sub: fc.Arbitrary<Expr>,
  body: fc.Arbitrary<Expr>,
  withParam: boolean,
  options: Required<ExprLanguageOptions>,
): fc.Arbitrary<Expr>[] {
  const litArb = fc.nat(POOL.length - 1).map<Expr>((i) => ({ t: 'lit', i }));
  const slots = fc
    .array(fc.tuple(fc.boolean(), sub), { maxLength: 2 })
    .map<readonly Slot[]>((pairs) =>
      pairs.map(([isSpread, e]) => ({ spread: isSpread, e })),
    );
  const nodes: fc.Arbitrary<Expr>[] = [
    litArb,
    litArb,
    fc.constant<Expr>({ t: 'pending' }),
    fc
      .tuple(fc.constantFrom<UnaryOp>('negate', 'not', 'plus'), sub)
      .map<Expr>(([op, e]) => ({ t: 'unary', op, e })),
    fc
      .tuple(fc.constantFrom<BinOp>(...options.binOps), sub, sub)
      .map<Expr>(([op, l, r]) => ({ t: 'bin', op, l, r })),
    fc
      .tuple(fc.constantFrom<LogicOp>('and', 'or', 'coalesce'), sub, sub)
      .map<Expr>(([op, l, r]) => ({ t: 'logic', op, l, r })),
    fc.tuple(sub, sub, sub).map<Expr>(([c, a, b]) => ({ t: 'cond', c, a, b })),
    fc
      .tuple(fc.constantFrom<'a' | 'b'>('a', 'b'), sub)
      .map<Expr>(([k, o]) => ({ t: 'member', k, o })),
    fc.tuple(sub, sub).map<Expr>(([o, k]) => ({ t: 'memberc', o, k })),
    fc
      .tuple(fc.constantFrom<FnName>('double', 'pick'), slots)
      .map<Expr>(([f, args]) => ({ t: 'call', f, args })),
    fc
      .tuple(fc.constantFrom<GlobalFnName>('len', 'concat'), slots)
      .map<Expr>(([f, args]) => ({ t: 'gcall', f, args })),
    fc
      .array(fc.tuple(fc.boolean(), sub), { maxLength: 3 })
      .map<Expr>((pairs) => ({
        t: 'arr',
        slots: pairs.map(([isSpread, e]) => ({ spread: isSpread, e })),
      })),
    fc
      .array(
        fc.oneof(
          fc
            .tuple(fc.constantFrom<'a' | 'b'>('a', 'b'), sub)
            .map<Prop>(([k, v]) => ({ kind: 'static', k, v })),
          fc
            .tuple(sub, sub)
            .map<Prop>(([k, v]) => ({ kind: 'computed', k, v })),
          sub.map<Prop>((e) => ({ kind: 'spread', e })),
        ),
        { maxLength: 3 },
      )
      .map<Expr>((props) => ({ t: 'obj', props })),
    fc
      .tuple(
        fc.constantFrom<SearchName>(...SEARCH_NAMES),
        sub,
        sub,
        fc.option(sub, { nil: undefined }),
      )
      .map<Expr>(([m, arr, target, from]) => ({
        t: 'search',
        m,
        arr,
        target,
        from,
      })),
  ];
  if (options.functions) {
    const arrowExpr = fc
      .tuple(paramsArb, body)
      .map<Expr>(([params, b]) => ({ t: 'arrow', params, body: b }));
    const hofCallback = fc.oneof(arrowExpr, arrowExpr, arrowExpr, sub);
    nodes.push(
      arrowExpr,
      fc
        .tuple(sub, slots)
        .map<Expr>(([fn, args]) => ({ t: 'apply', fn, args })),
      fc
        .tuple(
          fc.constantFrom<HofName>(...HOF_NAMES),
          sub,
          hofCallback,
          fc.option(sub, { nil: undefined }),
        )
        .map<Expr>(([m, arr, cb, init]) => ({
          t: 'hof',
          m,
          arr,
          cb,
          init: m === 'reduce' ? init : undefined,
        })),
    );
  }
  if (withParam) {
    nodes.push(
      fc.constantFrom<Expr>(
        { t: 'param', name: 'p' },
        { t: 'param', name: 'q' },
      ),
    );
  }
  if (options.errors) {
    nodes.push(fc.constantFrom<Expr>({ t: 'err', id: 0 }, { t: 'err', id: 1 }));
  }
  return nodes;
}

export function makeExprArbitrary(
  options: ExprLanguageOptions = {},
): fc.Arbitrary<Expr> {
  const resolved: Required<ExprLanguageOptions> = {
    functions: options.functions ?? true,
    binOps: options.binOps ?? ALL_BIN_OPS,
    errors: options.errors ?? false,
  };
  const { expr } = fc.letrec((tie) => {
    const sub = tie('expr') as fc.Arbitrary<Expr>;
    const psub = tie('pexpr') as fc.Arbitrary<Expr>;
    return {
      expr: fc.oneof(
        { depthSize: 'small', withCrossShrink: true },
        ...nodesFor(sub, psub, false, resolved),
      ),
      pexpr: fc.oneof(
        { depthSize: 'small', withCrossShrink: true },
        ...nodesFor(psub, psub, true, resolved),
      ),
    };
  });
  return expr as fc.Arbitrary<Expr>;
}
