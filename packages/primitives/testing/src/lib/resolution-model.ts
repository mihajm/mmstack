import {
  ARRAY_METHOD_SHIMS,
  SentinelLeakError,
  and,
  coalesce,
  conditional,
  error,
  invoke,
  isAbsorbing,
  isSentinel,
  joinAbsorbers,
  joinAbsorbersDeep,
  member,
  or,
  sentinelAware,
  spreadArray,
  strictBinary,
  strictUnary,
  type Absorbing,
  type ApplyFn,
  type ErrorSentinel,
  type Loading,
} from '@mmstack/primitives/core';

/**
 * Two branded error identities shared by BOTH evaluators and the printed-source ctx (rendered `E0`
 * / `E1`), the error twin of the single shared `pending`. Fixed instances so `===` identity holds
 * across a model↔interpreter differential — provenance divergence (which error surfaces) is
 * observable, not just kind.
 */
export const ERR: readonly ErrorSentinel[] = Object.freeze([
  error('E0'),
  error('E1'),
]);

export type UnaryOp = 'negate' | 'not' | 'plus';
export type BinOp =
  'add' | 'sub' | 'mul' | 'pow' | 'lt' | 'looseEq' | 'strictEq';
export type LogicOp = 'and' | 'or' | 'coalesce';
export type FnName = 'double' | 'pick';
export type GlobalFnName = 'len' | 'concat';
export type HofName =
  | 'map'
  | 'filter'
  | 'some'
  | 'every'
  | 'find'
  | 'findIndex'
  | 'findLast'
  | 'findLastIndex'
  | 'flatMap'
  | 'reduce';
export type SearchName = 'indexOf' | 'lastIndexOf' | 'includes';
export type ParamName = 'p' | 'q';

export const HOF_NAMES: readonly HofName[] = Object.freeze([
  'map',
  'filter',
  'some',
  'every',
  'find',
  'findIndex',
  'findLast',
  'findLastIndex',
  'flatMap',
  'reduce',
]);

export const SEARCH_NAMES: readonly SearchName[] = Object.freeze([
  'indexOf',
  'lastIndexOf',
  'includes',
]);
export type Env = Readonly<Partial<Record<ParamName, unknown>>>;

export type Slot = { spread: boolean; e: Expr };
export type Prop =
  | { kind: 'static'; k: 'a' | 'b'; v: Expr }
  | { kind: 'computed'; k: Expr; v: Expr }
  | { kind: 'spread'; e: Expr };

export type Expr =
  | { t: 'lit'; i: number }
  | { t: 'pending' }
  | { t: 'err'; id: number }
  | { t: 'param'; name: ParamName }
  | { t: 'unary'; op: UnaryOp; e: Expr }
  | { t: 'bin'; op: BinOp; l: Expr; r: Expr }
  | { t: 'logic'; op: LogicOp; l: Expr; r: Expr }
  | { t: 'cond'; c: Expr; a: Expr; b: Expr }
  | { t: 'member'; k: 'a' | 'b'; o: Expr }
  | { t: 'memberc'; o: Expr; k: Expr }
  | { t: 'call'; f: FnName; args: readonly Slot[] }
  | { t: 'gcall'; f: GlobalFnName; args: readonly Slot[] }
  | { t: 'arr'; slots: readonly Slot[] }
  | { t: 'obj'; props: readonly Prop[] }
  | { t: 'arrow'; params: readonly ParamName[]; body: Expr }
  | { t: 'apply'; fn: Expr; args: readonly Slot[] }
  | { t: 'hof'; m: HofName; arr: Expr; cb: Expr; init?: Expr }
  | { t: 'search'; m: SearchName; arr: Expr; target: Expr; from?: Expr };

export const POOL: readonly unknown[] = Object.freeze([
  0,
  1,
  -1,
  NaN,
  '',
  'x',
  true,
  false,
  null,
  undefined,
  { a: 1, b: 'y' },
  { a: null },
  [1, 2],
]);

export const RESOLUTIONS: readonly unknown[] = Object.freeze([
  0,
  1,
  NaN,
  '',
  'x',
  'hello',
  true,
  false,
  null,
  undefined,
  { a: 1 },
  42,
  (x: unknown) => x,
  [1, 2],
  [],
]);

