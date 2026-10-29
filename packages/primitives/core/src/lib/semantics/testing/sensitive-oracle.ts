import {
  divByZero,
  type Expr,
  isRec as isPlainRecord,
  nativeBinary,
  nativeUnary,
  nullish,
  PLAIN_FNS,
  type Plain,
  sameValueZero,
  type SourceSpec,
  truthy,
  type BinOp,
} from './sensitive-language';

// The model's taint oracle (`sensitive.model.spec.ts`), copied: a shadow-label interpreter over
// plain values that carries a label tree beside each value and never constructs a box. It keeps its
// own absorbers and ranked join (`value < error < pending`, leftmost error wins), so it shares no
// code with the real algebra it is compared against.

export type OracleAbsorber = { readonly kind: 'loading' | 'error' };
const absorbers = new WeakSet<object>();
const mintAbsorber = (kind: 'loading' | 'error'): OracleAbsorber => {
  const a = Object.freeze({ kind });
  absorbers.add(a);
  return a;
};
export const isOracleAbsorber = (v: unknown): v is OracleAbsorber =>
  typeof v === 'object' && v !== null && absorbers.has(v);
const isPending = (v: unknown): boolean =>
  isOracleAbsorber(v) && v.kind === 'loading';
const isErr = (v: unknown): boolean =>
  isOracleAbsorber(v) && v.kind === 'error';
const rank = (v: unknown): number => (isPending(v) ? 2 : isErr(v) ? 1 : 0);
const join = (vs: readonly unknown[]): OracleAbsorber | undefined => {
  let best: OracleAbsorber | undefined;
  for (const v of vs)
    if (isOracleAbsorber(v) && (!best || rank(v) > rank(best))) best = v;
  return best;
};
const isRec = (v: unknown): v is Record<string, unknown> =>
  !isOracleAbsorber(v) && isPlainRecord(v);

export type Lab = { b: boolean; kids?: Lab[] | { [k: string]: Lab } };
export type LV = { v: unknown; l: Lab };

const COERCING: ReadonlySet<string> = new Set(['-', '+', '<', '/']);

const plainLab = (v: unknown): Lab => {
  if (isOracleAbsorber(v)) return { b: false };
  if (Array.isArray(v)) return { b: false, kids: v.map(plainLab) };
  if (isRec(v))
    return {
      b: false,
      kids: Object.fromEntries(
        Object.entries(v).map(([k, x]) => [k, plainLab(x)]),
      ),
    };
  return { b: false };
};

const mark = (x: LV): LV => ({ v: x.v, l: { ...x.l, b: true } });
const markIf = (cond: boolean, x: LV): LV => (cond ? mark(x) : x);
const plainLV = (v: unknown): LV => ({ v, l: plainLab(v) });

const kidLab = (l: Lab, container: unknown, key: unknown): Lab | undefined => {
  const kids = l.kids;
  if (!kids) return undefined;
  if (Array.isArray(kids)) {
    const n = typeof key === 'number' ? key : Number(key);
    return Array.isArray(container) &&
      Number.isInteger(n) &&
      String(n) === String(key)
      ? kids[n]
      : undefined;
  }
  return Object.prototype.hasOwnProperty.call(kids, String(key))
    ? kids[String(key)]
    : undefined;
};
const kidsOf = (x: LV): Lab[] =>
  Array.isArray(x.l.kids) ? x.l.kids : (x.v as unknown[]).map(plainLab);
const elsOf = (x: LV): LV[] =>
  (x.v as unknown[]).map((v, i) => markIf(x.l.b, { v, l: kidsOf(x)[i] }));

const labeledAtCoercion = (x: LV): boolean =>
  x.l.b ||
  (Array.isArray(x.v) &&
    (x.v as unknown[]).some((e, i) =>
      labeledAtCoercion({ v: e, l: kidsOf(x)[i] }),
    ));
const labeledAnywhere = (l: Lab): boolean =>
  l.b || (l.kids !== undefined && Object.values(l.kids).some(labeledAnywhere));

const scanAtCoercion = (x: LV): LV[] => [
  x,
  ...(Array.isArray(x.v)
    ? (x.v as unknown[]).flatMap((v, i) =>
        scanAtCoercion({ v, l: kidsOf(x)[i] }),
      )
    : []),
];
const scanAnywhere = (x: LV): LV[] => [
  x,
  ...(Array.isArray(x.v)
    ? (x.v as unknown[]).flatMap((v, i) => scanAnywhere({ v, l: kidsOf(x)[i] }))
    : isRec(x.v)
      ? Object.entries(x.v).flatMap(([k, v]) =>
          scanAnywhere({ v, l: kidLab(x.l, x.v, k) ?? plainLab(v) }),
        )
      : []),
];

