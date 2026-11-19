/**
 * MODEL: what a replica's store holds after it commits a fork against a stale frontier.
 * A design record of the rules considered, independent of the engine: it tests none of its code.
 *
 * A pure model in its own primitives (a number clock, string origins, its own folds, graft and drop
 * rule), independent of store, opLog and opSync. A replica holds per-path dot-citation registers and a
 * store. A plain write cites every live sibling at its path; a fork commit cites only the siblings that
 * were live at its captured frontier. Both expand into one clear per observed live descendant register.
 * A receiver moves its store by the materialization deltas of the registers whose fold result changed.
 *
 * Six rules for the committer's own store after a fork commit, compared:
 *  - rawThenChanged: write the raw ops, then apply the deltas of the registers whose result changed
 *  - before:  never write the raw ops; apply those deltas to the store as it was before the commit
 *  - compare: write the raw ops, then correct every touched path where the store differs from the
 *             materialization (set the materialized value, or remove down to the nearest shown region)
 *  - refined: as compare, but a path that does not show under a scalar region restores that region
 *  - whole:   write the raw ops, then replace the store with the whole materialization
 *  - inverse: write the raw ops, then apply their inverse batch and the deltas (the pre-commit value
 *             rebuilt by inversion instead of carried); a raw-flavor commit goes as `before`
 *
 * Contracts. C1: after every step, every replica's store deep-equals the materialization of its own
 * registers. C2: replicas holding the same envelope set hold equal stores, the committer included. C3:
 * C1 holds on a plain store-shaped write by the lone-sibling fold law (that such a write is applied raw
 * and never reconciled is how the model is built, not a checked law). C4: after a commit, every path
 * outside the lineage (ancestors, self, descendants) of the paths the envelope touched keeps its
 * reference; under `before` and `inverse`, a commit that changes no fold result keeps the store object
 * itself (C4-identity). C5: the reconcile emits nothing; in this model a structural check, since only
 * `mint` makes an envelope and no rule calls it twice.
 *
 * A plain write of raw ops no diff produced (the engine's `emitOps`) is applied either raw or
 * peer-style: the store moves from its value before the write by the deltas, like a receiver.
 *
 * NON-COVERAGE (what this model does not decide; each needs its own argument or the engine spec):
 *  - arrays, merge-policy folds (positional, keyedArray, mergeThree), `preserve` and conflict values.
 *    The folds here are last-writer-wins and a numeric max; both are pure functions of the live set
 *    and return a lone sibling unchanged.
 *  - vivification with no root register: every replica starts from one seeded root write.
 *  - the engine's receive version gate: the model delivers in any order, duplicates included; the
 *    engine drops a version at or below the known one, so its property delivers per origin in order.
 *  - hydrate, restore, snapshot, settle (GC), persisted floors, room generations, protocol versions.
 *  - the opLog: tick coalescing, the deferred outbox, EmitContext.root, flush ordering in commitScope.
 *  - fork staging by merge3: a "store" commit applies the fork's intended edit to the base as it is at
 *    commit time (what merge3 yields for an edit only the fork made; a path both edited keeps the fork's
 *    value, as merge3 does for a leaf).
 *  - the materialization rule itself (deepest-live-wins and the drop rule) is taken as given, from the
 *    engine's documentation and the tree proofs in precedence-proofs.spec.ts. C1 checks the store
 *    against it, never it against intent.
 *  - folds that break the lone-sibling law, dev-mode lints, several writers per origin.
 *  - nested commitScope. Bumped commits are generated; override scoping is not.
 *  - the per-origin sibling slot is modeled as the engine has it: a fork commit replaces its own
 *    origin's mid-flight write at the same path even though it did not cite it.
 */

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
type Mode =
  | 'rawThenChanged'
  | 'before'
  | 'compare'
  | 'refined'
  | 'whole'
  | 'inverse';
type Flavor = 'store' | 'raw';
type Reg = {
  readonly path: Path;
  readonly best: Map<string, Sib>;
  readonly water: Map<string, number>;
  readonly arrival: Map<string, number>;
};