const UNARY: Record<UnaryOp, (v: unknown) => unknown> = {
  negate: (v) => -(v as number),
  not: (v) => !v,
  plus: (v) => +(v as number),
};

const fnNorm = (v: unknown): unknown => (typeof v === 'function' ? '<fn>' : v);

const BIN: Record<BinOp, (l: unknown, r: unknown) => unknown> = {
  add: (l, r) => (fnNorm(l) as number) + (fnNorm(r) as number),
  sub: (l, r) => (l as number) - (r as number),
  mul: (l, r) => (l as number) * (r as number),
  pow: (l, r) => (l as number) ** (r as number),
  lt: (l, r) => (fnNorm(l) as number) < (fnNorm(r) as number),
  looseEq: (l, r) => l == r,
  strictEq: (l, r) => l === r,
};

const readMember = (k: 'a' | 'b') => (o: unknown) =>
  (o as Record<string, unknown>)[k];

const readComputed = (o: unknown, k: unknown) =>
  (o as Record<string, unknown>)[fnNorm(k) as string];

const setProp = (o: Record<string, unknown>, k: unknown, v: unknown) => {
  o[fnNorm(k) as string] = v;
};

export const FNS: Record<FnName, (...args: unknown[]) => unknown> = {
  double: (arg) => 2 * (arg as number),
  pick: (arg) => arg,
};

/**
 * Model twins of an interpreter's default globals reached through a globals lookup (a different
 * compile path than ctx-resolved functions): the printed source resolves `len`/`concat` through
 * the real registry, so a drift between these twins and the shipped globals fails the
 * differential. Sentinel-free inputs make the deep-scan inert, so one table serves both
 * evaluators.
 */
export const GLOBAL_FNS: Record<GlobalFnName, (...args: unknown[]) => unknown> =
  {
    len: (arg) => {
      if (arg == null) return 0;
      if (typeof arg === 'string' || Array.isArray(arg)) return arg.length;
      return 0;
    },
    concat: (...args) => joinAbsorbersDeep(args) ?? args.join(''),
  };

const applyCall: ApplyFn = (target, args) =>
  (target as (...fnArgs: unknown[]) => unknown)(...args);

const normalizeArrowString = <T extends (...args: never[]) => unknown>(
  fn: T,
): T => {
  Object.defineProperty(fn, 'toString', { value: () => '<fn>' });
  return fn;
};

const bindParams = (
  env: Env,
  params: readonly ParamName[],
  args: readonly unknown[],
): Env => {
  const next: Record<string, unknown> = { ...env };
  params.forEach((name, i) => {
    next[name] = args[i];
  });
  return next as Env;
};

export function flattenAlgebra(
  slots: readonly Slot[],
  pending: Loading,
  env: Env,
): Absorbing | unknown[] {
  const out: unknown[] = [];
  const spreadAbsorbers: unknown[] = [];
  for (const slot of slots) {
    const value = evalAlgebra(slot.e, pending, env);
    if (!slot.spread) {
      out.push(value);
      continue;
    }
    const source = spreadArray(value);
    if (isAbsorbing(source)) {
      spreadAbsorbers.push(source);
      continue;
    }
    out.push(...source);
  }
  return joinAbsorbers(spreadAbsorbers) ?? out;
}

/**
 * Call-argument flatten (twin of an interpreter's call-argument flatten): positional args and
 * spread-expanded elements are OPERANDS. While the list is constructable the flat array is returned;
 * once a spread source absorbs the list is unconstructable and every evaluated operand joins in
 * syntactic order. Distinct from the container flatten, where positional elements are cells.
 */
export function flattenCallAlgebra(
  slots: readonly Slot[],
  pending: Loading,
  env: Env,
): Absorbing | unknown[] {
  const flat: unknown[] = [];
  let unconstructable = false;
  for (const slot of slots) {
    const value = evalAlgebra(slot.e, pending, env);
    if (!slot.spread) {
      flat.push(value);
      continue;
    }
    const source = spreadArray(value);
    if (isAbsorbing(source)) {
      unconstructable = true;
      flat.push(source);
      continue;
    }
    flat.push(...source);
  }
  return unconstructable ? (joinAbsorbers(flat) as Absorbing) : flat;
}

