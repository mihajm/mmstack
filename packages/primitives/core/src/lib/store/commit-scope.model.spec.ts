/**
 * MODEL: what each emission inside one commit scope cites, when the scope emits more than once.
 * A design record independent of the engine: it tests none of its code.
 *
 * A pure model in its own primitives (a number clock, string origins, its own registers, folds,
 * materialization and store), independent of store, opLog and opSync. A replica logs every envelope it
 * holds with an arrival number; a frontier is an arrival number and covers the envelopes that arrived
 * at or before it. A plain write cites every live sibling at its path and emits one clear per live
 * descendant register. A scoped emission does the same over an OBSERVED set of envelopes only.
 *
 * The rule (a scope is a branch): an emission inside a scope observes an envelope iff
 *  (1) the scope's frontier covers it, or
 *  (2) this replica's origin minted it after this scope was entered (by this scope or by a scope
 *      nested in it that has already returned).
 * Nothing else: not an own write minted before entry and not covered, not a peer envelope that arrived
 * after the frontier (also while the scope runs). A nested scope has its own frontier and entry point.
 *
 * Contracts.
 *  S1 branch equivalence: each scoped emission's ops (path, kind, value, cites, epoch) equal what a
 *     shadow replica produces by the same writes as plain sequential local writes, where the shadow
 *     holds exactly the envelopes the frontier covers (plus the envelopes of nested scopes once they
 *     return) and shares the origin. The shadow is a plain replica: incremental registers and the plain
 *     stamp; the scoped stamp works over a batch register view built from the observed set.
 *  S2 no scoped op cites a dot outside (1) or (2). Under the rule this holds by construction (lint);
 *     it is the property the rejected alternatives break.
 *  S3 after every envelope is delivered (any cross-origin order, per-origin order kept), every replica's
 *     store equals the materialization of the batch view of all envelopes.
 *  S4 a scoped emission made before any own emission after its scope's entry (nested scopes' included)
 *     is identical under the rule and under the frontier-only rule. Checked on each scope's first item
 *     when that item is an emission.
 *  S5 after every step, every replica's store equals the materialization of its own registers.
 *  S6 nested scopes: rows below, plus S1 applied recursively.
 *  S7 authority: rows below pin the epochs the shadow gives a bumped then unbumped emission.
 *
 * NON-COVERAGE (what this model does not decide; each needs its own argument or the engine spec):
 *  - arrays (keyed or unit), merge-policy folds, `preserve`, conflict values. Folds here are
 *    last-writer-wins and a numeric max at `m` and `b.m`.
 *  - the engine's frontier encoding. Here a frontier covers whole envelopes by arrival; a sibling the
 *    frontier covered stays observed even after a later uncovered envelope of the same origin replaced
 *    it in the register slot.
 *  - the engine's epoch floors. Here a floor is the highest epoch of the own origin's ops at a path in
 *    the observed set; an own bumped write after the frontier raises no floor for the scope.
 *  - the per-origin sibling slot: a scoped op replaces the same origin's unobserved write at every path
 *    it touches (clears included), as plain writes do. Concurrency with the same tab's later live
 *    writes holds only at registers the scope does not touch.
 *  - the opLog: tick coalescing, the outbox, flush timing, when a store write becomes an emission.
 *  - the receive version gate, duplicates, hydrate, restore, snapshot, settle, room generations.
 *  - a snapshot load or hydrate while a scope runs (the engine gives loaded dots fresh arrival numbers).
 *  - the store rule after a scoped emission is the fork-commit model's `before` rule (apply the deltas
 *    of the registers whose fold result changed to the store as it was), taken as given.
 *  - the materialization rule (deepest-live-wins and the drop rule), taken as given.
 *  - scopes inside scopes deeper than two levels; asynchronous scope bodies.
 */

// a module, so its top-level names stay out of the other import-free model specs' global scope
export {};

type Path = readonly string[];
type OpKind = 'set' | 'delete' | 'clear';
type MDot = { readonly o: string; readonly t: number };
type MOp = {
  readonly path: Path;
  readonly kind: OpKind;
  readonly value?: unknown;
  readonly cites: readonly MDot[];
  readonly epoch: number;
};
type MEnv = {
  readonly o: string;
  readonly t: number;
  readonly ops: readonly MOp[];
};
type Sib = {
  readonly o: string;
  readonly t: number;
  readonly kind: OpKind;
  readonly value?: unknown;
  readonly epoch: number;
};
type Res =
  | { readonly kind: 'set'; readonly value: unknown }
  | { readonly kind: 'delete' }
  | { readonly kind: 'clear' };
type Raw = {
  readonly path: Path;
  readonly kind: 'set' | 'delete';
  readonly value?: unknown;
};
type View = {
  live(path: Path): readonly Sib[];
  paths(): readonly Path[];
};

const pk = (p: Path): string => p.join('/');
const isRec = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);
const has = (v: unknown, k: string): boolean => isRec(v) && Object.hasOwn(v, k);
const isPrefix = (p: Path, q: Path): boolean =>
  p.length <= q.length && p.every((s, i) => q[i] === s);
const byDepth = (x: Path, y: Path): number =>
  x.length - y.length || (pk(x) < pk(y) ? -1 : pk(x) > pk(y) ? 1 : 0);

function deepEq(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (!isRec(a) || !isRec(b)) return false;
  const ka = Object.keys(a).sort();
  const kb = Object.keys(b).sort();
  if (ka.join('|') !== kb.join('|')) return false;
  return ka.every((k) => deepEq(a[k], b[k]));
}

function lookup(
  root: unknown,
  path: Path,
): { found: boolean; value?: unknown } {
  let cur = root;
  for (const seg of path) {
    if (!has(cur, seg)) return { found: false };
    cur = (cur as Record<string, unknown>)[seg];
  }
  return { found: true, value: cur };
}

function writeAt(
  root: unknown,
  path: Path,
  op: { kind: 'set' | 'delete'; value?: unknown },
): unknown {
  if (!path.length) return op.kind === 'set' ? op.value : root;
  const base: Record<string, unknown> = isRec(root) ? { ...root } : {};
  const [head, ...rest] = path;
  if (!rest.length) {
    if (op.kind === 'delete') delete base[head];
    else base[head] = op.value;
    return base;
  }
  base[head] = writeAt(base[head], rest, op);
  return base;
}
const applyStore = (root: unknown, ops: readonly Raw[]): unknown =>
  ops.reduce<unknown>((r, op) => writeAt(r, op.path, op), root);