const pk = (p: Path): string => p.join('/');
const isRec = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);
const has = (v: unknown, k: string): boolean => isRec(v) && Object.hasOwn(v, k);

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

// copy-on-write write along a path, vivifying missing or scalar containers as records
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
// numeric max among the top-epoch writes; a lone sibling folds to itself
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

const sameRes = (a: Res | undefined, b: Res | undefined): boolean =>
  a === b ||
  (!!a &&
    !!b &&
    a.kind === b.kind &&
    (a.kind !== 'set' || deepEq(a.value, (b as { value: unknown }).value)));

const isPrefix = (p: Path, q: Path): boolean =>
  p.length <= q.length && p.every((s, i) => q[i] === s);

class Replica {
  readonly regs = new Map<string, Reg>();
  readonly floors = new Map<string, number>();
  store: unknown = undefined;
  clock = 0;
  seq = 0;
  lastChanged: Path[] = [];
  constructor(
    readonly o: string,
    readonly mode: Mode,
  ) {}

  private reg(path: Path): Reg {
    let r = this.regs.get(pk(path));
    if (!r) {
      r = { path, best: new Map(), water: new Map(), arrival: new Map() };
      this.regs.set(pk(path), r);
    }
    return r;
  }
  live(r: Reg, frontier?: number): Sib[] {
    const out: Sib[] = [];
    for (const [o, s] of r.best) {
      if (s.t <= (r.water.get(o) ?? -1)) continue;
      if (frontier !== undefined && (r.arrival.get(o) ?? 0) > frontier)
        continue;
      out.push(s);
    }
    return out;
  }
  res(path: Path): Res | undefined {
    const r = this.regs.get(pk(path));
    const live = r ? this.live(r) : [];
    return live.length ? foldAt(path)(live) : undefined;
  }
  descendants(path: Path): Path[] {
    return [...this.regs.values()]
      .map((r) => r.path)
      .filter((p) => p.length > path.length && isPrefix(path, p))
      .sort((x, y) => x.length - y.length || (pk(x) < pk(y) ? -1 : 1));
  }

  // a value under `rel` of `v` materializes iff every segment but the last names a record
  private static graftable(v: unknown, rel: Path): boolean {
    let cur = v;
    for (let i = 0; i < rel.length - 1; i++) {
      if (!has(cur, rel[i])) return false;
      cur = (cur as Record<string, unknown>)[rel[i]];
    }
    return isRec(cur);
  }
  shows(path: Path): boolean {
    let holder: Path | undefined;
    let hres: Res | undefined;
    for (let len = 0; len < path.length; len++) {
      const p = path.slice(0, len);
      const r = this.res(p);
      if (!r || r.kind === 'clear') continue;
      if (holder && hres) {
        if (hres.kind !== 'set') return false;
        if (!Replica.graftable(hres.value, p.slice(holder.length)))
          return false;
      }
      holder = p;
      hres = r;
    }
    if (!holder || !hres) return true;
    return (
      hres.kind === 'set' &&
      Replica.graftable(hres.value, path.slice(holder.length))
    );
  }
  private static graft(tree: unknown, rel: Path, r: Res): unknown {
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
    if (!has(tree, head))
      return { ...tree, [head]: Replica.graft({}, rest, r) };
    const child = Replica.graft(tree[head], rest, r);
    return child === tree[head] ? tree : { ...tree, [head]: child };
  }
  materializeAt(path: Path): unknown {
    const r = this.res(path);
    let tree: unknown = r?.kind === 'set' ? r.value : undefined;
    for (const d of this.descendants(path)) {
      const rd = this.res(d);
      if (!rd || rd.kind === 'clear' || !this.shows(d)) continue;
      tree = Replica.graft(tree, d.slice(path.length), rd);
    }
    return tree;
  }
  materialize(): unknown {
    return this.materializeAt([]);
  }