export function evalAlgebra(e: Expr, pending: Loading, env: Env): unknown {
  switch (e.t) {
    case 'lit':
      return POOL[e.i];
    case 'pending':
      return pending;
    case 'err':
      return ERR[e.id];
    case 'param':
      return env[e.name];
    case 'unary':
      return strictUnary(evalAlgebra(e.e, pending, env), UNARY[e.op]);
    case 'bin':
      return strictBinary(
        evalAlgebra(e.l, pending, env),
        evalAlgebra(e.r, pending, env),
        BIN[e.op],
      );
    case 'logic': {
      const left = evalAlgebra(e.l, pending, env);
      const right = () => evalAlgebra(e.r, pending, env);
      if (e.op === 'and') return and(left, right);
      if (e.op === 'or') return or(left, right);
      return coalesce(left, right);
    }
    case 'cond':
      return conditional(
        evalAlgebra(e.c, pending, env),
        () => evalAlgebra(e.a, pending, env),
        () => evalAlgebra(e.b, pending, env),
      );
    case 'member':
      return member(evalAlgebra(e.o, pending, env), readMember(e.k));
    case 'memberc':
      return strictBinary(
        evalAlgebra(e.o, pending, env),
        evalAlgebra(e.k, pending, env),
        readComputed,
      );
    case 'call': {
      const args = flattenCallAlgebra(e.args, pending, env);
      if (isAbsorbing(args)) return args;
      return invoke(FNS[e.f], args, applyCall);
    }
    case 'gcall': {
      const args = flattenCallAlgebra(e.args, pending, env);
      if (isAbsorbing(args)) return args;
      return invoke(GLOBAL_FNS[e.f], args, applyCall);
    }
    case 'arr':
      return flattenAlgebra(e.slots, pending, env);
    case 'obj': {
      const out: Record<string, unknown> = {};
      const structural: unknown[] = [];
      for (const prop of e.props) {
        if (prop.kind === 'static') {
          setProp(out, prop.k, evalAlgebra(prop.v, pending, env));
          continue;
        }
        if (prop.kind === 'computed') {
          const key = evalAlgebra(prop.k, pending, env);
          if (isAbsorbing(key)) {
            structural.push(key);
            continue;
          }
          setProp(out, key, evalAlgebra(prop.v, pending, env));
          continue;
        }
        const source = evalAlgebra(prop.e, pending, env);
        if (isAbsorbing(source)) {
          structural.push(source);
          continue;
        }
        Object.assign(out, source as object);
      }
      return joinAbsorbers(structural) ?? out;
    }
    case 'arrow':
      return sentinelAware(
        normalizeArrowString((...args: unknown[]) =>
          evalAlgebra(e.body, pending, bindParams(env, e.params, args)),
        ),
      );
    case 'apply': {
      const target = evalAlgebra(e.fn, pending, env);
      const args = flattenCallAlgebra(e.args, pending, env);
      if (isAbsorbing(args)) return joinAbsorbers([target, args]);
      return invoke(target, args, applyCall);
    }
    case 'hof': {
      const receiver = evalAlgebra(e.arr, pending, env);
      const method =
        isAbsorbing(receiver) || Array.isArray(receiver)
          ? undefined
          : (receiver as Record<string, unknown>)[e.m];
      const callback = evalAlgebra(e.cb, pending, env);
      const args =
        e.init === undefined
          ? [callback]
          : [callback, evalAlgebra(e.init, pending, env)];
      /* An absorbing receiver is the member result (`recv.m`), joined with the arguments exactly as
       * `(recv.m)(...args)` composes — so a higher-precedence pending argument outranks an error
       * receiver, and the arguments still evaluate. Non-array concrete receiver = JS-faithful method
       * lookup: a nullish receiver throws at the read; any other miss yields an undefined target that
       * flows through invoke, whose argument join lets a pending argument win over the structural
       * TypeError (e.g. `(0).reduce(p => 0, PENDING)` propagates; the TypeError surfaces once the
       * argument resolves). */
      if (isAbsorbing(receiver)) return joinAbsorbers([receiver, ...args]);
      if (!Array.isArray(receiver)) {
        return invoke(method, args, applyCall);
      }
      return ARRAY_METHOD_SHIMS[e.m](receiver, args, applyCall);
    }
    case 'search': {
      const receiver = evalAlgebra(e.arr, pending, env);
      const method =
        isAbsorbing(receiver) || Array.isArray(receiver)
          ? undefined
          : (receiver as Record<string, unknown>)[e.m];
      const target = evalAlgebra(e.target, pending, env);
      const args =
        e.from === undefined
          ? [target]
          : [target, evalAlgebra(e.from, pending, env)];
      if (isAbsorbing(receiver)) return joinAbsorbers([receiver, ...args]);
      if (!Array.isArray(receiver)) {
        const applyBound: ApplyFn = (fn, fnArgs) =>
          (fn as (...a: unknown[]) => unknown).apply(
            receiver,
            fnArgs as unknown[],
          );
        return invoke(method, args, applyBound);
      }
      return ARRAY_METHOD_SHIMS[e.m](receiver, args, applyCall);
    }
  }
}