// total order of siblings: epoch, then kind class (set and delete above clear), then clock, then origin
const kindRank = (k: OpKind): number => (k === 'clear' ? 0 : 1);
const order = (a: Sib, b: Sib): number =>
  a.epoch - b.epoch ||
  kindRank(a.kind) - kindRank(b.kind) ||
  a.t - b.t ||
  (a.o < b.o ? -1 : a.o > b.o ? 1 : 0);
const winnerOf = (s: readonly Sib[]): Sib =>
  s.reduce((x, y) => (order(x, y) >= 0 ? x : y));
const asRes = (s: Sib): Res =>
  s.kind === 'set' ? { kind: 'set', value: s.value } : { kind: s.kind };
const lwwFold = (live: readonly Sib[]): Res => asRes(winnerOf(live));
const maxFold = (live: readonly Sib[]): Res => {
  const w = winnerOf(live);
  if (w.kind === 'clear') return { kind: 'clear' };
  const nums = live.filter(
    (s) =>
      s.epoch === w.epoch && s.kind === 'set' && typeof s.value === 'number',
  );
  if (!nums.length) return asRes(w);
  return {
    kind: 'set',
    value: Math.max(...nums.map((s) => s.value as number)),
  };
};
const MAX_PATHS = new Set(['m', 'b/m']);
const foldAt = (path: Path) => (MAX_PATHS.has(pk(path)) ? maxFold : lwwFold);
const resOf = (v: View, path: Path): Res | undefined => {
  const live = v.live(path);
  return live.length ? foldAt(path)(live) : undefined;
};
const sameRes = (a: Res | undefined, b: Res | undefined): boolean =>
  a === b ||
  (!!a &&
    !!b &&
    a.kind === b.kind &&
    (a.kind !== 'set' || deepEq(a.value, (b as { value: unknown }).value)));

const descendants = (v: View, path: Path): Path[] =>
  v
    .paths()
    .filter((p) => p.length > path.length && isPrefix(path, p))
    .sort(byDepth);
const dotsOf = (live: readonly Sib[]): MDot[] =>
  live.map((s) => ({ o: s.o, t: s.t }));
const dotKey = (d: MDot): string => `${d.o}@${d.t}`;

/** Registers built incrementally, one envelope at a time: what a plain replica holds. */
class Table implements View {
  private readonly regs = new Map<
    string,
    { path: Path; best: Map<string, Sib>; water: Map<string, number> }
  >();
  ingest(env: MEnv): void {
    for (const op of env.ops) {
      let r = this.regs.get(pk(op.path));
      if (!r) {
        r = { path: op.path, best: new Map(), water: new Map() };
        this.regs.set(pk(op.path), r);
      }
      for (const c of op.cites) {
        if (c.o === env.o && c.t === env.t) continue;
        r.water.set(c.o, Math.max(r.water.get(c.o) ?? -1, c.t));
      }
      const cur = r.best.get(env.o);
      if (!cur || env.t > cur.t)
        r.best.set(env.o, {
          o: env.o,
          t: env.t,
          kind: op.kind,
          value: op.value,
          epoch: op.epoch,
        });
    }
  }
  live(path: Path): Sib[] {
    const r = this.regs.get(pk(path));
    if (!r) return [];
    return [...r.best.values()].filter((s) => s.t > (r.water.get(s.o) ?? -1));
  }
  paths(): Path[] {
    return [...this.regs.values()].map((r) => r.path);
  }
}

/** Registers as a pure function of an envelope set: the newest op per origin, unless an op cites it. */
function viewOf(envs: readonly MEnv[]): View {
  const at = new Map<
    string,
    { path: Path; entries: { env: MEnv; op: MOp }[] }
  >();
  for (const env of envs)
    for (const op of env.ops) {
      const g = at.get(pk(op.path)) ?? { path: op.path, entries: [] };
      g.entries.push({ env, op });
      at.set(pk(op.path), g);
    }
  return {
    paths: () => [...at.values()].map((g) => g.path),
    live: (path) => {
      const g = at.get(pk(path));
      if (!g) return [];
      const cited = (o: string, t: number) =>
        g.entries.some(({ env, op }) =>
          op.cites.some(
            (c) => c.o === o && c.t >= t && !(c.o === env.o && c.t === env.t),
          ),
        );
      const newest = new Map<string, { env: MEnv; op: MOp }>();
      for (const e of g.entries) {
        const cur = newest.get(e.env.o);
        if (!cur || e.env.t > cur.env.t) newest.set(e.env.o, e);
      }
      return [...newest.values()]
        .filter(({ env }) => !cited(env.o, env.t))
        .map(({ env, op }) => ({
          o: env.o,
          t: env.t,
          kind: op.kind,
          value: op.value,
          epoch: op.epoch,
        }));
    },
  };
}

