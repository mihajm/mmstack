import {
  ARRAY_METHOD_SHIMS,
  and,
  type ApplyFn,
  type ArrayMethodShim,
  coalesce,
  conditional,
  invoke,
  isLabeled,
  member,
  or,
  spreadArray,
  strictBinary,
  strictUnary,
  unlabel,
} from '@mmstack/primitives/algebra';
import {
  error,
  errorEdge,
  ifLoading,
  isAbsorbing,
  isError,
  isLoading,
  joinAbsorbers,
  loading,
  registerCanonical,
  sensitive,
  sentinelAware,
  setErrorReporter,
  setSensitiveMode,
  unboxAll,
} from '../index';
import {
  type BinOp,
  divByZero,
  divideMessage,
  type Expr,
  isRec,
  memberMessage,
  nativeBinary,
  nativeUnary,
  notArrayMessage,
  PLAIN_FNS,
  type SourceSpec,
} from './sensitive-language';

// The model's expression language evaluated through the real hooks and shims, composed the way an
// engine composes them. Every hook call is a catch site (a throw becomes `error(thrown,
// 'evaluation')`). Where the real schedule or scan differs from the model by design, the run records
// the family by name; the suite excludes such runs from the comparison the family affects and
// never widens the oracle.

/** Families excluded from the totality comparison (the real schedule or the cause differs by design). */
export const TOTALITY_EXCLUSIONS = [
  'deep-absorber-join', // the real hooks join absorbers at the top level only
  'search-first-absorber', // real search stops at the first absorber in scan order
  'filter-stops', // real filter stops at an absorbing verdict
  'sort-schedule', // the native sort's comparisons, every absorbing comparison folded
  'member-key-record', // a computed read's error carries the thrown message, not the key
] as const;

/** Families excluded from exactness only (the real hooks label more than the model). */
export const PRECISION_EXCLUSIONS = [
  'array-scan', // `===`, `!`, aware calls and computed reads scan nested arrays for labels
  'aware-any-argument', // an aware callee's result is labeled when any argument is
  'method-arguments', // a method call is labeled when an argument holds a label anywhere
] as const;

export type Family =
  (typeof TOTALITY_EXCLUSIONS)[number] | (typeof PRECISION_EXCLUSIONS)[number];

type Env = {
  srcs: unknown[];
  specs: readonly SourceSpec[];
  param?: unknown;
  flags: Set<Family>;
};

const call: ApplyFn = (target, args) =>
  (target as (...a: unknown[]) => unknown)(...args);

const contain = (run: () => unknown): unknown => {
  try {
    return run();
  } catch (thrown) {
    return error(thrown, 'evaluation');
  }
};

/** Something matching `hit` below the top level, through boxes, arrays and (optionally) records. */
const below = (
  value: unknown,
  hit: (v: unknown) => boolean,
  records: boolean,
): boolean => {
  const scan = (v: unknown, top: boolean): boolean => {
    if (!top && hit(v)) return true;
    const inner = unlabel(v);
    if (Array.isArray(inner)) return inner.some((x) => scan(x, false));
    return (
      records &&
      isRec(inner) &&
      Object.values(inner).some((x) => scan(x, false))
    );
  };
  return scan(value, true);
};
const nestedAbsorber = (v: unknown, records = true): boolean =>
  below(v, (x) => isAbsorbing(unlabel(x)), records);
const nestedLabel = (v: unknown, records: boolean): boolean =>
  below(v, isLabeled, records);
/** A label whose path from `v` passes through a record. */
const labelInRecord = (value: unknown): boolean => {
  const scan = (v: unknown, inRecord: boolean): boolean => {
    if (inRecord && isLabeled(v)) return true;
    const inner = unlabel(v);
    if (Array.isArray(inner)) return inner.some((x) => scan(x, inRecord));
    return isRec(inner) && Object.values(inner).some((x) => scan(x, true));
  };
  return scan(value, false);
};