  nearestContributing(path: Path): Path | undefined {
    for (let len = path.length - 1; len >= 0; len--) {
      const r = this.res(path.slice(0, len));
      if (r && r.kind !== 'clear') return path.slice(0, len);
    }
    return undefined;
  }
  /** The receive transformer: store ops for the registers whose fold result changed. */
  deltas(changed: readonly Path[]): Raw[] {
    const sorted = [...changed].sort(
      (x, y) => x.length - y.length || (pk(x) < pk(y) ? -1 : 1),
    );
    const out: Raw[] = [];
    const regions: Path[] = [];
    for (const path of sorted) {
      if (regions.some((r) => isPrefix(r, path))) continue;
      const r = this.res(path);
      if (!r || r.kind === 'clear') {
        if (!path.length) continue;
        const anc = this.nearestContributing(path);
        if (!anc || this.res(anc)?.kind !== 'set' || !this.shows(anc)) continue;
        out.push({ kind: 'set', path: anc, value: this.materializeAt(anc) });
        regions.push(anc);
        continue;
      }
      if (!this.shows(path)) continue;
      if (r.kind === 'delete') {
        if (!path.length) continue;
        out.push({ kind: 'delete', path });
      } else {
        out.push({ kind: 'set', path, value: this.materializeAt(path) });
      }
      regions.push(path);
    }
    return out;
  }

  /** Fold an envelope in; returns every touched path and the ones whose fold result changed. */
  ingest(env: MEnv, local: boolean): { touched: Path[]; changed: Path[] } {
    const seq = ++this.seq;
    this.clock = Math.max(this.clock, env.t);
    const before = new Map<string, Res | undefined>();
    const touched: Path[] = [];
    for (const op of env.ops) {
      const key = pk(op.path);
      if (!before.has(key)) {
        before.set(key, this.res(op.path));
        touched.push(op.path);
      }
      const r = this.reg(op.path);
      for (const c of op.cites) {
        if (c.o === env.o && c.t === env.t) continue;
        r.water.set(c.o, Math.max(r.water.get(c.o) ?? -1, c.t));
      }
      const cur = r.best.get(env.o);
      if (!cur || env.t > cur.t) {
        r.best.set(env.o, {
          o: env.o,
          t: env.t,
          kind: op.kind,
          value: op.value,
          epoch: op.epoch,
        });
        r.arrival.set(env.o, seq);
      }
      if (local && op.epoch > 0)
        this.floors.set(key, Math.max(this.floors.get(key) ?? 0, op.epoch));
    }
    const changed = touched.filter(
      (p) => !sameRes(before.get(pk(p)), this.res(p)),
    );
    return { touched, changed };
  }

  /** Cites the live siblings observed (as of `frontier` when given) and expands observed clears. */
  stamp(
    raws: readonly Raw[],
    frontier: number | undefined,
    bump: boolean,
  ): MOp[] {
    const out: MOp[] = [];
    const epochFor = (path: Path, live: readonly Sib[]): number =>
      Math.max(this.floors.get(pk(path)) ?? 0, ...live.map((s) => s.epoch)) +
      (bump ? 1 : 0);
    const liveAt = (path: Path): Sib[] => {
      const r = this.regs.get(pk(path));
      return r ? this.live(r, frontier) : [];
    };
    const dots = (live: readonly Sib[]): MDot[] =>
      live.map((s) => ({ o: s.o, t: s.t }));
    for (const raw of raws) {
      const live = liveAt(raw.path);
      out.push({ ...raw, cites: dots(live), epoch: epochFor(raw.path, live) });
      for (const d of this.descendants(raw.path)) {
        if (this.res(d)?.kind === 'clear') continue;
        const dl = liveAt(d);
        if (!dl.length) continue;
        out.push({
          path: d,
          kind: 'clear',
          cites: dots(dl),
          epoch: epochFor(d, dl),
        });
      }
    }
    return out;
  }

  private mint(
    raws: readonly Raw[],
    frontier: number | undefined,
    bump: boolean,
  ): MEnv {
    return {
      o: this.o,
      t: ++this.clock,
      ops: this.stamp(raws, frontier, bump),
    };
  }