// a value under `rel` of `v` materializes iff every segment but the last names a record
function graftable(v: unknown, rel: Path): boolean {
  let cur = v;
  for (let i = 0; i < rel.length - 1; i++) {
    if (!has(cur, rel[i])) return false;
    cur = (cur as Record<string, unknown>)[rel[i]];
  }
  return isRec(cur);
}
function shows(v: View, path: Path): boolean {
  let holder: Path | undefined;
  let hres: Res | undefined;
  for (let len = 0; len < path.length; len++) {
    const p = path.slice(0, len);
    const r = resOf(v, p);
    if (!r || r.kind === 'clear') continue;
    if (holder && hres) {
      if (hres.kind !== 'set') return false;
      if (!graftable(hres.value, p.slice(holder.length))) return false;
    }
    holder = p;
    hres = r;
  }
  if (!holder || !hres) return true;
  return (
    hres.kind === 'set' && graftable(hres.value, path.slice(holder.length))
  );
}
function graft(tree: unknown, rel: Path, r: Res): unknown {
  if (!isRec(tree)) return tree;
  const [head, ...rest] = rel;
  if (!rest.length) {
    if (r.kind === 'delete') {
      if (!has(tree, head)) return tree;
      const copy = { ...tree };
      delete copy[head];
      return copy;
    }
    return { ...tree, [head]: (r as { value: unknown }).value };
  }
  if (!has(tree, head)) return { ...tree, [head]: graft({}, rest, r) };
  const child = graft(tree[head], rest, r);
  return child === tree[head] ? tree : { ...tree, [head]: child };
}
function materializeAt(v: View, path: Path): unknown {
  const r = resOf(v, path);
  let tree: unknown = r?.kind === 'set' ? r.value : undefined;
  for (const d of descendants(v, path)) {
    const rd = resOf(v, d);
    if (!rd || rd.kind === 'clear' || !shows(v, d)) continue;
    tree = graft(tree, d.slice(path.length), rd);
  }
  return tree;
}
const materialize = (v: View): unknown => materializeAt(v, []);
function nearestContributing(v: View, path: Path): Path | undefined {
  for (let len = path.length - 1; len >= 0; len--) {
    const r = resOf(v, path.slice(0, len));
    if (r && r.kind !== 'clear') return path.slice(0, len);
  }
  return undefined;
}
/** The receive transformer: store ops for the registers whose fold result changed. */
function deltas(v: View, changed: readonly Path[]): Raw[] {
  const out: Raw[] = [];
  const regions: Path[] = [];
  for (const path of [...changed].sort(byDepth)) {
    if (regions.some((r) => isPrefix(r, path))) continue;
    const r = resOf(v, path);
    if (!r || r.kind === 'clear') {
      if (!path.length) continue;
      const anc = nearestContributing(v, path);
      if (!anc || resOf(v, anc)?.kind !== 'set' || !shows(v, anc)) continue;
      out.push({ kind: 'set', path: anc, value: materializeAt(v, anc) });
      regions.push(anc);
      continue;
    }
    if (!shows(v, path)) continue;
    if (r.kind === 'delete') {
      if (!path.length) continue;
      out.push({ kind: 'delete', path });
    } else out.push({ kind: 'set', path, value: materializeAt(v, path) });
    regions.push(path);
  }
  return out;
}

/** Store-shaped raw ops for intended edits, as a diff of the store would produce them. */
function shape(store: unknown, intents: readonly Raw[]): Raw[] {
  const out: Raw[] = [];
  for (const it of intents) {
    const here = lookup(store, it.path);
    if (it.kind === 'delete') {
      if (here.found && it.path.length) out.push(it);
      continue;
    }
    let lifted: Raw | undefined;
    for (let k = 1; k < it.path.length && !lifted; k++) {
      const at = lookup(store, it.path.slice(0, k));
      if (!at.found || !isRec(at.value)) {
        const nested = it.path
          .slice(k)
          .reduceRight<unknown>((v, seg) => ({ [seg]: v }), it.value);
        lifted = { kind: 'set', path: it.path.slice(0, k), value: nested };
      }
    }
    if (lifted) out.push(lifted);
    else if (!here.found || !deepEq(here.value, it.value)) out.push(it);
  }
  return out;
}

/** A plain replica: every write observes everything it holds. Also the S1 shadow. */
class Plain {
  readonly table = new Table();
  readonly floors = new Map<string, number>();
  clock = 0;
  constructor(readonly o: string) {}
  ingest(env: MEnv): void {
    this.clock = Math.max(this.clock, env.t);
    this.table.ingest(env);
    if (env.o !== this.o) return;
    for (const op of env.ops)
      if (op.epoch > (this.floors.get(pk(op.path)) ?? 0))
        this.floors.set(pk(op.path), op.epoch);
  }
  write(raws: readonly Raw[], bump: boolean, t = this.clock + 1): MEnv {
    const v = this.table;
    const epochFor = (path: Path, live: readonly Sib[]): number =>
      Math.max(this.floors.get(pk(path)) ?? 0, ...live.map((s) => s.epoch)) +
      (bump ? 1 : 0);
    const ops: MOp[] = [];
    for (const raw of raws) {
      const live = v.live(raw.path);
      ops.push({
        ...raw,
        cites: dotsOf(live),
        epoch: epochFor(raw.path, live),
      });
      for (const d of descendants(v, raw.path)) {
        if (resOf(v, d)?.kind === 'clear') continue;
        const dl = v.live(d);
        if (dl.length)
          ops.push({
            path: d,
            kind: 'clear',
            cites: dotsOf(dl),
            epoch: epochFor(d, dl),
          });
      }
    }
    const env: MEnv = { o: this.o, t, ops };
    this.ingest(env);
    return env;
  }
}

type Rule =
  | 'branch'
  | 'frontierOnly'
  | 'ownAlways'
  | 'advance'
  | 'noFrontier'
  | 'outerEntry'
  | 'noNested'
  | 'peersDuring'
  | 'noClears'
  | 'noFloor';
type Config = {
  readonly rule: Rule;
  readonly store?: 'deltas' | 'raw';
  readonly receive?: 'deltas' | 'raw';
};
type Logged = { readonly env: MEnv; readonly seq: number };
type Emit = {
  readonly kind: 'emit';
  readonly raws: readonly Raw[];
  readonly bump: boolean;
  readonly env: MEnv;
  readonly first?: readonly MOp[];
  readonly allowed: ReadonlySet<string>;
};
type Frame = {
  readonly F0: number;
  F: number;
  readonly entry: number;
  readonly parent?: Frame;
  readonly items: (Emit | { readonly kind: 'nested'; readonly frame: Frame })[];
};