export function materialize(spec: SourceSpec, mode: boolean): unknown {
  if (spec.kind === 'pending') return loading();
  if (spec.kind === 'error')
    return errorEdge(mode && spec.sens ? sensitive(spec.cause) : spec.cause);
  if (!mode || spec.sens === 'none') return spec.v;
  if (spec.sens === 'whole') return sensitive(spec.v);
  const raw = spec.v;
  if (Array.isArray(raw))
    return registerCanonical(
      raw.map((x) => sensitive(x)),
      raw,
    );
  if (isRec(raw))
    return registerCanonical(
      Object.fromEntries(
        Object.entries(raw).map(([k, x]) => [k, sensitive(x)]),
      ),
      raw,
    );
  return sensitive(raw);
}

function binary(op: BinOp, a: unknown, b: unknown, env: Env): unknown {
  // A nested label labels an absorber result too (the model's top stage reads top-level labels).
  if (nestedLabel(a, false) || nestedLabel(b, false))
    env.flags.add('array-scan');
  if (op !== '===' && (nestedAbsorber(a, false) || nestedAbsorber(b, false)))
    env.flags.add('deep-absorber-join');
  return contain(() =>
    strictBinary(a, b, (x, y) => {
      if (op === '/' && divByZero(x, y)) throw new Error(divideMessage(x));
      return nativeBinary(op, x, y);
    }),
  );
}

/** A method call as an engine makes one: read the method off the receiver, then invoke it. */
function method(
  name: string,
  receiver: unknown,
  args: unknown[],
  env: Env,
): unknown {
  const search = name === 'includes' || name === 'indexOf';
  if (args.some((a) => (search ? nestedLabel(a, true) : labelInRecord(a))))
    env.flags.add('method-arguments');
  const callee = contain(() =>
    member(receiver, (r) =>
      Array.isArray(r) ? ARRAY_METHOD_SHIMS[name] : undefined,
    ),
  );
  return contain(() =>
    invoke(callee, args, (target, plainArgs) => {
      if (typeof target !== 'function')
        throw new TypeError(notArrayMessage(unlabel(receiver)));
      return (target as ArrayMethodShim)(receiver, plainArgs, call);
    }),
  );
}

/** A compiled arrow: sentinel-aware, it receives its argument raw. */
const arrow = (body: Expr, env: Env, onVerdict?: (out: unknown) => void) =>
  sentinelAware((param: unknown) => {
    const out = evaluate(body, { ...env, param });
    if ((isLabeled(param) || nestedLabel(param, false)) && !isLabeled(out))
      env.flags.add('aware-any-argument');
    onVerdict?.(out);
    return out;
  });

const AWARE = {
  isLoading,
  isError,
  ifLoading,
} as const;