function flattenPlain(
  slots: readonly Slot[],
  resolution: unknown,
  env: Env,
): unknown[] {
  const out: unknown[] = [];
  for (const slot of slots) {
    const value = evalPlain(slot.e, resolution, env);
    if (!slot.spread) {
      out.push(value);
      continue;
    }
    out.push(...(spreadArray(value) as readonly unknown[]));
  }
  return out;
}

export function evalPlain(e: Expr, resolution: unknown, env: Env): unknown {
  switch (e.t) {
    case 'lit':
      return POOL[e.i];
    case 'pending':
      return resolution;
    case 'err':
      return ERR[e.id];
    case 'param':
      return env[e.name];
    case 'unary':
      return UNARY[e.op](evalPlain(e.e, resolution, env));
    case 'bin':
      return BIN[e.op](
        evalPlain(e.l, resolution, env),
        evalPlain(e.r, resolution, env),
      );
    case 'logic': {
      const left = evalPlain(e.l, resolution, env);
      if (e.op === 'and') return left ? evalPlain(e.r, resolution, env) : left;
      if (e.op === 'or') return left ? left : evalPlain(e.r, resolution, env);
      return left != null ? left : evalPlain(e.r, resolution, env);
    }
    case 'cond':
      return evalPlain(e.c, resolution, env)
        ? evalPlain(e.a, resolution, env)
        : evalPlain(e.b, resolution, env);
    case 'member':
      return readMember(e.k)(evalPlain(e.o, resolution, env));
    case 'memberc':
      return readComputed(
        evalPlain(e.o, resolution, env),
        evalPlain(e.k, resolution, env),
      );
    case 'call':
      return FNS[e.f](...flattenPlain(e.args, resolution, env));
    case 'gcall':
      return GLOBAL_FNS[e.f](...flattenPlain(e.args, resolution, env));
    case 'arr':
      return flattenPlain(e.slots, resolution, env);
    case 'obj': {
      const out: Record<string, unknown> = {};
      for (const prop of e.props) {
        if (prop.kind === 'static') {
          setProp(out, prop.k, evalPlain(prop.v, resolution, env));
        } else if (prop.kind === 'computed') {
          setProp(
            out,
            evalPlain(prop.k, resolution, env),
            evalPlain(prop.v, resolution, env),
          );
        } else {
          Object.assign(out, evalPlain(prop.e, resolution, env) as object);
        }
      }
      return out;
    }
    case 'arrow':
      return normalizeArrowString((...args: unknown[]) =>
        evalPlain(e.body, resolution, bindParams(env, e.params, args)),
      );
    case 'apply':
      return applyCall(
        evalPlain(e.fn, resolution, env),
        flattenPlain(e.args, resolution, env),
      );
    case 'hof': {
      const receiver = evalPlain(e.arr, resolution, env) as Record<
        string,
        (...cbArgs: unknown[]) => unknown
      >;
      const callback = evalPlain(e.cb, resolution, env);
      return e.init === undefined
        ? receiver[e.m](callback)
        : receiver[e.m](callback, evalPlain(e.init, resolution, env));
    }
    case 'search': {
      const receiver = evalPlain(e.arr, resolution, env) as Record<
        string,
        (...searchArgs: unknown[]) => unknown
      >;
      const target = evalPlain(e.target, resolution, env);
      return e.from === undefined
        ? receiver[e.m](target)
        : receiver[e.m](target, evalPlain(e.from, resolution, env));
    }
  }
}