class Replica extends Plain {
  store: unknown = {};
  readonly log: Logged[] = [];
  seq = 0;
  frame: Frame | undefined;
  constructor(
    o: string,
    readonly cfg: Config,
  ) {
    super(o);
  }
  override ingest(env: MEnv): void {
    super.ingest(env);
    this.log.push({ env, seq: ++this.seq });
  }
  private absorb(env: MEnv): Path[] {
    const before = new Map<string, Res | undefined>();
    const touched: Path[] = [];
    for (const op of env.ops)
      if (!before.has(pk(op.path))) {
        before.set(pk(op.path), resOf(this.table, op.path));
        touched.push(op.path);
      }
    this.ingest(env);
    return touched.filter(
      (p) => !sameRes(before.get(pk(p)), resOf(this.table, p)),
    );
  }
  receive(env: MEnv): void {
    const pre = this.store;
    const changed = this.absorb(env);
    this.store =
      this.cfg.receive === 'raw'
        ? applyStore(
            pre,
            env.ops.filter((op): op is Raw & MOp => op.kind !== 'clear'),
          )
        : applyStore(pre, deltas(this.table, changed));
  }
  capture(): number {
    return this.seq;
  }
  writeLocal(intents: readonly Raw[], bump = false): MEnv | undefined {
    const raws = shape(this.store, intents);
    if (!raws.length) return undefined;
    const env = this.write(raws, bump);
    this.store = applyStore(this.store, raws);
    return env;
  }
  enter(F: number): void {
    this.frame = { F0: F, F, entry: this.seq, parent: this.frame, items: [] };
  }
  exit(): Frame {
    const f = this.frame as Frame;
    this.frame = f.parent;
    f.parent?.items.push({ kind: 'nested', frame: f });
    return f;
  }
  observed(f: Frame, rule: Rule): MEnv[] {
    const root = (fr: Frame): Frame => (fr.parent ? root(fr.parent) : fr);
    const direct = new Set(
      f.items.flatMap((i) => (i.kind === 'emit' ? [i.env] : [])),
    );
    const keep = ({ env, seq }: Logged): boolean => {
      const inF = seq <= f.F;
      const own = env.o === this.o;
      const since = own && seq > f.entry;
      switch (rule) {
        case 'frontierOnly':
        case 'advance':
          return inF;
        case 'ownAlways':
          return inF || own;
        case 'noFrontier':
          return since;
        case 'outerEntry':
          return inF || (own && seq > root(f).entry);
        case 'noNested':
          return inF || direct.has(env);
        case 'peersDuring':
          return inF || seq > f.entry;
        default:
          return inF || since;
      }
    };
    return this.log.filter(keep).map((e) => e.env);
  }
  /** The scoped stamp: cites and clears over the batch view of an observed set. */
  stampScoped(
    raws: readonly Raw[],
    bump: boolean,
    seen: readonly MEnv[],
    rule: Rule,
  ): MOp[] {
    const v = viewOf(seen);
    const floor = (path: Path): number =>
      rule === 'noFloor'
        ? 0
        : Math.max(
            0,
            ...seen
              .filter((e) => e.o === this.o)
              .flatMap((e) => e.ops)
              .filter((op) => pk(op.path) === pk(path))
              .map((op) => op.epoch),
          );
    const epochFor = (path: Path, live: readonly Sib[]): number =>
      Math.max(floor(path), ...live.map((s) => s.epoch)) + (bump ? 1 : 0);
    const ops: MOp[] = [];
    for (const raw of raws) {
      const live = v.live(raw.path);
      ops.push({
        ...raw,
        cites: dotsOf(live),
        epoch: epochFor(raw.path, live),
      });
      if (rule === 'noClears') continue;
      for (const d of descendants(v, raw.path)) {
        if (resOf(v, d)?.kind === 'clear') continue;
        const dl = v.live(d);
        if (dl.length)
          ops.push({
            path: d,
            kind: 'clear',
            cites: dotsOf(dl),
            epoch: epochFor(d, dl),
          });
      }
    }
    return ops;
  }
  emitScoped(
    intents: readonly Raw[],
    bump = false,
    flavor: 'store' | 'raw' = 'store',
  ): MEnv | undefined {
    const f = this.frame as Frame;
    const raws = flavor === 'store' ? shape(this.store, intents) : [...intents];
    if (!raws.length) return undefined;
    // the reference statement of (1) and (2), written apart from `observed`
    const allowed = new Set(
      this.log
        .filter((e) => e.seq <= f.F0 || (e.env.o === this.o && e.seq > f.entry))
        .map((e) => dotKey(e.env)),
    );
    const rule = this.cfg.rule;
    const ops = this.stampScoped(raws, bump, this.observed(f, rule), rule);
    const first = f.items.length
      ? undefined
      : this.stampScoped(
          raws,
          bump,
          this.observed(f, 'frontierOnly'),
          'frontierOnly',
        );
    const env: MEnv = { o: this.o, t: this.clock + 1, ops };
    const pre = this.store;
    const changed = this.absorb(env);
    this.store =
      this.cfg.store === 'raw'
        ? applyStore(pre, raws)
        : applyStore(pre, deltas(this.table, changed));
    f.items.push({ kind: 'emit', raws, bump, env, first, allowed });
    if (rule === 'advance') f.F = this.seq;
    return env;
  }
  s5(): boolean {
    return deepEq(this.store, materialize(this.table));
  }
}

function sameOps(a: readonly MOp[], b: readonly MOp[]): boolean {
  const norm = (op: MOp) => ({
    path: pk(op.path),
    kind: op.kind,
    value: op.value,
    cites: op.cites.map(dotKey).sort().join(','),
    epoch: op.epoch,
  });
  const x = a.map(norm);
  const y = b.map(norm);
  return (
    x.length === y.length &&
    x.every(
      (o, i) =>
        o.path === y[i].path &&
        o.kind === y[i].kind &&
        deepEq(o.value, y[i].value) &&
        o.cites === y[i].cites &&
        o.epoch === y[i].epoch,
    )
  );
}

const minted = (f: Frame): MEnv[] =>
  f.items.flatMap((i) => (i.kind === 'emit' ? [i.env] : minted(i.frame)));

/** S1: replay the scope on a shadow that holds exactly the covered envelopes, with plain writes. */
function s1(rep: Replica, f: Frame): string | null {
  const shadow = new Plain(rep.o);
  for (const e of rep.log) if (e.seq <= f.F0) shadow.ingest(e.env);
  for (const it of f.items) {
    if (it.kind === 'nested') {
      const inner = s1(rep, it.frame);
      if (inner) return inner;
      for (const env of minted(it.frame)) shadow.ingest(env);
      continue;
    }
    const s = shadow.write(it.raws, it.bump, it.env.t);
    if (!sameOps(s.ops, it.env.ops)) return `${rep.o}@${it.env.t}`;
  }
  return null;
}
function s2(f: Frame): string | null {
  for (const it of f.items) {
    if (it.kind === 'nested') {
      const inner = s2(it.frame);
      if (inner) return inner;
      continue;
    }
    for (const op of it.env.ops)
      for (const c of op.cites)
        if (!it.allowed.has(dotKey(c)))
          return `${dotKey(it.env)} cites ${dotKey(c)}`;
  }
  return null;
}
function s4(f: Frame): string | null {
  for (const it of f.items) {
    if (it.kind === 'nested') {
      const inner = s4(it.frame);
      if (inner) return inner;
      continue;
    }
    if (it.first && !sameOps(it.first, it.env.ops)) return dotKey(it.env);
  }
  return null;
}