export function evaluate(e: Expr, env: Env): unknown {
  const go = (x: Expr): unknown => evaluate(x, env);
  switch (e.t) {
    case 'src':
      return env.srcs[e.i];
    case 'lit':
      return e.v;
    case 'param':
      return env.param;
    case 'un': {
      const a = go(e.a);
      if (nestedLabel(a, false)) env.flags.add('array-scan');
      if (e.op === '-' && nestedAbsorber(a, false))
        env.flags.add('deep-absorber-join');
      return contain(() => strictUnary(a, (x) => nativeUnary(e.op, x)));
    }
    case 'bin':
      return binary(e.op, go(e.a), go(e.b), env);
    case 'mem': {
      const o = go(e.o);
      return contain(() =>
        member(o, (x) => {
          if (x === null || x === undefined)
            throw new TypeError(memberMessage(e.k, x));
          return (x as Record<string | number, unknown>)[e.k];
        }),
      );
    }
    case 'key': {
      const [o, k] = [go(e.o), go(e.k)];
      if (nestedAbsorber(k, false)) env.flags.add('deep-absorber-join');
      if (nestedLabel(o, false) || nestedLabel(k, false))
        env.flags.add('array-scan');
      if (labelInRecord(k)) env.flags.add('member-key-record');
      return contain(() =>
        strictBinary(o, k, (x, key) => {
          if (x === null || x === undefined)
            throw new TypeError(memberMessage(key, x));
          return (x as Record<string, unknown>)[key as string];
        }),
      );
    }
    case 'call': {
      const args = e.args.map(go);
      if (args.some((a) => nestedAbsorber(a)))
        env.flags.add('deep-absorber-join');
      return contain(() => invoke(PLAIN_FNS[e.fn], args, call));
    }
    case 'aware': {
      const [x, fb] = e.args.map(go);
      if (nestedLabel(x, false)) env.flags.add('array-scan');
      if (e.fn === 'twice') {
        const twice = sentinelAware((v: unknown) => binary('+', v, v, env));
        return contain(() => invoke(twice, [x], call));
      }
      if (
        e.fn === 'ifLoading' &&
        (nestedLabel(fb, false) || (isLabeled(fb) && !isLoading(unlabel(x))))
      )
        env.flags.add('aware-any-argument');
      const args = e.fn === 'ifLoading' ? [x, fb] : [x];
      return contain(() =>
        invoke(AWARE[e.fn as keyof typeof AWARE], args, call),
      );
    }
    case 'cond': {
      const c = go(e.c);
      return contain(() =>
        conditional(
          c,
          () => go(e.a),
          () => go(e.b),
        ),
      );
    }
    case 'and':
    case 'or':
    case 'coal': {
      const a = go(e.a);
      const hook = e.t === 'and' ? and : e.t === 'or' ? or : coalesce;
      return contain(() => hook(a, () => go(e.b)));
    }
    case 'arr':
      return e.es.map(go);
    case 'obj':
      return { a: go(e.a), b: go(e.b) };
    case 'map':
    case 'filter':
    case 'find': {
      const a = go(e.a);
      const onVerdict =
        e.t === 'filter'
          ? (out: unknown) =>
              isAbsorbing(unlabel(out)) && env.flags.add('filter-stops')
          : undefined;
      return method(e.t, a, [arrow(e.body, env, onVerdict)], env);
    }
    case 'slice': {
      const [a, s] = [go(e.a), go(e.s)];
      if (nestedAbsorber(s, false)) env.flags.add('deep-absorber-join');
      return method('slice', a, [s], env);
    }
    case 'join': {
      const [a, sep] = [go(e.a), go(e.sep)];
      if (nestedAbsorber(a, false) || nestedAbsorber(sep, false))
        env.flags.add('deep-absorber-join');
      return method('join', a, [sep], env);
    }
    case 'includes':
    case 'indexOf': {
      const [a, x] = [go(e.a), go(e.x)];
      const from = e.from === undefined ? undefined : go(e.from);
      if (from !== undefined && nestedAbsorber(from, false))
        env.flags.add('deep-absorber-join');
      const inner = unlabel(a);
      if (Array.isArray(inner) && inner.some((el) => isAbsorbing(unlabel(el))))
        env.flags.add('search-first-absorber');
      return method(e.t, a, from === undefined ? [x] : [x, from], env);
    }
    case 'sort': {
      const a = go(e.a);
      if (e.by === 'absorbing') return method('toSorted', a, [loading()], env);
      if (e.by === 'default') {
        if (nestedAbsorber(a, false)) env.flags.add('deep-absorber-join');
        // The real default sort labels a single labeled element whole (it scans at array depth).
        if (nestedLabel(a, false)) env.flags.add('array-scan');
        return method('toSorted', a, [], env);
      }
      const plain = unboxAll(unlabel(a));
      // Insertion sort and the native sort agree on a consistent order (all numbers or all strings);
      // with fewer than two elements, or no array at all, neither compares anything.
      const uniform =
        !Array.isArray(plain) ||
        plain.length < 2 ||
        plain.every((x) => typeof x === 'number' && !Number.isNaN(x)) ||
        plain.every((x) => typeof x === 'string');
      if (!uniform) env.flags.add('sort-schedule');
      const compare = sentinelAware((x: unknown, y: unknown) => {
        const less = binary('<', x, y, env);
        if (isAbsorbing(unlabel(less))) env.flags.add('sort-schedule');
        return contain(() =>
          conditional(
            less,
            () => -1,
            () =>
              conditional(
                binary('<', y, x, env),
                () => 1,
                () => 0,
              ),
          ),
        );
      });
      return method('toSorted', a, [compare], env);
    }
    case 'spread': {
      const [a, b] = [go(e.a), go(e.b)];
      const labeled = isLabeled(a) || isLabeled(b);
      const top = joinAbsorbers([unlabel(a), unlabel(b)]);
      if (top) return labeled ? sensitive(top) : top;
      // `spreadArray` hands a boxed source's elements boxed; the literal they land in is new, and
      // the engine labels it whole when a source was labeled (its length follows the secret).
      const build = () => {
        const out = [
          ...(spreadArray(a) as readonly unknown[]),
          ...(spreadArray(b) as readonly unknown[]),
        ];
        return labeled ? sensitive(out) : out;
      };
      // A structural throw is as secret as any operand labeled at coercion depth: an engine's slot
      // builder runs the build as a labeled call then (here through an aware call, which marks it).
      if (!(labeled || nestedLabel(a, false) || nestedLabel(b, false)))
        return contain(build);
      return contain(() => {
        try {
          return build();
        } catch (thrown) {
          return invoke(
            sentinelAware(() => {
              throw thrown;
            }),
            [a, b],
            call,
          );
        }
      });
    }
  }
}