  /** Store-shaped raw ops for intended edits, as a diff of the store would produce them. */
  shape(intents: readonly Raw[]): Raw[] {
    const out: Raw[] = [];
    for (const it of intents) {
      const here = lookup(this.store, it.path);
      if (it.kind === 'delete') {
        if (here.found && it.path.length) out.push(it);
        continue;
      }
      let lifted: Raw | undefined;
      for (let k = 1; k < it.path.length && !lifted; k++) {
        const at = lookup(this.store, it.path.slice(0, k));
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

  /** A plain local write (C3): store-shaped, cites everything live, applied raw by construction. */
  write(intents: readonly Raw[], bump = false): MEnv | undefined {
    const raws = this.shape(intents);
    if (!raws.length) return undefined;
    const env = this.mint(raws, undefined, bump);
    this.store = applyStore(this.store, raws);
    this.ingest(env, true);
    return env;
  }

  /** A fork commit against `frontier`, reconciled by this replica's mode. */
  commit(
    raws: readonly Raw[],
    frontier: number,
    bump = false,
    flavor: Flavor = 'store',
  ): MEnv | undefined {
    if (!raws.length) return undefined;
    const env = this.mint(raws, frontier, bump);
    const pre = this.store;
    if (
      this.mode === 'before' ||
      (this.mode === 'inverse' && flavor === 'raw')
    ) {
      const { changed } = this.ingest(env, true);
      this.lastChanged = changed;
      this.store = applyStore(pre, this.deltas(changed));
      return env;
    }
    const inverse: Raw[] = [];
    let cur = pre;
    for (const raw of raws) {
      const was = lookup(cur, raw.path);
      inverse.unshift(
        was.found
          ? { kind: 'set', path: raw.path, value: was.value }
          : { kind: 'delete', path: raw.path },
      );
      cur = writeAt(cur, raw.path, raw);
    }
    this.store = cur;
    const { touched, changed } = this.ingest(env, true);
    this.lastChanged = changed;
    if (this.mode === 'inverse')
      this.store = applyStore(
        applyStore(this.store, inverse),
        this.deltas(changed),
      );
    else if (this.mode === 'rawThenChanged')
      this.store = applyStore(this.store, this.deltas(changed));
    else if (this.mode === 'whole') this.store = this.materialize();
    else this.correct(touched);
    return env;
  }

  /** A plain write of raw ops that no store diff produced (the C3 boundary), raw or peer-style. */
  writeRaw(raws: readonly Raw[], peer = false, bump = false): MEnv {
    const env = this.mint(raws, undefined, bump);
    const pre = this.store;
    if (!peer) this.store = applyStore(pre, raws);
    const { changed } = this.ingest(env, true);
    this.lastChanged = changed;
    if (peer) this.store = applyStore(pre, this.deltas(changed));
    return env;
  }

  private correct(touched: readonly Path[]): void {
    const m = this.materialize();
    const sorted = [...touched].sort((x, y) => x.length - y.length);
    for (const p of sorted) {
      const want = lookup(m, p);
      const have = lookup(this.store, p);
      if (want.found) {
        if (!have.found || !deepEq(have.value, want.value))
          this.store = writeAt(this.store, p, {
            kind: 'set',
            value: want.value,
          });
        continue;
      }
      let k = 0;
      while (k < p.length && lookup(m, p.slice(0, k + 1)).found) k++;
      const region = lookup(m, p.slice(0, k)).value;
      if (this.mode === 'refined' && !isRec(region)) {
        this.store = writeAt(this.store, p.slice(0, k), {
          kind: 'set',
          value: region,
        });
        continue;
      }
      const q = p.slice(0, k + 1);
      if (lookup(this.store, q).found)
        this.store = writeAt(this.store, q, { kind: 'delete' });
    }
  }

  receive(env: MEnv): void {
    const { changed } = this.ingest(env, false);
    this.store = applyStore(this.store, this.deltas(changed));
  }

  c1(): boolean {
    return deepEq(this.store, this.materialize());
  }
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

type Fork = { readonly r: number; seq: number };
type Violation = { seed: number; step: number; law: string; at: string };

class World {
  readonly reps: Replica[];
  readonly envs: MEnv[] = [];
  readonly got: Set<number>[];
  readonly forks: Fork[] = [];
  constructor(mode: Mode, n = 3) {
    this.reps = Array.from({ length: n }, (_, i) => {
      const r = new Replica('r' + i, mode);
      r.store = {};
      r.receive(SEED);
      return r;
    });
    this.got = this.reps.map(() => new Set<number>());
  }
  private keep(r: number, env: MEnv | undefined): MEnv | undefined {
    if (!env) return undefined;
    this.got[r].add(this.envs.push(env) - 1);
    return env;
  }
  write(r: number, intents: readonly Raw[], bump = false): MEnv | undefined {
    return this.keep(r, this.reps[r].write(intents, bump));
  }
  writeRaw(r: number, raws: readonly Raw[], peer = false, bump = false): MEnv {
    return this.keep(r, this.reps[r].writeRaw(raws, peer, bump)) as MEnv;
  }
  fork(r: number): Fork {
    const f = { r, seq: this.reps[r].seq };
    this.forks.push(f);
    return f;
  }
  rebase(f: Fork): void {
    f.seq = this.reps[f.r].seq;
  }
  commit(f: Fork, intents: readonly Raw[], flavor: Flavor, bump = false) {
    const rep = this.reps[f.r];
    const raws = flavor === 'store' ? rep.shape(intents) : intents;
    return this.keep(f.r, rep.commit(raws, f.seq, bump, flavor));
  }
  deliver(r: number, idx: number): void {
    this.reps[r].receive(this.envs[idx]);
    this.got[r].add(idx);
  }
  deliverAll(): void {
    this.reps.forEach((_, r) =>
      this.envs.forEach((_, i) => this.got[r].has(i) || this.deliver(r, i)),
    );
  }
}

const n = (rng: () => number): number => 1 + Math.floor(rng() * 9);
function valueFor(path: Path, rng: () => number): unknown {
  const k = pk(path);
  if (k === '') {
    const v: Record<string, unknown> = {};
    if (rng() < 0.7) v['a'] = { x: n(rng), y: n(rng) };
    if (rng() < 0.7) v['b'] = { m: n(rng) };
    if (rng() < 0.7) v['m'] = n(rng);
    return v;
  }
  if (k === 'a')
    return rng() < 0.1
      ? n(rng)
      : rng() < 0.5
        ? { x: n(rng) }
        : { x: n(rng), y: n(rng) };
  if (k === 'b') return { m: n(rng) };
  return n(rng);
}
function intentsFor(rng: () => number): Raw[] {
  const one = (pool: readonly Path[]): Raw => {
    const path = pool[Math.floor(rng() * pool.length)];
    return path.length && rng() < 0.2
      ? { kind: 'delete', path }
      : { kind: 'set', path, value: valueFor(path, rng) };
  };
  const first = one(PATHS);
  if (!first.path.length || rng() < 0.7) return [first];
  return [first, one(PATHS.filter((p) => p.length && p[0] !== first.path[0]))];
}

/** Paths a commit may legitimately re-reference: the lineage of each touched path and of each
 *  region a clear re-materializes. Everything else must keep its reference (C4). */
function reach(rep: Replica, touched: readonly Path[]): Path[] {
  const roots: Path[] = [];
  for (const t of touched) {
    roots.push(t);
    const r = rep.res(t);
    if (!r || r.kind === 'clear') {
      const anc = rep.nearestContributing(t);
      if (anc) roots.push(anc);
    }
  }
  return roots;
}
function keptRefs(
  rep: Replica,
  before: unknown,
  touched: readonly Path[],
): string | null {
  const roots = reach(rep, touched);
  for (const p of PATHS) {
    if (roots.some((r) => isPrefix(r, p) || isPrefix(p, r))) continue;
    const b = lookup(before, p);
    const a = lookup(rep.store, p);
    if (b.found && a.found && isRec(b.value) && b.value !== a.value)
      return pk(p);
  }
  return null;
}

/** One random interleaving; returns the first law broken, or null. */
function run(
  mode: Mode,
  seed: number,
  opt: { steps?: number; forks?: boolean; rawWrites?: boolean } = {},
): Violation | null {
  const rng = rngOf(seed);
  const w = new World(mode);
  const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rng() * xs.length)];
  const fail = (step: number, law: string, at: string): Violation => ({
    seed,
    step,
    law,
    at,
  });
  const forks = opt.forks ?? true;
  for (let step = 0; step < (opt.steps ?? 40); step++) {
    const r = Math.floor(rng() * w.reps.length);
    const roll = rng();
    const emitted = w.envs.length;
    if (roll < 0.25) {
      w.write(r, intentsFor(rng), rng() < 0.15);
    } else if (forks && roll < 0.35) {
      w.fork(r);
    } else if (forks && roll < 0.42 && w.forks.length) {
      w.rebase(pick(w.forks));
    } else if (forks && roll < 0.6 && w.forks.length) {
      const f = pick(w.forks);
      const rep = w.reps[f.r];
      const before = rep.store;
      const env = w.commit(
        f,
        intentsFor(rng),
        rng() < 0.6 ? 'store' : 'raw',
        rng() < 0.1,
      );
      if (env) {
        const touched = env.ops.map((o) => o.path);
        const lost = keptRefs(rep, before, touched);
        if (lost !== null) return fail(step, 'C4', `${rep.o}:${lost}`);
        if (
          (mode === 'before' || mode === 'inverse') &&
          !rep.lastChanged.length &&
          rep.store !== before
        )
          return fail(step, 'C4-identity', rep.o);
      }
    } else if (opt.rawWrites && roll < 0.7) {
      // a plain write of raw ops, peer-style: the engine's emitOps re-authoring a recorded intent
      const rep = w.reps[r];
      const before = rep.store;
      const env = w.writeRaw(r, intentsFor(rng), true, rng() < 0.15);
      const lost = keptRefs(
        rep,
        before,
        env.ops.map((o) => o.path),
      );
      if (lost !== null) return fail(step, 'C4', `${rep.o}:${lost}`);
      if (!rep.lastChanged.length && rep.store !== before)
        return fail(step, 'C4-identity', rep.o);
    } else {
      const missing = w.envs.map((_, i) => i).filter((i) => !w.got[r].has(i));
      if (missing.length) w.deliver(r, pick(missing));
      else if (w.envs.length) w.deliver(r, Math.floor(rng() * w.envs.length));
    }
    if (w.envs.length - emitted > 1)
      return fail(step, 'C5', 'more than one envelope');
    for (const rep of w.reps) if (!rep.c1()) return fail(step, 'C1', rep.o);
  }
  w.deliverAll();
  for (const rep of w.reps) if (!rep.c1()) return fail(-1, 'C1', rep.o);
  const fresh = new Replica('fresh', mode);
  fresh.store = {};
  fresh.receive(SEED);
  for (const env of [...w.envs].reverse()) fresh.receive(env);
  for (const rep of w.reps)
    if (!deepEq(rep.store, fresh.store)) return fail(-1, 'C2', rep.o);
  return null;
}
const sweep = (
  mode: Mode,
  seeds: number,
  opt?: { steps?: number; forks?: boolean; rawWrites?: boolean },
) => {
  const out: Violation[] = [];
  for (let s = 1; s <= seeds; s++) {
    const v = run(mode, s * 7919, opt);
    if (v) out.push(v);
  }
  return out;
};

const MODES: Mode[] = [
  'rawThenChanged',
  'before',
  'compare',
  'refined',
  'whole',
  'inverse',
];
const set = (path: Path, value: unknown): Raw => ({ kind: 'set', path, value });
const del = (path: Path): Raw => ({ kind: 'delete', path });

describe('MODEL fork commit: the control (no fork commits)', () => {
  it('C1 and C2 hold under plain writes, bumps and any delivery order, duplicates included', () => {
    for (const mode of MODES)
      expect(sweep(mode, 150, { forks: false })).toEqual([]);
  });

  it('C3 boundary: a plain write of raw ops no diff produced breaks C1 applied raw, keeps it peer-style', () => {
    // C1 on the raw-applied plain path rests on store-shaped writes: a child write under a parent the
    // store does not hold lands vivified while its register does not show. Peer-style, the store stays.
    const script = (peer: boolean) => {
      const w = new World('before', 2);
      w.write(1, [del(['a'])]);
      w.deliver(0, 0);
      const before = w.reps[0].store;
      w.writeRaw(0, [set(['a', 'x'], 2)], peer);
      return { w, before };
    };
    const raw = script(false).w;
    expect(raw.reps[0].store).toEqual({ b: { m: 0 }, m: 0, a: { x: 2 } });
    expect(raw.reps[0].materialize()).toEqual({ b: { m: 0 }, m: 0 });
    expect(raw.reps[0].c1()).toBe(false);
    const { w: peer, before } = script(true);
    expect(peer.reps[0].store).toBe(before);
    expect(peer.reps[0].c1()).toBe(true);
    peer.deliverAll();
    expect(peer.reps[0].store).toEqual(peer.reps[1].store);
  });
});

describe('MODEL fork commit: pinned counterexamples to raw-then-changed', () => {
  const cases: Record<string, (w: World) => void> = {
    // (a) a fold that is not last-writer-wins keeps its result: the register stays 9
    '(a) max fold, commit of a lower value': (w) => {
      const f = w.fork(0);
      w.write(1, [set(['m'], 9)]);
      w.deliver(0, 0);
      w.commit(f, [set(['m'], 3)], 'store');
    },
    // (a) the same under last-writer-wins: a concurrent bumped write outranks the commit's epoch
    '(a) lww, concurrent bumped write': (w) => {
      const f = w.fork(0);
      w.write(1, [set(['a', 'x'], 9)], true);
      w.deliver(0, 0);
      w.commit(f, [set(['a', 'x'], 3)], 'store');
    },
    // (b) a child edit under a parent a write the fork never observed deleted
    '(b) raw child edit under a concurrently deleted parent': (w) => {
      const f = w.fork(0);
      w.write(1, [del(['a'])]);
      w.deliver(0, 0);
      w.commit(f, [set(['a', 'x'], 2)], 'raw');
    },
    // (b) through a store diff: the edit lifts to the parent, which loses to a bumped delete
    '(b) store-shaped edit lifted onto a parent a bumped delete removed': (
      w,
    ) => {
      const f = w.fork(0);
      w.write(1, [del(['a'])], true);
      w.deliver(0, 0);
      w.commit(f, [set(['a', 'x'], 2)], 'store');
    },
  };
  for (const [name, script] of Object.entries(cases)) {
    it(`${name}: RED on C1 under raw-then-changed; every other rule keeps C1 and C2`, () => {
      for (const mode of MODES) {
        const w = new World(mode, 2);
        script(w);
        expect({ mode, c1: w.reps[0].c1() }).toEqual({
          mode,
          c1: mode !== 'rawThenChanged',
        });
        w.deliverAll();
        if (mode !== 'rawThenChanged')
          expect(w.reps[0].store).toEqual(w.reps[1].store);
        else expect(w.reps[0].store).not.toEqual(w.reps[1].store);
      }
    });
  }

  it('the max case pinned by value: the committer shows 3 while its register and every peer hold 9', () => {
    const w = new World('rawThenChanged', 2);
    cases['(a) max fold, commit of a lower value'](w);
    w.deliverAll();
    expect(lookup(w.reps[0].store, ['m']).value).toBe(3);
    expect(lookup(w.reps[0].materialize(), ['m']).value).toBe(9);
    expect(lookup(w.reps[1].store, ['m']).value).toBe(9);
  });
});

describe('MODEL fork commit: properties over random interleavings', () => {
  // plain writes, bumps, fork captures, rebases and discards (a recapture here), store-shaped and raw
  // commits, bumped commits, deliveries in any order, duplicates; three replicas
  const SEEDS = 300;

  it('raw-then-changed breaks C1 on the committer (the generator reaches the bug)', () => {
    const found = sweep('rawThenChanged', SEEDS);
    expect(found.length).toBeGreaterThan(0);
    expect(found.every((v) => v.law === 'C1' || v.law === 'C2')).toBe(true);
  });

  it('before (never write the raw ops): C1 every step, C2 at quiescence, C4 with identity, C5 (structural)', () => {
    expect(sweep('before', SEEDS)).toEqual([]);
  });

  it('before, with peer-style plain writes of raw ops mixed in: C1, C2, C4 with identity, C5 (structural)', () => {
    expect(sweep('before', SEEDS, { rawWrites: true })).toEqual([]);
  });

  it('inverse (rebuild the pre-commit value by inversion): values right, root identity lost', () => {
    const found = sweep('inverse', SEEDS);
    expect(found.length).toBeGreaterThan(0);
    expect(found.every((v) => v.law === 'C4-identity')).toBe(true);
  });

  it('pinned: inverse replaces the root object on a commit that changes no fold result', () => {
    const script = (mode: Mode) => {
      const w = new World(mode, 2);
      const f = w.fork(0);
      w.write(1, [set(['a', 'x'], 9)], true);
      w.deliver(0, 0);
      const before = w.reps[0].store;
      w.commit(f, [set(['a', 'x'], 3)], 'store');
      return { rep: w.reps[0], before };
    };
    const inv = script('inverse');
    expect(inv.rep.lastChanged).toEqual([]);
    expect(inv.rep.c1()).toBe(true);
    expect(inv.rep.store).toEqual(inv.before);
    expect(inv.rep.store).not.toBe(inv.before);
    expect(lookup(inv.rep.store, ['a']).value).not.toBe(
      lookup(inv.before, ['a']).value,
    );
    const bef = script('before');
    expect(bef.rep.store).toBe(bef.before);
  });

  it('compare as first drafted (remove a path that does not show) breaks C1', () => {
    const found = sweep('compare', SEEDS);
    expect(found.length).toBeGreaterThan(0);
    expect(found.every((v) => v.law === 'C1')).toBe(true);
  });

  it('pinned: removing a child does not restore the scalar parent the raw write replaced', () => {
    // the store holds `a: 5`; a raw child write vivifies `a: { x: 2 }` over it; `a.x` does not show,
    // and removing it leaves `a: {}` where the register still holds 5
    const script = (mode: Mode) => {
      const w = new World(mode, 2);
      w.write(0, [set(['a'], 5)]);
      w.commit(w.fork(0), [set(['a', 'x'], 2)], 'raw');
      return w.reps[0];
    };
    expect(lookup(script('compare').store, ['a']).value).toEqual({});
    expect(script('compare').c1()).toBe(false);
    for (const mode of ['before', 'refined', 'whole'] as const)
      expect(script(mode).c1()).toBe(true);
    expect(script('rawThenChanged').c1()).toBe(false);
  });

  it('refined compare (restore a scalar region): C1, C2, C4, C5 (structural)', () => {
    expect(sweep('refined', SEEDS)).toEqual([]);
  });

  it('whole (re-materialize the root): C1 holds but C4 breaks', () => {
    const found = sweep('whole', SEEDS);
    expect(found.length).toBeGreaterThan(0);
    expect(found.every((v) => v.law === 'C4')).toBe(true);
  });

  it('pinned: a whole re-materialization replaces an untouched subtree that holds a register', () => {
    const w = new World('whole', 2);
    w.write(0, [set(['b', 'm'], 4)]);
    const f = w.fork(0);
    const before = w.reps[0].store;
    w.commit(f, [set(['m'], 5)], 'store');
    expect(lookup(w.reps[0].store, ['b']).value).toEqual(
      lookup(before, ['b']).value,
    );
    expect(lookup(w.reps[0].store, ['b']).value).not.toBe(
      lookup(before, ['b']).value,
    );
  });

  it('pinned: before keeps the very store object when the commit changes no fold result', () => {
    const w = new World('before', 2);
    const f = w.fork(0);
    w.write(1, [set(['m'], 9)]);
    w.deliver(0, 0);
    const before = w.reps[0].store;
    w.commit(f, [set(['m'], 3)], 'store');
    expect(w.reps[0].store).toBe(before);
  });
});