/** The ranked winner over what a hook scanned, labeled iff any scanned operand is labeled. */
const absorbed = (scanned: readonly LV[]): LV | undefined => {
  const j = join(scanned.map((x) => x.v));
  if (!j) return undefined;
  return { v: j, l: { b: scanned.some((x) => x.l.b) } };
};
const oracleError = (label: boolean): LV => ({
  v: mintAbsorber('error'),
  l: { b: label },
});

export const oracleSource = (s: SourceSpec): LV => {
  if (s.kind === 'pending') return plainLV(mintAbsorber('loading'));
  // A source's own error is structure: its payload is hidden, its occurrence is not labeled.
  if (s.kind === 'error') return oracleError(false);
  const x = plainLV(s.v);
  if (s.sens === 'whole') return mark(x);
  if (s.sens === 'fields' && (Array.isArray(s.v) || isRec(s.v))) {
    const kids = x.l.kids as Lab[] | Record<string, Lab>;
    const marked = Array.isArray(kids)
      ? kids.map((k) => ({ ...k, b: true }))
      : Object.fromEntries(
          Object.entries(kids).map(([k, l]) => [k, { ...l, b: true }]),
        );
    return { v: s.v, l: { b: false, kids: marked } };
  }
  return s.sens === 'fields' ? mark(x) : x;
};

const oBinary = (op: BinOp, a: LV, b: LV): LV => {
  const top = absorbed([a, b]);
  if (top) return top;
  if (COERCING.has(op)) {
    const deep = absorbed([...scanAtCoercion(a), ...scanAtCoercion(b)]);
    if (deep) return deep;
  }
  const labeled =
    op === '==='
      ? a.l.b || b.l.b
      : labeledAtCoercion(a) || labeledAtCoercion(b);
  if (op === '/' && divByZero(a.v, b.v)) return oracleError(labeled);
  return markIf(labeled, plainLV(nativeBinary(op, a.v, b.v)));
};

const oRead = (
  o: LV,
  k: unknown,
  keyLabeled: boolean,
  keyAnywhere = false,
): LV => {
  if (nullish(o.v)) return oracleError(o.l.b || keyLabeled || keyAnywhere);
  const v = (o.v as Record<string, unknown>)[k as string];
  const l = kidLab(o.l, o.v, k) ?? plainLab(v);
  return markIf(o.l.b || keyLabeled, { v, l });
};

const oList = (x: LV, others: readonly LV[] = []): LV | undefined => {
  if (Array.isArray(x.v)) return undefined;
  return oracleError(x.l.b || others.some(labeledAtCoercion));
};

export type OEnv = { srcs: LV[]; param?: LV };

const callPlain = (
  fn: keyof typeof PLAIN_FNS,
  args: unknown[],
): { ok: boolean; v?: unknown } => {
  try {
    return { ok: true, v: PLAIN_FNS[fn](...args) };
  } catch {
    return { ok: false };
  }
};