// ---------------------------------------------------------------------------------------------
// Runs and their observations
// ---------------------------------------------------------------------------------------------

const registered = (): number =>
  (
    globalThis as unknown as Record<
      symbol,
      { counters: { registered: number } }
    >
  )[Symbol.for('@mmstack/primitives.sensitive')].counters.registered;

/** A plain value with every sentinel as its kind and every thrown error as its name and message. */
export const normalize = (v: unknown): unknown => {
  if (isLoading(v)) return { k: 'loading' };
  if (isError(v)) return { k: 'error' };
  if (v instanceof Error) return { name: v.name, message: v.message };
  if (Array.isArray(v)) return v.map(normalize);
  if (isRec(v))
    return Object.fromEntries(
      Object.entries(v).map(([k, x]) => [k, normalize(x)]),
    );
  return v;
};

/** Label positions as a withholding reader sees them: a labeled position hides what is below it. */
export const realShape = (v: unknown): unknown => {
  if (isLabeled(v)) return 'L';
  if (isLoading(v)) return { k: 'loading' };
  if (isError(v)) return { k: 'error' };
  if (Array.isArray(v)) return v.map(realShape);
  if (isRec(v))
    return Object.fromEntries(
      Object.entries(v).map(([k, x]) => [k, realShape(x)]),
    );
  return '.';
};

export type Report = {
  origin: string;
  subclass: string;
  cause: unknown;
  sensitive: boolean;
};

export interface RealRun {
  /** The raw result, valid only while the run's mode is on. */
  readonly raw: unknown;
  /** The result with every box removed, normalized. */
  readonly value: unknown;
  /** The label positions (mode on only). */
  readonly shape: unknown;
  readonly reports: readonly Report[];
  readonly flags: ReadonlySet<Family>;
  /** Registrations into the sensitive registry during the run. */
  readonly registered: number;
}

/**
 * Evaluates `tree` over `specs` through the real hooks with the mode `on` or off. `observe` reads
 * the raw result while the mode is still on (reader operations, label positions).
 */
export function runReal<T = undefined>(
  tree: Expr,
  specs: readonly SourceSpec[],
  on: boolean,
  observe?: (raw: unknown, reports: readonly Report[]) => T,
): RealRun & { observed: T | undefined } {
  const reports: Report[] = [];
  setErrorReporter((r) => reports.push(r));
  setSensitiveMode(on);
  const before = registered();
  try {
    const env: Env = { srcs: [], specs, flags: new Set() };
    env.srcs = specs.map((s) => materialize(s, on));
    const raw = evaluate(tree, env);
    return {
      raw,
      value: normalize(unboxAll(raw)),
      shape: on ? realShape(raw) : undefined,
      reports,
      flags: env.flags,
      registered: registered() - before,
      observed: observe?.(raw, reports),
    };
  } finally {
    setSensitiveMode(false);
    setErrorReporter(undefined);
  }
}