export function hasPending(e: Expr): boolean {
  switch (e.t) {
    case 'lit':
    case 'param':
    case 'err':
      return false;
    case 'pending':
      return true;
    case 'unary':
      return hasPending(e.e);
    case 'bin':
    case 'logic':
      return hasPending(e.l) || hasPending(e.r);
    case 'cond':
      return hasPending(e.c) || hasPending(e.a) || hasPending(e.b);
    case 'member':
      return hasPending(e.o);
    case 'memberc':
      return hasPending(e.o) || hasPending(e.k);
    case 'call':
    case 'gcall':
      return e.args.some((slot) => hasPending(slot.e));
    case 'arr':
      return e.slots.some((slot) => hasPending(slot.e));
    case 'obj':
      return e.props.some((prop) =>
        prop.kind === 'spread'
          ? hasPending(prop.e)
          : (prop.kind === 'computed' && hasPending(prop.k)) ||
            hasPending(prop.v),
      );
    case 'arrow':
      return hasPending(e.body);
    case 'apply':
      return hasPending(e.fn) || e.args.some((slot) => hasPending(slot.e));
    case 'hof':
      return (
        hasPending(e.arr) ||
        hasPending(e.cb) ||
        (e.init !== undefined && hasPending(e.init))
      );
    case 'search':
      return (
        hasPending(e.arr) ||
        hasPending(e.target) ||
        (e.from !== undefined && hasPending(e.from))
      );
  }
}

export function scanPending(
  value: unknown,
  pending: Loading,
): { found: boolean; foreign: boolean } {
  if (isSentinel(value)) return { found: true, foreign: value !== pending };
  if (Array.isArray(value)) {
    let found = false;
    for (const el of value) {
      const scan = scanPending(el, pending);
      if (scan.foreign) return scan;
      found = found || scan.found;
    }
    return { found, foreign: false };
  }
  if (typeof value === 'object' && value !== null && !POOL.includes(value)) {
    let found = false;
    for (const key of Object.keys(value)) {
      const scan = scanPending(
        (value as Record<string, unknown>)[key],
        pending,
      );
      if (scan.foreign) return scan;
      found = found || scan.found;
    }
    return { found, foreign: false };
  }
  return { found: false, foreign: false };
}

export function agrees(
  algebraVal: unknown,
  plainVal: unknown,
  pending: Loading,
): boolean {
  if (isSentinel(algebraVal)) return algebraVal === pending;
  if (Object.is(algebraVal, plainVal)) return true;
  if (typeof algebraVal === 'function' && typeof plainVal === 'function')
    return true;
  if (Array.isArray(algebraVal)) {
    return (
      Array.isArray(plainVal) &&
      algebraVal.length === plainVal.length &&
      algebraVal.every((el, i) => agrees(el, plainVal[i], pending))
    );
  }
  if (
    typeof algebraVal === 'object' &&
    algebraVal !== null &&
    typeof plainVal === 'object' &&
    plainVal !== null &&
    !Array.isArray(plainVal)
  ) {
    const aKeys = Object.keys(algebraVal);
    const pKeys = Object.keys(plainVal);
    return (
      aKeys.length === pKeys.length &&
      aKeys.every((key) =>
        agrees(
          (algebraVal as Record<string, unknown>)[key],
          (plainVal as Record<string, unknown>)[key],
          pending,
        ),
      )
    );
  }
  return false;
}

export type Outcome =
  { kind: 'value'; value: unknown } | { kind: 'throw' } | { kind: 'leak' };

export function runOutcome(evaluate: () => unknown): Outcome {
  try {
    return { kind: 'value', value: evaluate() };
  } catch (caught) {
    return caught instanceof SentinelLeakError
      ? { kind: 'leak' }
      : { kind: 'throw' };
  }
}

export const lit = (i: number): Expr => ({ t: 'lit', i });
export const param = (name: ParamName): Expr => ({ t: 'param', name });
export const arrow = (params: readonly ParamName[], body: Expr): Expr => ({
  t: 'arrow',
  params,
  body,
});
export const applyTo = (fn: Expr, ...args: Slot[]): Expr => ({
  t: 'apply',
  fn,
  args,
});
export const plain = (e: Expr): Slot => ({ spread: false, e });
export const spread = (e: Expr): Slot => ({ spread: true, e });