export const oracle = (e: Expr, env: OEnv): LV => {
  const go = (x: Expr): LV => oracle(x, env);
  switch (e.t) {
    case 'src':
      return env.srcs[e.i];
    case 'lit':
      return plainLV(e.v);
    case 'param':
      return env.param ?? plainLV(undefined);
    case 'un': {
      const a = go(e.a);
      if (e.op === '!') return absorbed([a]) ?? markIf(a.l.b, plainLV(!a.v));
      return (
        absorbed([a]) ??
        absorbed(scanAtCoercion(a)) ??
        markIf(labeledAtCoercion(a), plainLV(nativeUnary('-', a.v)))
      );
    }
    case 'bin':
      return oBinary(e.op, go(e.a), go(e.b));
    case 'mem': {
      const o = go(e.o);
      return absorbed([o]) ?? oRead(o, e.k, false);
    }
    case 'key': {
      const o = go(e.o);
      const k = go(e.k);
      return (
        absorbed([o, k]) ??
        absorbed([o, ...scanAtCoercion(k)]) ??
        oRead(o, k.v, labeledAtCoercion(k), labeledAnywhere(k.l))
      );
    }
    case 'call': {
      const args = e.args.map(go);
      const abs = absorbed(args) ?? absorbed(args.flatMap(scanAnywhere));
      if (abs) return abs;
      const labeled = args.some((a) => labeledAnywhere(a.l));
      const r = callPlain(
        e.fn,
        args.map((a) => a.v),
      );
      if (!r.ok) return oracleError(labeled);
      return markIf(labeled, plainLV(r.v));
    }
    case 'aware': {
      const args = e.args.map(go);
      const [x, fb] = [
        args[0] ?? plainLV(undefined),
        args[1] ?? plainLV(undefined),
      ];
      if (e.fn === 'twice') return oBinary('+', x, x);
      if (e.fn === 'isLoading') return markIf(x.l.b, plainLV(isPending(x.v)));
      if (e.fn === 'isError') return markIf(x.l.b, plainLV(isErr(x.v)));
      return isPending(x.v) ? markIf(x.l.b, fb) : x;
    }
    case 'cond': {
      const c = go(e.c);
      return absorbed([c]) ?? markIf(c.l.b, truthy(c.v) ? go(e.a) : go(e.b));
    }
    case 'and':
    case 'or':
    case 'coal': {
      const a = go(e.a);
      const keepLeft =
        e.t === 'and'
          ? !truthy(a.v)
          : e.t === 'or'
            ? truthy(a.v)
            : !nullish(a.v);
      return absorbed([a]) ?? (keepLeft ? a : markIf(a.l.b, go(e.b)));
    }
    case 'arr': {
      const es = e.es.map(go);
      return {
        v: es.map((x) => x.v),
        l: { b: false, kids: es.map((x) => x.l) },
      };
    }
    case 'obj': {
      const [a, b] = [go(e.a), go(e.b)];
      return {
        v: { a: a.v, b: b.v },
        l: { b: false, kids: { a: a.l, b: b.l } },
      };
    }
    case 'map':
    case 'filter':
    case 'find': {
      const a = go(e.a);
      const bad = absorbed([a]) ?? oList(a);
      if (bad) return bad;
      const els = elsOf(a);
      if (e.t === 'find') {
        const seen: LV[] = [a];
        for (const el of els) {
          const t = oracle(e.body, { ...env, param: el });
          seen.push(t);
          if (isOracleAbsorber(t.v)) return absorbed(seen) as LV;
          if (truthy(t.v))
            return markIf(
              seen.some((x) => x.l.b),
              el,
            );
        }
        return markIf(
          seen.some((x) => x.l.b),
          plainLV(undefined),
        );
      }
      const outs = els.map((el) => oracle(e.body, { ...env, param: el }));
      if (e.t === 'map')
        return markIf(a.l.b, {
          v: outs.map((x) => x.v),
          l: { b: false, kids: outs.map((x) => x.l) },
        });
      const abs = absorbed([a, ...outs]);
      if (abs) return abs;
      const kept = els.filter((_, i) => truthy(outs[i].v));
      return markIf(a.l.b || outs.some((t) => t.l.b), {
        v: kept.map((x) => x.v),
        l: { b: false, kids: kept.map((x) => x.l) },
      });
    }
    case 'slice': {
      const [a, s] = [go(e.a), go(e.s)];
      const bad =
        absorbed([a, s]) ??
        absorbed([a, ...scanAtCoercion(s)]) ??
        oList(a, [s]);
      if (bad) return bad;
      const start = s.v as number;
      return markIf(a.l.b || labeledAtCoercion(s), {
        v: (a.v as unknown[]).slice(start),
        l: {
          b: false,
          kids: elsOf(a)
            .map((x) => x.l)
            .slice(start),
        },
      });
    }
    case 'join': {
      const [a, sep] = [go(e.a), go(e.sep)];
      const bad = absorbed([a, sep]) ?? oList(a, [sep]);
      if (bad) return bad;
      const deep = absorbed([...scanAtCoercion(a), ...scanAtCoercion(sep)]);
      if (deep) return deep;
      return markIf(
        labeledAtCoercion(a) || labeledAtCoercion(sep),
        plainLV((a.v as unknown[]).join(sep.v as string)),
      );
    }
    case 'includes':
    case 'indexOf': {
      const [a, x] = [go(e.a), go(e.x)];
      const from = e.from === undefined ? undefined : go(e.from);
      const args = from ? [x, from] : [x];
      const bad = absorbed([a, ...args]) ?? oList(a, args);
      if (bad) return bad;
      const vs = a.v as unknown[];
      const eq =
        e.t === 'includes'
          ? sameValueZero
          : (p: unknown, q: unknown) => p === q;
      // The start index, as the native search reads it (negative counts from the end).
      let start = from ? Math.trunc(Number(from.v)) : 0;
      if (Number.isNaN(start)) start = 0;
      if (start < 0) start = Math.max(0, vs.length + start);
      let m = -1;
      for (let i = start; i < vs.length; i++)
        if (eq(vs[i], x.v)) {
          m = i;
          break;
        }
      const scanned = elsOf(a).slice(start, m >= 0 ? m + 1 : vs.length);
      const abs = absorbed([a, ...args, ...scanned]);
      if (abs) return abs;
      const labeled =
        a.l.b ||
        x.l.b ||
        (from !== undefined && labeledAtCoercion(from)) ||
        scanned.some((l) => l.l.b);
      return markIf(labeled, plainLV(e.t === 'includes' ? m >= 0 : m));
    }
    case 'sort': {
      const a = go(e.a);
      // An absorbing comparator: the call joins it with the receiver at the top level.
      if (e.by === 'absorbing')
        return absorbed([a, plainLV(mintAbsorber('loading'))]) as LV;
      if (e.by === 'default') {
        const bad = absorbed([a]) ?? oList(a);
        if (bad) return bad;
        const deep = absorbed(scanAtCoercion(a));
        if (deep) return deep;
        // The native default sort reads the string form of every element when two or more are
        // defined; with fewer it compares nothing.
        const defined = (a.v as unknown[]).filter(
          (v) => v !== undefined,
        ).length;
        const order = (a.v as unknown[])
          .map((v, i) => ({ v, i }))
          .sort((p, q) => {
            if (p.v === undefined) return q.v === undefined ? 0 : 1;
            if (q.v === undefined) return -1;
            const [sp, sq] = [String(p.v), String(q.v)];
            return sp < sq ? -1 : sp > sq ? 1 : 0;
          });
        const els = elsOf(a);
        return markIf(a.l.b || (defined > 1 && labeledAtCoercion(a)), {
          v: order.map((o) => o.v),
          l: { b: false, kids: order.map((o) => els[o.i].l) },
        });
      }
      const bad = absorbed([a]) ?? oList(a);
      if (bad) return bad;
      const xs = elsOf(a);
      const seen: LV[] = [a];
      for (let i = 1; i < xs.length; i++) {
        for (let j = i; j > 0; j--) {
          const t = oBinary('<', xs[j], xs[j - 1]);
          seen.push(t);
          if (isOracleAbsorber(t.v)) return absorbed(seen) as LV;
          if (!truthy(t.v)) break;
          [xs[j], xs[j - 1]] = [xs[j - 1], xs[j]];
        }
      }
      return markIf(
        seen.some((x) => x.l.b),
        { v: xs.map((x) => x.v), l: { b: false, kids: xs.map((x) => x.l) } },
      );
    }
    case 'spread': {
      const [a, b] = [go(e.a), go(e.b)];
      const bad = absorbed([a, b]) ?? oList(a, [b]) ?? oList(b, [a]);
      if (bad) return bad;
      return markIf(a.l.b || b.l.b, {
        v: [...(a.v as unknown[]), ...(b.v as unknown[])],
        l: { b: false, kids: [...elsOf(a), ...elsOf(b)].map((x) => x.l) },
      });
    }
  }
};

export const runOracle = (tree: Expr, specs: readonly SourceSpec[]): LV =>
  oracle(tree, { srcs: specs.map(oracleSource) });

/** The oracle's label tree as a reader sees it: a labeled position hides everything below it. */
export const oracleShape = (x: LV): unknown => {
  if (x.l.b) return 'L';
  if (isOracleAbsorber(x.v)) return { k: x.v.kind };
  if (Array.isArray(x.v))
    return (x.v as unknown[]).map((v, i) =>
      oracleShape({ v, l: kidsOf(x)[i] }),
    );
  if (isRec(x.v))
    return Object.fromEntries(
      Object.entries(x.v).map(([k, v]) => [
        k,
        oracleShape({ v, l: kidLab(x.l, x.v, k) ?? plainLab(v) }),
      ]),
    );
  return '.';
};

/** The oracle's plain value, absorbers as their kind. */
export const oracleValue = (v: unknown): unknown => {
  if (isOracleAbsorber(v)) return { k: v.kind };
  if (Array.isArray(v)) return v.map(oracleValue);
  if (isRec(v))
    return Object.fromEntries(
      Object.entries(v).map(([k, x]) => [k, oracleValue(x)]),
    );
  return v as Plain;
};