const INIT = { a: { x: 0, y: 0 }, b: { m: 0 }, m: 0 };
const SEED: MEnv = {
  o: 's',
  t: 1,
  ops: [{ path: [], kind: 'set', value: INIT, cites: [], epoch: 0 }],
};
const PATHS: Path[] = [
  [],
  ['a'],
  ['a', 'x'],
  ['a', 'y'],
  ['b'],
  ['b', 'm'],
  ['m'],
];

const rngOf = (seed: number) => () => {
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

class World {
  readonly reps: Replica[];
  readonly envs: MEnv[] = [];
  readonly got: Set<number>[];
  constructor(cfg: Config, n = 3) {
    this.reps = Array.from({ length: n }, (_, i) => {
      const r = new Replica('r' + i, cfg);
      r.receive(SEED);
      return r;
    });
    this.got = this.reps.map(() => new Set<number>());
  }
  keep(r: number, env: MEnv | undefined): MEnv | undefined {
    if (env) this.got[r].add(this.envs.push(env) - 1);
    return env;
  }
  write(r: number, intents: readonly Raw[], bump = false) {
    return this.keep(r, this.reps[r].writeLocal(intents, bump));
  }
  emit(
    r: number,
    intents: readonly Raw[],
    bump = false,
    flavor: 'store' | 'raw' = 'store',
  ) {
    return this.keep(r, this.reps[r].emitScoped(intents, bump, flavor));
  }
  /** Per-origin order: the next envelope of each origin this replica lacks. */
  deliverable(r: number): number[] {
    const next = new Map<string, number>();
    this.envs.forEach((env, i) => {
      if (!this.got[r].has(i) && !next.has(env.o)) next.set(env.o, i);
    });
    return [...next.values()];
  }
  deliver(r: number, idx: number): void {
    this.reps[r].receive(this.envs[idx]);
    this.got[r].add(idx);
  }
  deliverAll(rng: () => number = Math.random): void {
    for (let r = 0; r < this.reps.length; r++)
      for (let c = this.deliverable(r); c.length; c = this.deliverable(r))
        this.deliver(r, c[Math.floor(rng() * c.length)]);
  }
}

const set = (path: Path, value: unknown): Raw => ({ kind: 'set', path, value });
const del = (path: Path): Raw => ({ kind: 'delete', path });
const num = (rng: () => number): number => 1 + Math.floor(rng() * 9);
function valueFor(path: Path, rng: () => number): unknown {
  const k = pk(path);
  if (k === '') {
    const v: Record<string, unknown> = {};
    if (rng() < 0.7) v['a'] = { x: num(rng), y: num(rng) };
    if (rng() < 0.7) v['b'] = { m: num(rng) };
    if (rng() < 0.7) v['m'] = num(rng);
    return v;
  }
  if (k === 'a')
    return rng() < 0.1
      ? num(rng)
      : rng() < 0.5
        ? { x: num(rng) }
        : { x: num(rng), y: num(rng) };
  if (k === 'b') return { m: num(rng) };
  return num(rng);
}
const intentAt = (path: Path, rng: () => number): Raw =>
  path.length && rng() < 0.2 ? del(path) : set(path, valueFor(path, rng));
const pickOf =
  (rng: () => number) =>
  <T>(xs: readonly T[]): T =>
    xs[Math.floor(rng() * xs.length)];
const related = (p: Path): Path[] =>
  PATHS.filter((q) => isPrefix(p, q) || isPrefix(q, p));

type Shape =
  | 'ancestorOverChild'
  | 'childAfterAncestor'
  | 'deleteAncestor'
  | 'samePath'
  | 'bumpFirst'
  | 'bumpLater'
  | 'peerSame'
  | 'peerDescendant'
  | 'peerAncestor'
  | 'ownBetween'
  | 'maxFold'
  | 'nested'
  | 'nestedStale'
  | 'midScopePeer';
type Violation = { seed: number; law: string; at: string };

/** One random interleaving; returns every law broken (first instance each) and the shapes reached. */
function run(cfg: Config, seed: number, steps = 30) {
  const rng = rngOf(seed);
  const pick = pickOf(rng);
  const w = new World(cfg);
  const caps: number[][] = w.reps.map(() => []);
  const broken = new Map<string, Violation>();
  const reached = new Set<Shape>();
  const fail = (law: string, at: string | null) => {
    if (at !== null && !broken.has(law)) broken.set(law, { seed, law, at });
  };

  const emitSome = (
    r: number,
    count: number,
    prev: { p?: Path; bump?: boolean },
  ) => {
    const rep = w.reps[r];
    for (let i = 0; i < count; i++) {
      const path = prev.p && rng() < 0.7 ? pick(related(prev.p)) : pick(PATHS);
      const it = intentAt(path, rng);
      const bump = rng() < 0.2;
      const env = w.emit(r, [it], bump, rng() < 0.6 ? 'store' : 'raw');
      if (!env) continue;
      const here = env.ops[0].path;
      if (prev.p) {
        if (pk(prev.p) === pk(here)) reached.add('samePath');
        else if (isPrefix(here, prev.p)) reached.add('ancestorOverChild');
        else if (isPrefix(prev.p, here)) reached.add('childAfterAncestor');
        if (isPrefix(here, prev.p) && env.ops[0].kind === 'delete')
          reached.add('deleteAncestor');
        if (prev.bump) reached.add('bumpFirst');
        if (bump) reached.add('bumpLater');
      }
      if (env.ops.some((op) => MAX_PATHS.has(pk(op.path))))
        reached.add('maxFold');
      const f = rep.frame as Frame;
      for (const e of rep.log)
        if (e.seq > f.F0 && e.env.o !== rep.o)
          for (const op of e.env.ops) {
            if (pk(op.path) === pk(here)) reached.add('peerSame');
            else if (isPrefix(here, op.path)) reached.add('peerDescendant');
            else if (isPrefix(op.path, here)) reached.add('peerAncestor');
          }
      prev.p = here;
      prev.bump = bump;
    }
  };

  for (let step = 0; step < steps; step++) {
    const r = Math.floor(rng() * w.reps.length);
    const rep = w.reps[r];
    const roll = rng();
    if (roll < 0.22) w.write(r, [intentAt(pick(PATHS), rng)], rng() < 0.15);
    else if (roll < 0.34) caps[r].push(rep.capture());
    else if (roll < 0.62) {
      const c = w.deliverable(r);
      if (c.length) w.deliver(r, pick(c));
    } else {
      const F = caps[r].length && rng() < 0.7 ? pick(caps[r]) : rep.capture();
      if (rng() < 0.3 && w.write(r, [intentAt(pick(PATHS), rng)]))
        reached.add('ownBetween');
      rep.enter(F);
      const prev: { p?: Path; bump?: boolean } = {};
      const items = 1 + Math.floor(rng() * 3);
      for (let i = 0; i < items; i++) {
        const k = rng();
        if (k < 0.2) {
          const c = w.deliverable(r);
          if (c.length) {
            w.deliver(r, pick(c));
            reached.add('midScopePeer');
          }
        } else if (k < 0.4) {
          const choices = [F, rep.capture(), ...caps[r]];
          const F2 = pick(choices);
          reached.add(F2 < rep.seq ? 'nestedStale' : 'nested');
          rep.enter(F2);
          emitSome(r, 1 + Math.floor(rng() * 2), { ...prev });
          rep.exit();
        }
        emitSome(r, 1, prev);
      }
      const f = rep.exit();
      fail('S1', s1(rep, f));
      fail('S2', s2(f));
      fail('S4', s4(f));
    }
    for (const x of w.reps) if (!x.s5()) fail('S5', x.o);
  }
  w.deliverAll(rng);
  const want = materialize(viewOf([SEED, ...w.envs]));
  for (const x of w.reps) {
    if (!x.s5()) fail('S5', x.o);
    if (!deepEq(x.store, want)) fail('S3', x.o);
  }
  return { broken: [...broken.values()], reached };
}

const SEEDS = 300;
function sweep(cfg: Config, seeds = SEEDS) {
  const laws = new Set<string>();
  const reached = new Set<Shape>();
  const examples: Violation[] = [];
  for (let s = 1; s <= seeds; s++) {
    const out = run(cfg, s * 7919);
    for (const v of out.broken) {
      if (!laws.has(v.law)) examples.push(v);
      laws.add(v.law);
    }
    out.reached.forEach((x) => reached.add(x));
  }
  return { laws: [...laws].sort(), reached, examples };
}

const A = { x: 1, y: 2 };
const opsBrief = (env: MEnv | undefined) =>
  (env?.ops ?? []).map((op) => ({
    path: pk(op.path),
    kind: op.kind,
    cites: op.cites.map(dotKey).sort(),
    epoch: op.epoch,
  }));

describe('MODEL commit scope: the defect and the plain control', () => {
  const script = (rule: Rule) => {
    const w = new World({ rule }, 2);
    const rep = w.reps[0];
    rep.enter(rep.capture());
    const e1 = w.emit(0, [set(['a', 'x'], 4)]);
    const e2 = w.emit(0, [set(['a'], A)]);
    const f = rep.exit();
    w.deliverAll();
    return { w, e1, e2, f };
  };

  it('frontier-only: the later ancestor set carries no clear for the child, every replica shows a value nobody wrote', () => {
    const { w, e2, f } = script('frontierOnly');
    expect(opsBrief(e2)).toEqual([
      { path: 'a', kind: 'set', cites: [], epoch: 0 },
    ]);
    for (const rep of w.reps)
      expect(lookup(rep.store, ['a']).value).toEqual({ x: 4, y: 2 });
    expect(s1(w.reps[0], f)).not.toBeNull();
  });

  it('branch: the later ancestor set clears the child the earlier emission wrote', () => {
    const { w, e1, e2, f } = script('branch');
    expect(opsBrief(e2)).toEqual([
      { path: 'a', kind: 'set', cites: [], epoch: 0 },
      { path: 'a/x', kind: 'clear', cites: [dotKey(e1 as MEnv)], epoch: 0 },
    ]);
    for (const rep of w.reps) expect(lookup(rep.store, ['a']).value).toEqual(A);
    expect(s1(w.reps[0], f)).toBeNull();
  });

  it('the same two writes outside a scope end at the ancestor value', () => {
    const w = new World({ rule: 'branch' }, 2);
    w.write(0, [set(['a', 'x'], 4)]);
    w.write(0, [set(['a'], A)]);
    w.deliverAll();
    for (const rep of w.reps) expect(lookup(rep.store, ['a']).value).toEqual(A);
  });
});

describe('MODEL commit scope: properties over random interleavings', () => {
  // three replicas; plain writes with bumps, captures, per-origin-ordered deliveries, scopes of one to
  // three emissions from stale or fresh frontiers, nested scopes, peer deliveries mid-scope,
  // own writes between capture and entry, store-shaped and raw emissions, bumped emissions
  it('branch: S1, S2, S3, S4, S5 hold', () => {
    const out = sweep({ rule: 'branch' });
    expect(out.examples).toEqual([]);
  });

  it('the generator reaches every listed shape', () => {
    const { reached } = sweep({ rule: 'branch' });
    expect([...reached].sort()).toEqual(
      [
        'ancestorOverChild',
        'bumpFirst',
        'bumpLater',
        'childAfterAncestor',
        'deleteAncestor',
        'maxFold',
        'midScopePeer',
        'nested',
        'nestedStale',
        'ownBetween',
        'peerAncestor',
        'peerDescendant',
        'peerSame',
        'samePath',
      ].sort(),
    );
  });
});

describe('MODEL commit scope: each neutered rule breaks a named property', () => {
  const table: [string, Config, string[]][] = [
    ['frontier only (drop rule 2)', { rule: 'frontierOnly' }, ['S1']],
    [
      'drop rule 1 (observe own scope dots only)',
      { rule: 'noFrontier' },
      ['S1', 'S4'],
    ],
    ['own origin always observed', { rule: 'ownAlways' }, ['S1', 'S2', 'S4']],
    [
      'advance the frontier after each emission',
      { rule: 'advance' },
      ['S1', 'S2'],
    ],
    [
      'rule 2 counted from the outermost entry',
      { rule: 'outerEntry' },
      ['S1', 'S2', 'S4'],
    ],
    ['rule 2 without nested scope dots', { rule: 'noNested' }, ['S1']],
    [
      'peer dots that arrive mid-scope observed',
      { rule: 'peersDuring' },
      ['S1', 'S2', 'S4'],
    ],
    ['no clears for observed descendants', { rule: 'noClears' }, ['S1', 'S4']],
    [
      'scoped emission written raw to the store',
      { rule: 'branch', store: 'raw' },
      ['S3', 'S5'],
    ],
    [
      'receiver writes raw ops',
      { rule: 'branch', receive: 'raw' },
      ['S3', 'S5'],
    ],
  ];
  for (const [name, cfg, laws] of table)
    it(`${name}: red on ${laws.join(', ')}`, () => {
      expect(sweep(cfg).laws).toEqual(laws);
    });

  it('the own-floor term is reached rarely by the generator: red on S1, S4', () => {
    expect(sweep({ rule: 'noFloor' }).laws).toEqual(['S1', 'S4']);
  });

  it('pinned, model only: an own bumped dot superseded by a write the same slot later replaced keeps its floor', () => {
    // evidence about the model's floor only: the engine's floors are per replica and keep this epoch
    // r1 cites r0's bumped dot at epoch 1, then a stale scope on r1 takes r1's slot at epoch 0
    const script = (rule: Rule) => {
      const w = new World({ rule }, 2);
      const F1 = w.reps[1].capture();
      w.write(0, [set(['a', 'x'], 4)], true);
      w.deliverAll();
      w.write(1, [set(['a', 'x'], 5)]);
      w.reps[1].enter(F1);
      w.emit(1, [set(['a', 'x'], 6)]);
      w.reps[1].exit();
      w.deliverAll();
      const rep = w.reps[0];
      rep.enter(rep.capture());
      const e = w.emit(0, [set(['a', 'x'], 7)]);
      const f = rep.exit();
      return { e: opsBrief(e), s1: s1(rep, f) };
    };
    expect(script('branch')).toEqual({
      e: [{ path: 'a/x', kind: 'set', cites: ['r1@4'], epoch: 1 }],
      s1: null,
    });
    expect(script('noFloor').e[0].epoch).toBe(0);
    expect(script('noFloor').s1).not.toBeNull();
  });
});

describe('MODEL commit scope: killed alternatives, pinned', () => {
  it('(iv) frontier only, shortest S1 trace: one replica, fresh frontier, the same path twice', () => {
    // a single emission is identical under both rules (S4), so two emissions is the minimum
    for (const rule of ['frontierOnly', 'branch'] as const) {
      const w = new World({ rule }, 1);
      const rep = w.reps[0];
      rep.enter(rep.capture());
      const e1 = w.emit(0, [set(['m'], 5)]) as MEnv;
      const e2 = w.emit(0, [set(['m'], 6)]);
      const f = rep.exit();
      expect(opsBrief(e2)[0].cites).toEqual(
        rule === 'branch' ? [dotKey(e1)] : [],
      );
      expect(s1(rep, f) === null).toBe(rule === 'branch');
    }
  });

  const ownBetween = (rule: Rule) => {
    const w = new World({ rule }, 2);
    const rep = w.reps[0];
    const F = rep.capture();
    const live = w.write(0, [set(['a', 'x'], 7)]) as MEnv;
    rep.enter(F);
    const e = w.emit(0, [set(['a'], A)]);
    const f = rep.exit();
    w.deliverAll();
    return { w, live, e, f };
  };
  it('(i) own origin always observed: clears an own live write made after the frontier', () => {
    const bad = ownBetween('ownAlways');
    expect(opsBrief(bad.e)).toEqual([
      { path: 'a', kind: 'set', cites: [], epoch: 0 },
      { path: 'a/x', kind: 'clear', cites: [dotKey(bad.live)], epoch: 0 },
    ]);
    expect(s2(bad.f)).toBe(`r0@3 cites ${dotKey(bad.live)}`);
    expect(s1(bad.w.reps[0], bad.f)).not.toBeNull();
    expect(lookup(bad.w.reps[1].store, ['a']).value).toEqual(A);
    const good = ownBetween('branch');
    expect(opsBrief(good.e)).toEqual([
      { path: 'a', kind: 'set', cites: [], epoch: 0 },
    ]);
    // the branch is concurrent with the live write, which survives under deepest-live-wins
    for (const rep of good.w.reps)
      expect(lookup(rep.store, ['a']).value).toEqual({ x: 7, y: 2 });
  });

  const stalePeer = (rule: Rule) => {
    const w = new World({ rule }, 2);
    const rep = w.reps[0];
    const F = rep.capture();
    const peer = w.write(1, [set(['b', 'm'], 9)]) as MEnv;
    w.deliverAll();
    rep.enter(F);
    w.emit(0, [set(['m'], 1)]);
    const e2 = w.emit(0, [set(['b', 'm'], 3)]);
    const f = rep.exit();
    w.deliverAll();
    return { w, peer, e2, f };
  };
  it('(ii) advance the frontier after each emission: cites a peer write that landed after the frontier', () => {
    const bad = stalePeer('advance');
    expect(opsBrief(bad.e2)[0].cites).toEqual([dotKey(bad.peer)]);
    expect(s2(bad.f)).not.toBeNull();
    for (const rep of bad.w.reps)
      expect(lookup(rep.store, ['b', 'm']).value).toBe(3);
    const good = stalePeer('branch');
    expect(opsBrief(good.e2)[0].cites).toEqual([]);
    // concurrent with the peer, the max fold keeps 9
    for (const rep of good.w.reps)
      expect(lookup(rep.store, ['b', 'm']).value).toBe(9);
  });

  it('(iii) one merged envelope per scope: no single bump flag reproduces two emissions with different bumps', () => {
    const build = (mode: 'branch' | true | false) => {
      const w = new World({ rule: 'branch' }, 2);
      const rep = w.reps[0];
      const F = rep.capture();
      w.write(1, [set(['b', 'm'], 7)]);
      w.deliverAll();
      rep.enter(F);
      const envs =
        mode === 'branch'
          ? [w.emit(0, [set(['m'], 5)], true), w.emit(0, [set(['b', 'm'], 2)])]
          : [w.emit(0, [set(['m'], 5), set(['b', 'm'], 2)], mode)];
      rep.exit();
      w.deliverAll();
      return {
        epochs: envs.flatMap(opsBrief).map((o) => `${o.path}:${o.epoch}`),
        bm: lookup(w.reps[1].store, ['b', 'm']).value,
      };
    };
    expect(build('branch')).toEqual({ epochs: ['m:1', 'b/m:0'], bm: 7 });
    expect(build(true)).toEqual({ epochs: ['m:1', 'b/m:1'], bm: 2 });
    expect(build(false)).toEqual({ epochs: ['m:0', 'b/m:0'], bm: 7 });
  });
});

describe('MODEL commit scope: nested scopes (S6)', () => {
  const nestedStale = (rule: Rule) => {
    const w = new World({ rule }, 2);
    const rep = w.reps[0];
    const F = rep.capture();
    rep.enter(F);
    w.emit(0, [set(['a', 'x'], 4)]);
    rep.enter(F);
    const inner = w.emit(0, [set(['a'], A)]);
    rep.exit();
    const f = rep.exit();
    w.deliverAll();
    return { w, inner, f };
  };
  it('an inner scope whose frontier predates the outer emission does not observe it', () => {
    const { w, inner, f } = nestedStale('branch');
    expect(opsBrief(inner)).toEqual([
      { path: 'a', kind: 'set', cites: [], epoch: 0 },
    ]);
    expect(s1(w.reps[0], f)).toBeNull();
    for (const rep of w.reps)
      expect(lookup(rep.store, ['a']).value).toEqual({ x: 4, y: 2 });
  });
  it('rule 2 counted from the outermost entry breaks that row', () => {
    const { w, inner, f } = nestedStale('outerEntry');
    expect(opsBrief(inner).map((o) => o.path)).toEqual(['a', 'a/x']);
    expect(s1(w.reps[0], f)).not.toBeNull();
  });

  it('an inner scope whose frontier covers the outer emission observes it', () => {
    const w = new World({ rule: 'branch' }, 1);
    const rep = w.reps[0];
    rep.enter(rep.capture());
    const e1 = w.emit(0, [set(['a', 'x'], 4)]) as MEnv;
    rep.enter(rep.capture());
    const inner = w.emit(0, [set(['a'], A)]);
    rep.exit();
    const f = rep.exit();
    expect(opsBrief(inner)[1]).toEqual({
      path: 'a/x',
      kind: 'clear',
      cites: [dotKey(e1)],
      epoch: 0,
    });
    expect(s1(rep, f)).toBeNull();
  });

  const outerAfter = (rule: Rule) => {
    const w = new World({ rule }, 2);
    const rep = w.reps[0];
    const F = rep.capture();
    rep.enter(F);
    rep.enter(F);
    const inner = w.emit(0, [set(['a', 'x'], 4)]) as MEnv;
    rep.exit();
    const outer = w.emit(0, [set(['a'], A)]);
    const f = rep.exit();
    w.deliverAll();
    return { w, inner, outer, f };
  };
  it('the outer scope observes a returned inner scope', () => {
    const { w, inner, outer, f } = outerAfter('branch');
    expect(opsBrief(outer)[1]).toEqual({
      path: 'a/x',
      kind: 'clear',
      cites: [dotKey(inner)],
      epoch: 0,
    });
    expect(s1(w.reps[0], f)).toBeNull();
    for (const rep of w.reps) expect(lookup(rep.store, ['a']).value).toEqual(A);
  });
  it('rule 2 without nested scope dots breaks that row', () => {
    const { w, outer, f } = outerAfter('noNested');
    expect(opsBrief(outer).map((o) => o.path)).toEqual(['a']);
    expect(s1(w.reps[0], f)).not.toBeNull();
  });
});

describe('MODEL commit scope: authority (S7), epochs under the shadow', () => {
  const scoped = (rule: Rule, a: [Raw, boolean], b: [Raw, boolean]) => {
    const w = new World({ rule }, 1);
    const rep = w.reps[0];
    rep.enter(rep.capture());
    const e1 = w.emit(0, [a[0]], a[1]);
    const e2 = w.emit(0, [b[0]], b[1]);
    const f = rep.exit();
    return { e1: opsBrief(e1), e2: opsBrief(e2), s1: s1(rep, f) };
  };
  it('bumped then unbumped at the same path: the second keeps the first epoch', () => {
    const got = scoped(
      'branch',
      [set(['a', 'x'], 4), true],
      [set(['a', 'x'], 5), false],
    );
    expect(got.e1.map((o) => o.epoch)).toEqual([1]);
    expect(got.e2.map((o) => `${o.path}:${o.epoch}`)).toEqual(['a/x:1']);
    expect(got.s1).toBeNull();
    const old = scoped(
      'frontierOnly',
      [set(['a', 'x'], 4), true],
      [set(['a', 'x'], 5), false],
    );
    // under the frontier-only rule the second emission drops the register back to epoch 0 (model only:
    // the engine's per-replica floor already gives 1 here)
    expect(old.e2.map((o) => `${o.path}:${o.epoch}`)).toEqual(['a/x:0']);
  });
  it('bumped child then unbumped ancestor: the ancestor set is epoch 0, its clear of the child keeps 1', () => {
    const got = scoped(
      'branch',
      [set(['a', 'x'], 4), true],
      [set(['a'], A), false],
    );
    expect(got.e2.map((o) => `${o.path}:${o.kind}:${o.epoch}`)).toEqual([
      'a:set:0',
      'a/x:clear:1',
    ]);
    expect(got.s1).toBeNull();
  });
  it('unbumped child then bumped ancestor: the bump lifts both the set and the clear', () => {
    const got = scoped(
      'branch',
      [set(['a', 'x'], 4), false],
      [set(['a'], A), true],
    );
    expect(got.e2.map((o) => `${o.path}:${o.kind}:${o.epoch}`)).toEqual([
      'a:set:1',
      'a/x:clear:1',
    ]);
  });
  it('bumped ancestor then unbumped child: the child cites nothing at its own path and stays epoch 0', () => {
    const got = scoped(
      'branch',
      [set(['a'], A), true],
      [set(['a', 'x'], 5), false],
    );
    expect(got.e1.map((o) => `${o.path}:${o.epoch}`)).toEqual(['a:1']);
    expect(got.e2).toEqual([{ path: 'a/x', kind: 'set', cites: [], epoch: 0 }]);
    expect(got.s1).toBeNull();
  });
});
