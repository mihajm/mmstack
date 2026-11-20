/**
 * MODEL: one local write as a well-formed batch of authored ops, stamped into one envelope with at
 * most one op per path. A design record independent of the engine: it tests none of its code.
 *
 * A pure model in its own primitives (a number clock, string origins, its own registers, folds,
 * materialization and store). A batch [o1..on] of `set`, `delete` and `clear` ops is one write: one
 * envelope, one bump, every op stamped against the view before the batch. Today's stamp gives each
 * authored op the live dots at its path, and each `set` or `delete` a clear for every descendant
 * register with live dots whose fold result is not a clear.
 *
 * Well-formed, by contract (anything else is refused, and the refusal changes nothing):
 *  W1 each path appears at most once ('dup-path');
 *  W2 an op sits strictly under another op's path only when that other op is an EARLIER `set` whose
 *     value is a plain record ('nested-path').
 * The stamp of a well-formed batch is today's stamp with two rules on top:
 *  R1 generated clears for one path merge into one; the first occurrence stays in place;
 *  R2 a generated clear yields to an authored op at its path; the authored op stays where it is.
 * No authored op is dropped or moved; epochs are today's.
 *
 * Laws.
 *  E1 validity: a stamped well-formed batch has one op per path.
 *  E2 supersession: every dot today's stamp would cite at a path is cited by the op at that path; no
 *     op cites a dot outside the live dots of the view at its path; no op lands on a path today's
 *     stamp does not touch.
 *  EP authority: every op's epoch equals today's epoch at its path (one bump per write).
 *  E3 store consistency, qualified: for set/delete ops under records, written while the writer
 *     observes everything it holds (folds here are lawful: a lone sibling folds to itself), the
 *     writer's registers materialize to the batch applied to the store before it; a receiver that
 *     held the same envelopes ends at the same. Outside that domain (scoped or raw emissions that can
 *     lose a fold) the law is S5.
 *  E4 convergence: after full delivery in any cross-origin order, every store equals the
 *     materialization of all envelopes.
 *  E5 unchanged: a well-formed batch that needs neither R1 nor R2 stamps to today's envelope, order
 *     included.
 *  E6 commit scope: E1, E2, E4 and the qualified E3 under scoped emissions that observe the scope's
 *     frontier plus their own dots minted since entry, several emissions per scope.
 *  E7 order: the envelope is an order-preserving subsequence of today's stamp that keeps every
 *     authored op.
 *  W refusal: each ill-formed shape is refused with its reason, and the refused replica is untouched.
 *  S5 after every step, every store equals the materialization of its own registers.
 *
 * NON-COVERAGE (what this model does not decide; each needs its own argument or the engine spec):
 *  - `prev` (inversion basis, merge-fold ancestor) and `replace` handling: ops here carry no `prev`;
 *    the rule keeps today's per op, which no op of a well-formed batch shares with another.
 *  - arrays (keyed or unit), opaque values, merge-policy folds, `preserve`, conflict values. Folds
 *    here are last-writer-wins and a numeric max at `m` and `b.m`.
 *  - the engine's diff and its options: the diff generator here is a record-only diff with whole or
 *    leaves adds; the engine's diff contract is checked in the engine spec.
 *  - where the refusal happens in the engine (before the flush of pending writes): the model
 *    replica has no pending writes.
 *  - the per-origin sibling slot inside a scope, scopes nested in scopes, asynchronous scope bodies.
 *  - the engine's epoch floors and frontier encoding; inside a scope the engine's clear skip reads
 *    the replica's full fold result, here the observed view.
 *  - the opLog, outbox, flush timing, hydrate, restore, snapshot, settle, room generations.
 *  - the materialization rule (deepest-live-wins and the drop rule) and the fork-commit `before` store
 *    rule for scoped and raw emissions, taken as given.
 *  - which occurrence R1 keeps: no law here tells first from last; a row pins first.
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
type AOp = {
  readonly path: Path;
  readonly kind: OpKind;
  readonly value?: unknown;
};
type Raw = {
  readonly path: Path;
  readonly kind: 'set' | 'delete';
  readonly value?: unknown;
};
type View = { live(path: Path): readonly Sib[]; paths(): readonly Path[] };

const pk = (p: Path): string => p.join('/');
const isRec = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);
const has = (v: unknown, k: string): boolean => isRec(v) && Object.hasOwn(v, k);
const isPrefix = (p: Path, q: Path): boolean =>
  p.length <= q.length && p.every((s, i) => q[i] === s);
const strictUnder = (anc: Path, p: Path): boolean =>
  anc.length < p.length && isPrefix(anc, p);
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
  op: { kind: OpKind; value?: unknown },
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

/** set and delete only, each under a record of the running store: a batch a store write can mean */
function storeConsistent(
  pre: unknown,
  batch: readonly AOp[],
): batch is readonly Raw[] {
  let cur = pre;
  for (const a of batch) {
    if (a.kind === 'clear') return false;
    if (!a.path.length) {
      if (a.kind === 'delete') return false;
    } else {
      const parent = lookup(cur, a.path.slice(0, -1));
      if (!parent.found || !isRec(parent.value)) return false;
    }
    cur = writeAt(cur, a.path, a);
  }
  return true;
}

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
    .filter((p) => strictUnder(path, p))
    .sort(byDepth);
const dotsOf = (live: readonly Sib[]): MDot[] =>
  live.map((s) => ({ o: s.o, t: s.t }));
const dotKey = (d: MDot): string => `${d.o}@${d.t}`;

/** Registers built incrementally, one envelope at a time: what a replica holds. */
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

function frozen(v: View): View {
  const paths = [...v.paths()];
  const live = new Map(paths.map((p) => [pk(p), [...v.live(p)]]));
  return { paths: () => paths, live: (p) => live.get(pk(p)) ?? [] };
}

type Ctx = {
  readonly view: View;
  readonly floor: (p: Path) => number;
  readonly bump: boolean;
};
const epochAt = (c: Ctx, p: Path): number =>
  Math.max(c.floor(p), ...c.view.live(p).map((s) => s.epoch)) +
  (c.bump ? 1 : 0);
const opAt = (c: Ctx, path: Path, kind: OpKind, value?: unknown): MOp => {
  const cites = dotsOf(c.view.live(path));
  const epoch = epochAt(c, path);
  return kind === 'set'
    ? { path, kind, value, cites, epoch }
    : { path, kind, cites, epoch };
};
const clearsUnder = (c: Ctx, path: Path): Path[] =>
  descendants(c.view, path).filter(
    (d) => c.view.live(d).length > 0 && resOf(c.view, d)?.kind !== 'clear',
  );

type Tagged = {
  readonly op: MOp;
  readonly from: number;
  readonly authored: boolean;
};
function tagged(c: Ctx, batch: readonly AOp[]): Tagged[] {
  const out: Tagged[] = [];
  batch.forEach((a, i) => {
    out.push({ op: opAt(c, a.path, a.kind, a.value), from: i, authored: true });
    if (a.kind === 'clear') return;
    for (const d of clearsUnder(c, a.path))
      out.push({ op: opAt(c, d, 'clear'), from: i, authored: false });
  });
  return out;
}
/** Today's stamp: every authored op and every generated clear, in order. */
const stampPlain = (c: Ctx, batch: readonly AOp[]): MOp[] =>
  tagged(c, batch).map((e) => e.op);

type Reason = 'dup-path' | 'nested-path';
type Variant =
  | 'rule'
  | 'today'
  | 'noMerge'
  | 'noYield'
  | 'noW1'
  | 'noW2'
  | 'moved'
  | 'invent'
  | 'bumpTwice'
  | 'yieldNoBump'
  | 'mergeLast'
  | 'normalize'
  | 'firstWins'
  | 'split';
const REFUSING = new Set<Variant>([
  'rule',
  'noMerge',
  'noYield',
  'noW1',
  'noW2',
  'moved',
  'invent',
  'bumpTwice',
  'yieldNoBump',
  'mergeLast',
]);

function wellFormed(
  batch: readonly AOp[],
  variant: Variant = 'rule',
): Reason | null {
  if (variant !== 'noW1') {
    const seen = new Set<string>();
    for (const a of batch) {
      if (seen.has(pk(a.path))) return 'dup-path';
      seen.add(pk(a.path));
    }
  }
  if (variant !== 'noW2')
    for (let i = 0; i < batch.length; i++)
      for (let j = 0; j < batch.length; j++) {
        const anc = batch[j];
        if (!strictUnder(anc.path, batch[i].path)) continue;
        if (!(j < i && anc.kind === 'set' && isRec(anc.value)))
          return 'nested-path';
      }
  return null;
}

/** Round one's normalization: the last op at a path stands unless a later set or delete at a strict ancestor follows. */
function normalize(c: Ctx, batch: readonly AOp[], first: boolean): MOp[] {
  const seq = tagged(c, batch);
  const killed = (i: number): boolean =>
    batch.some(
      (b, j) =>
        j > i && b.kind !== 'clear' && strictUnder(b.path, batch[i].path),
    );
  const chosen = new Map<string, number>();
  batch.forEach((a, i) => {
    if (!first || !chosen.has(pk(a.path))) chosen.set(pk(a.path), i);
  });
  const stands = (i: number): boolean =>
    chosen.get(pk(batch[i].path)) === i && !killed(i);
  const out: MOp[] = [];
  const done = new Set<string>();
  for (const e of seq) {
    const q = pk(e.op.path);
    if (done.has(q)) continue;
    done.add(q);
    const here = seq.filter((x) => pk(x.op.path) === q);
    const auth = here.find((x) => x.authored && stands(x.from));
    if (auth) out.push(auth.op);
    else if (here.some((x) => !x.authored) || c.view.live(e.op.path).length)
      out.push(opAt(c, e.op.path, 'clear'));
  }
  return out;
}

function stampBatch(c: Ctx, batch: readonly AOp[], variant: Variant): MOp[] {
  if (variant === 'normalize' || variant === 'firstWins')
    return normalize(c, batch, variant === 'firstWins');
  const seq = tagged(c, batch);
  if (variant === 'today' || variant === 'split') return seq.map((e) => e.op);
  const authoredAt = new Set(
    seq.filter((e) => e.authored).map((e) => pk(e.op.path)),
  );
  const kept: Tagged[] = [];
  seq.forEach((e, i) => {
    if (e.authored) return void kept.push(e);
    const q = pk(e.op.path);
    if (authoredAt.has(q) && variant !== 'noYield') return;
    if (variant === 'noMerge') return void kept.push(e);
    const others = seq.filter(
      (x, j) => !x.authored && pk(x.op.path) === q && j !== i,
    );
    const firstIdx = seq.findIndex((x) => !x.authored && pk(x.op.path) === q);
    const lastIdx =
      seq.length -
      1 -
      [...seq].reverse().findIndex((x) => !x.authored && pk(x.op.path) === q);
    if (!others.length || i === (variant === 'mergeLast' ? lastIdx : firstIdx))
      kept.push(e);
  });
  let out = kept.map((e) => e.op);
  if (variant === 'moved') {
    const ops: MOp[] = [];
    const yielded = new Set(
      seq
        .filter((e) => !e.authored && authoredAt.has(pk(e.op.path)))
        .map((e) => pk(e.op.path)),
    );
    const placed = new Set<string>();
    for (const e of seq) {
      const q = pk(e.op.path);
      if (e.authored && yielded.has(q)) continue;
      if (!e.authored && yielded.has(q)) {
        if (placed.has(q)) continue;
        placed.add(q);
        ops.push(
          (seq.find((x) => x.authored && pk(x.op.path) === q) as Tagged).op,
        );
        continue;
      }
      if (kept.includes(e)) ops.push(e.op);
    }
    out = ops;
  }
  if (variant === 'bumpTwice' && c.bump)
    out = out.map((op) => ({ ...op, epoch: op.epoch + 1 }));
  if (variant === 'yieldNoBump' && c.bump) {
    const yielded = new Set(
      seq
        .filter((e) => !e.authored && authoredAt.has(pk(e.op.path)))
        .map((e) => pk(e.op.path)),
    );
    out = out.map((op) =>
      yielded.has(pk(op.path)) ? { ...op, epoch: op.epoch - 1 } : op,
    );
  }
  if (variant === 'invent') {
    const touched = new Set(out.map((op) => pk(op.path)));
    const extra = batch.find(
      (a) => a.path.length && !touched.has(pk(a.path.slice(0, -1))),
    );
    if (extra) out = [...out, opAt(c, extra.path.slice(0, -1), 'clear')];
  }
  return out;
}

const onePerPath = (ops: readonly MOp[]): boolean =>
  new Set(ops.map((op) => pk(op.path))).size === ops.length;

function sameOp(x: MOp, y: MOp): boolean {
  return (
    pk(x.path) === pk(y.path) &&
    x.kind === y.kind &&
    deepEq(x.value, y.value) &&
    x.epoch === y.epoch &&
    x.cites.map(dotKey).sort().join(',') ===
      y.cites.map(dotKey).sort().join(',')
  );
}
const sameOps = (a: readonly MOp[], b: readonly MOp[]): boolean =>
  a.length === b.length && a.every((x, i) => sameOp(x, b[i]));

/** E7: `got` is `today` with entries removed, in order, keeping every authored entry. */
function subsequence(today: readonly Tagged[], got: readonly MOp[]): boolean {
  const fit = (t: number, g: number): boolean => {
    if (t === today.length) return g === got.length;
    if (g < got.length && sameOp(today[t].op, got[g]) && fit(t + 1, g + 1))
      return true;
    return !today[t].authored && fit(t + 1, g);
  };
  return fit(0, 0);
}

type Shape =
  | 'diffWhole'
  | 'diffLeaves'
  | 'leaves'
  | 'mergeFired'
  | 'yieldFired'
  | 'bothFired'
  | 'refusedDup'
  | 'refusedNested'
  | 'bumpOn'
  | 'bumpOff'
  | 'peerAt'
  | 'peerBelow'
  | 'peerAbove'
  | 'maxFold'
  | 'scopeOwnObserved'
  | 'scopeUnobserved'
  | 'syncedReceivers';

function shapesOf(c: Ctx, batch: readonly AOp[], own: string): Shape[] {
  const out: Shape[] = [c.bump ? 'bumpOn' : 'bumpOff'];
  const seq = tagged(c, batch);
  const authoredAt = new Set(batch.map((a) => pk(a.path)));
  const gens = seq.filter((e) => !e.authored).map((e) => pk(e.op.path));
  const merge = gens.some(
    (q, i) => !authoredAt.has(q) && gens.indexOf(q) !== i,
  );
  const yieldIt = gens.some((q) => authoredAt.has(q));
  if (merge) out.push('mergeFired');
  if (yieldIt) out.push('yieldFired');
  if (merge && yieldIt) out.push('bothFired');
  for (const a of batch) {
    if (MAX_PATHS.has(pk(a.path))) out.push('maxFold');
    for (const q of c.view.paths()) {
      if (!c.view.live(q).some((s) => s.o !== own && s.o !== 's')) continue;
      if (pk(q) === pk(a.path)) out.push('peerAt');
      else if (strictUnder(a.path, q)) out.push('peerBelow');
      else if (strictUnder(q, a.path)) out.push('peerAbove');
    }
  }
  return out;
}

type Logged = { readonly env: MEnv; readonly seq: number };
type Frame = { readonly F: number; readonly entry: number };
type Flavor = 'store' | 'emit';
type Written =
  | { readonly refused: Reason; readonly envs?: undefined }
  | {
      readonly refused?: undefined;
      readonly envs: readonly MEnv[];
      readonly plain: readonly Tagged[];
      readonly ctx: Ctx;
      readonly pre: unknown;
      readonly all: boolean;
    };

class Replica {
  readonly table = new Table();
  readonly floors = new Map<string, number>();
  readonly log: Logged[] = [];
  store: unknown = {};
  clock = 0;
  seq = 0;
  frame: Frame | undefined;
  constructor(
    readonly o: string,
    readonly variant: Variant,
  ) {}
  ingest(env: MEnv): void {
    this.clock = Math.max(this.clock, env.t);
    this.table.ingest(env);
    this.log.push({ env, seq: ++this.seq });
    if (env.o !== this.o) return;
    for (const op of env.ops)
      if (op.epoch > (this.floors.get(pk(op.path)) ?? 0))
        this.floors.set(pk(op.path), op.epoch);
  }
  private keeps(f: Frame, e: Logged): boolean {
    return e.seq <= f.F || (e.env.o === this.o && e.seq > f.entry);
  }
  observed(): MEnv[] {
    const f = this.frame;
    return f
      ? this.log.filter((e) => this.keeps(f, e)).map((e) => e.env)
      : this.log.map((e) => e.env);
  }
  observesAll(): boolean {
    const f = this.frame;
    return !f || this.log.every((e) => this.keeps(f, e));
  }
  ctx(bump: boolean): Ctx {
    if (!this.frame) {
      const floors = new Map(this.floors);
      return {
        view: frozen(this.table),
        floor: (p) => floors.get(pk(p)) ?? 0,
        bump,
      };
    }
    const seen = this.observed();
    const view = viewOf(seen);
    const floor = (p: Path): number =>
      Math.max(
        0,
        ...seen
          .filter((e) => e.o === this.o)
          .flatMap((e) => e.ops)
          .filter((op) => pk(op.path) === pk(p))
          .map((op) => op.epoch),
      );
    return { view, floor, bump };
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
    const changed = this.absorb(env);
    this.store = applyStore(this.store, deltas(this.table, changed));
  }
  capture(): number {
    return this.seq;
  }
  enter(F: number): void {
    this.frame = { F, entry: this.seq };
  }
  exit(): void {
    this.frame = undefined;
  }
  fingerprint(): string {
    return JSON.stringify([
      this.log.length,
      this.seq,
      this.clock,
      [...this.floors],
      this.store,
      materialize(this.table),
    ]);
  }
  write(batch: readonly AOp[], bump: boolean, flavor: Flavor): Written {
    if (REFUSING.has(this.variant)) {
      const reason = wellFormed(batch, this.variant);
      if (reason) return { refused: reason };
    }
    const pre = this.store;
    const ctx = this.ctx(bump);
    const plain = tagged(ctx, batch);
    const all = this.observesAll();
    const envs: MEnv[] = [];
    const changed: Path[] = [];
    const emit = (part: readonly AOp[], c: Ctx) => {
      const env: MEnv = {
        o: this.o,
        t: this.clock + 1,
        ops: stampBatch(c, part, this.variant),
      };
      envs.push(env);
      changed.push(...this.absorb(env));
    };
    if (this.variant !== 'split') emit(batch, ctx);
    else {
      let cur: AOp[] = [];
      for (const a of batch) {
        if (
          cur.length &&
          !onePerPath(stampPlain(this.ctx(bump), [...cur, a]))
        ) {
          emit(cur, this.ctx(bump));
          cur = [];
        }
        cur.push(a);
      }
      emit(cur, this.ctx(bump));
    }
    this.store =
      flavor === 'store' && !this.frame && storeConsistent(pre, batch)
        ? applyStore(pre, batch)
        : applyStore(pre, deltas(this.table, changed));
    return { envs, plain, ctx, pre, all };
  }
  s5(): boolean {
    return deepEq(this.store, materialize(this.table));
  }
}

const INIT = { a: { b: { c: 0 }, y: 0 }, b: { m: 0 }, m: 0 };
const SEED: MEnv = {
  o: 's',
  t: 1,
  ops: [{ path: [], kind: 'set', value: INIT, cites: [], epoch: 0 }],
};
const PATHS: Path[] = [
  [],
  ['a'],
  ['a', 'b'],
  ['a', 'b', 'c'],
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
  constructor(variant: Variant, n = 3) {
    this.reps = Array.from({ length: n }, (_, i) => {
      const r = new Replica('r' + i, variant);
      r.receive(SEED);
      return r;
    });
    this.got = this.reps.map(() => new Set<number>());
  }
  write(
    r: number,
    batch: readonly AOp[],
    bump = false,
    flavor: Flavor = 'store',
  ): Written {
    const w = this.reps[r].write(batch, bump, flavor);
    for (const env of w.envs ?? []) this.got[r].add(this.envs.push(env) - 1);
    return w;
  }
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

const set = (path: Path, value: unknown): AOp => ({ kind: 'set', path, value });
const del = (path: Path): AOp => ({ kind: 'delete', path });
const clr = (path: Path): AOp => ({ kind: 'clear', path });
const num = (rng: () => number): number => 1 + Math.floor(rng() * 9);
function valueFor(path: Path, rng: () => number): unknown {
  const k = pk(path);
  if (k === '') {
    const v: Record<string, unknown> = {};
    if (rng() < 0.7) v['a'] = { b: { c: num(rng) }, y: num(rng) };
    if (rng() < 0.7) v['b'] = { m: num(rng) };
    if (rng() < 0.7) v['m'] = num(rng);
    return v;
  }
  if (k === 'a') {
    if (rng() < 0.1) return num(rng);
    const v: Record<string, unknown> = {};
    if (rng() < 0.6) v['b'] = rng() < 0.5 ? {} : { c: num(rng) };
    if (rng() < 0.6) v['y'] = num(rng);
    return v;
  }
  if (k === 'a/b')
    return rng() < 0.1 ? num(rng) : rng() < 0.5 ? {} : { c: num(rng) };
  if (k === 'b') return { m: num(rng) };
  return num(rng);
}
function leaves(path: Path, value: unknown): AOp[] {
  if (!isRec(value)) return [set(path, value)];
  return [
    set(path, {}),
    ...Object.keys(value).flatMap((k) => leaves([...path, k], value[k])),
  ];
}
/** A record-only structural diff, whole or leaves adds: the shape of batch a store write makes. */
function diffOf(
  prev: unknown,
  next: unknown,
  path: Path,
  out: AOp[],
  leafy: boolean,
): AOp[] {
  if (deepEq(prev, next)) return out;
  if (isRec(prev) && isRec(next)) {
    for (const k of Object.keys(prev))
      if (!has(next, k)) out.push(del([...path, k]));
    for (const k of Object.keys(next)) {
      if (!has(prev, k))
        out.push(
          ...(leafy
            ? leaves([...path, k], next[k])
            : [set([...path, k], next[k])]),
        );
      else diffOf(prev[k], next[k], [...path, k], out, leafy);
    }
    return out;
  }
  out.push(set(path, next));
  return out;
}
function edited(store: unknown, rng: () => number): unknown {
  let cur = store;
  const n = 1 + Math.floor(rng() * 3);
  for (let i = 0; i < n; i++) {
    const p = PATHS[Math.floor(rng() * PATHS.length)];
    if (p.length && rng() < 0.2) {
      if (lookup(cur, p).found) cur = writeAt(cur, p, { kind: 'delete' });
      continue;
    }
    for (let k = 1; k <= p.length; k++) {
      const at = lookup(cur, p.slice(0, k - 1));
      if (!at.found || !isRec(at.value)) return cur;
    }
    cur = writeAt(cur, p, { kind: 'set', value: valueFor(p, rng) });
  }
  return cur;
}

type Gen = { batch: AOp[]; flavor: Flavor; label?: Reason; kind?: Shape };
function ill(rng: () => number): Gen {
  const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rng() * xs.length)];
  const p = pick(PATHS.filter((x) => x.length));
  if (rng() < 0.5) {
    const kinds = pick([
      ['set', 'set'],
      ['set', 'clear'],
      ['set', 'delete'],
      ['delete', 'set'],
      ['clear', 'clear'],
    ] as const);
    const mk = (k: OpKind): AOp =>
      k === 'set' ? set(p, valueFor(p, rng)) : k === 'delete' ? del(p) : clr(p);
    return {
      batch: kinds.map(mk),
      flavor: 'emit',
      label: 'dup-path',
      kind: 'refusedDup',
    };
  }
  const q = pick(PATHS.filter((x) => x.length > 1));
  const anc = q.slice(0, Math.floor(rng() * q.length));
  const shape = pick([
    'childFirst',
    'underDelete',
    'underClear',
    'underLeaf',
  ] as const);
  const child = set(q, valueFor(q, rng));
  const batch =
    shape === 'childFirst'
      ? [child, set(anc, {})]
      : shape === 'underDelete' && anc.length
        ? [del(anc), child]
        : shape === 'underClear' && anc.length
          ? [clr(anc), child]
          : [set(anc, 7), child];
  return { batch, flavor: 'emit', label: 'nested-path', kind: 'refusedNested' };
}
function genBatch(rng: () => number, store: unknown): Gen {
  const roll = rng();
  if (roll < 0.45) {
    const leafy = rng() < 0.6;
    return {
      batch: diffOf(store, edited(store, rng), [], [], leafy),
      flavor: 'store',
      kind: leafy ? 'diffLeaves' : 'diffWhole',
    };
  }
  if (roll < 0.65) {
    const p = [[], ['a'], ['a', 'b'], ['b']][Math.floor(rng() * 4)] as Path;
    const v = valueFor(p, rng);
    const batch = leaves(p, isRec(v) ? v : {});
    if (rng() < 0.3 && !batch.some((a) => isPrefix(a.path, ['m'])))
      batch.unshift(set(['m'], num(rng)));
    return { batch, flavor: rng() < 0.5 ? 'store' : 'emit', kind: 'leaves' };
  }
  if (roll < 0.9) return ill(rng);
  const n = 1 + Math.floor(rng() * 3);
  const batch: AOp[] = [];
  for (let i = 0; i < n; i++) {
    const p = PATHS[Math.floor(rng() * PATHS.length)];
    const k = rng();
    batch.push(
      k < 0.6 || !p.length
        ? set(p, valueFor(p, rng))
        : k < 0.8
          ? del(p)
          : clr(p),
    );
  }
  return { batch, flavor: 'emit' };
}

type Violation = { seed: number; law: string; at: string };

function run(variant: Variant, seed: number, steps = 30) {
  const rng = rngOf(seed);
  const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rng() * xs.length)];
  const w = new World(variant);
  const caps: number[][] = w.reps.map(() => []);
  const broken = new Map<string, Violation>();
  const reached = new Set<Shape>();
  const fail = (law: string, at: string | null) => {
    if (at !== null && !broken.has(law)) broken.set(law, { seed, law, at });
  };

  const batchOn = (r: number) => {
    const rep = w.reps[r];
    const g = genBatch(rng, rep.store);
    if (!g.batch.length) return undefined;
    const bump = rng() < 0.25;
    const before = rep.fingerprint();
    const out = w.write(r, g.batch, bump, g.flavor);
    const where = `${rep.o} ${JSON.stringify(g.batch)}`;
    if (g.label && out.refused !== g.label)
      fail('W', `${where} not refused as ${g.label}`);
    if (out.refused) {
      if (g.kind) reached.add(g.kind);
      if (rep.fingerprint() !== before)
        fail('W', `${where} refusal changed the replica`);
      return undefined;
    }
    if (g.kind && !g.label) reached.add(g.kind);
    for (const s of shapesOf(out.ctx, g.batch, rep.o)) reached.add(s);
    if (rep.frame) {
      const f = rep.frame;
      if (
        rep.log.some(
          (e) =>
            e.env.o === rep.o && e.seq > f.entry && !out.envs.includes(e.env),
        )
      )
        reached.add('scopeOwnObserved');
      if (!out.all) reached.add('scopeUnobserved');
    }
    const ops = out.envs.flatMap((e) => e.ops);
    if (!out.envs.every((e) => onePerPath(e.ops))) fail('E1', where);
    const want = new Map<string, { cites: Set<string>; epoch: number }>();
    for (const { op } of out.plain) {
      const cur = want.get(pk(op.path)) ?? {
        cites: new Set<string>(),
        epoch: op.epoch,
      };
      op.cites.forEach((d) => cur.cites.add(dotKey(d)));
      want.set(pk(op.path), cur);
    }
    for (const [q, { cites }] of want)
      for (const d of cites)
        if (
          !ops.some(
            (op) => pk(op.path) === q && op.cites.some((x) => dotKey(x) === d),
          )
        )
          fail('E2', `${where} loses ${d} at ${q}`);
    for (const op of ops) {
      const live = new Set(dotsOf(out.ctx.view.live(op.path)).map(dotKey));
      if (!want.has(pk(op.path)))
        fail('E2', `${where} extra op at ${pk(op.path)}`);
      if (op.cites.some((d) => !live.has(dotKey(d))))
        fail('E2', `${where} cites outside the view`);
      if (op.epoch !== want.get(pk(op.path))?.epoch)
        fail('EP', `${where} ${pk(op.path)}:${op.epoch}`);
    }
    if (out.envs.length !== 1 || !subsequence(out.plain, out.envs[0].ops))
      fail('E7', where);
    if (out.all && storeConsistent(out.pre, g.batch))
      if (!deepEq(materialize(rep.table), applyStore(out.pre, g.batch)))
        fail('E3', where);
    const plainOps = out.plain.map((e) => e.op);
    if (onePerPath(plainOps) && !wellFormed(g.batch))
      if (out.envs.length !== 1 || !sameOps(out.envs[0].ops, plainOps))
        fail('E5', where);
    return { out, batch: g.batch };
  };

  for (let step = 0; step < steps; step++) {
    const r = Math.floor(rng() * w.reps.length);
    const rep = w.reps[r];
    const roll = rng();
    if (roll < 0.28) batchOn(r);
    else if (roll < 0.38) {
      w.deliverAll(rng);
      const pres = w.reps.map((x) => x.store);
      const res = batchOn(r);
      if (res) {
        w.deliverAll(rng);
        reached.add('syncedReceivers');
        w.reps.forEach((x, i) => {
          if (i === r || !storeConsistent(pres[i], res.batch)) return;
          if (!deepEq(x.store, applyStore(pres[i], res.batch)))
            fail('E3', `receiver ${x.o}`);
        });
      }
    } else if (roll < 0.48) caps[r].push(rep.capture());
    else if (roll < 0.72) {
      const c = w.deliverable(r);
      if (c.length) w.deliver(r, pick(c));
    } else {
      const F = caps[r].length && rng() < 0.6 ? pick(caps[r]) : rep.capture();
      if (rng() < 0.3) batchOn(r);
      rep.enter(F);
      const items = 1 + Math.floor(rng() * 3);
      for (let i = 0; i < items; i++) {
        if (rng() < 0.2) {
          const c = w.deliverable(r);
          if (c.length) w.deliver(r, pick(c));
        }
        batchOn(r);
      }
      rep.exit();
    }
    for (const x of w.reps) if (!x.s5()) fail('S5', `${x.o} step ${step}`);
  }
  w.deliverAll(rng);
  const want = materialize(viewOf([SEED, ...w.envs]));
  for (const x of w.reps) {
    if (!x.s5()) fail('S5', x.o);
    if (!deepEq(x.store, want)) fail('E4', x.o);
  }
  return { broken: [...broken.values()], reached };
}

const SEEDS = 300;
const sweeps = new Map<Variant, ReturnType<typeof sweepOnce>>();
function sweepOnce(variant: Variant) {
  const laws = new Set<string>();
  const reached = new Set<Shape>();
  const examples: Violation[] = [];
  for (let s = 1; s <= SEEDS; s++) {
    const out = run(variant, s * 7919);
    for (const v of out.broken) {
      if (!laws.has(v.law)) examples.push(v);
      laws.add(v.law);
    }
    out.reached.forEach((x) => reached.add(x));
  }
  return { laws: [...laws].sort(), reached, examples };
}
const sweep = (variant: Variant) => {
  const hit = sweeps.get(variant);
  if (hit) return hit;
  const out = sweepOnce(variant);
  sweeps.set(variant, out);
  return out;
};

const wireOf = (ops: readonly MOp[] | undefined) =>
  (ops ?? []).map(
    (op) =>
      `${pk(op.path) || '.'}:${op.kind}:[${op.cites.map(dotKey).sort().join(',')}]:${op.epoch}`,
  );
const envOf = (w: Written): readonly MOp[] => (w.envs ?? [])[0]?.ops ?? [];

describe('MODEL stamp batch: properties over random worlds', () => {
  // three replicas; diff-shaped batches (whole and leaves adds), raw leaves expansions, labeled
  // ill-formed shapes, raw ops with clears; bumps, captures, per-origin-ordered deliveries, synced
  // rounds that check receivers, stale and fresh scope frontiers, mid-scope arrivals
  it('the rule: E1 to E7, W and S5 hold', () => {
    expect(sweep('rule').examples).toEqual([]);
  });

  it('the generator reaches every listed shape', () => {
    expect([...sweep('rule').reached].sort()).toEqual(
      [
        'bothFired',
        'bumpOff',
        'bumpOn',
        'diffLeaves',
        'diffWhole',
        'leaves',
        'maxFold',
        'mergeFired',
        'peerAbove',
        'peerAt',
        'peerBelow',
        'refusedDup',
        'refusedNested',
        'scopeOwnObserved',
        'scopeUnobserved',
        'syncedReceivers',
        'yieldFired',
      ].sort(),
    );
  });
});

describe('MODEL stamp batch: each neutered rule breaks a named law', () => {
  const table: [string, Variant, string[]][] = [
    ['R1 off: generated clears not merged', 'noMerge', ['E1']],
    [
      'R2 off: a generated clear does not yield',
      'noYield',
      ['E1', 'E3', 'E4', 'S5'],
    ],
    ['W1 off: a repeated path is stamped', 'noW1', ['E1', 'E3', 'W']],
    ['W2 off: a nested path is stamped', 'noW2', ['E3', 'W']],
    ['the authored op moved to the yielded clear position', 'moved', ['E7']],
    [
      'an op invented at a path the stamp does not touch',
      'invent',
      ['E2', 'E3', 'E4', 'E5', 'E7', 'EP', 'S5'],
    ],
    ['a bumped write applies its bump twice', 'bumpTwice', ['E5', 'E7', 'EP']],
    [
      'a bumped write skips its bump at a yielded-over path',
      'yieldNoBump',
      ['E7', 'EP'],
    ],
    ['R1 keeps the last occurrence', 'mergeLast', []],
  ];
  for (const [name, variant, laws] of table)
    it(`${name}: red on ${laws.join(', ') || 'nothing (lint)'}`, () => {
      expect(sweep(variant).laws).toEqual(laws);
    });
});

describe('MODEL stamp batch: well-formed shapes, pinned', () => {
  const liveAt = (variant: Variant, prior: AOp[][]) => {
    const w = new World(variant, 2);
    for (const b of prior) w.write(0, b);
    w.deliverAll();
    return w;
  };

  it('leaves over a live child: the generated clear yields, the authored op keeps its place', () => {
    const today = liveAt('today', [[set(['a', 'y'], 4)]]).write(0, [
      set(['a'], {}),
      set(['a', 'y'], 5),
    ]);
    expect(wireOf(envOf(today))).toEqual([
      'a:set:[]:0',
      'a/y:clear:[r0@2]:0',
      'a/y:set:[r0@2]:0',
    ]);
    const w = liveAt('rule', [[set(['a', 'y'], 4)]]);
    const out = w.write(0, [set(['a'], {}), set(['a', 'y'], 5)]);
    w.deliverAll();
    expect(wireOf(envOf(out))).toEqual(['a:set:[]:0', 'a/y:set:[r0@2]:0']);
    for (const rep of w.reps)
      expect(lookup(rep.store, ['a']).value).toEqual({ y: 5 });
  });

  it('two nested anchors over a live grandchild: one clear, at its first position', () => {
    const w = liveAt('rule', [[set(['a', 'b', 'c'], 4)]]);
    const out = w.write(0, [set(['a'], {}), set(['a', 'b'], {})]);
    w.deliverAll();
    expect(wireOf(envOf(out))).toEqual([
      'a:set:[]:0',
      'a/b/c:clear:[r0@2]:0',
      'a/b:set:[]:0',
    ]);
    for (const rep of w.reps)
      expect(lookup(rep.store, ['a']).value).toEqual({ b: {} });
    const last = liveAt('mergeLast', [[set(['a', 'b', 'c'], 4)]]).write(0, [
      set(['a'], {}),
      set(['a', 'b'], {}),
    ]);
    expect(wireOf(envOf(last))).toEqual([
      'a:set:[]:0',
      'a/b:set:[]:0',
      'a/b/c:clear:[r0@2]:0',
    ]);
  });

  it('a sibling between the anchor and the child: the child stays after it', () => {
    const script = (variant: Variant) =>
      wireOf(
        envOf(
          liveAt(variant, [[set(['a', 'y'], 4)]]).write(0, [
            set(['a'], {}),
            set(['a', 'b'], {}),
            set(['a', 'y'], 5),
          ]),
        ),
      );
    expect(script('rule')).toEqual([
      'a:set:[]:0',
      'a/b:set:[]:0',
      'a/y:set:[r0@2]:0',
    ]);
    expect(script('moved')).toEqual([
      'a:set:[]:0',
      'a/y:set:[r0@2]:0',
      'a/b:set:[]:0',
    ]);
  });

  it('a bumped batch climbs one epoch at every path it touches', () => {
    const out = liveAt('rule', [[set(['a', 'y'], 4)]]).write(
      0,
      [set(['a'], {}), set(['a', 'y'], 5)],
      true,
    );
    expect(wireOf(envOf(out))).toEqual(['a:set:[]:1', 'a/y:set:[r0@2]:1']);
  });

  it('a batch needing neither rule stamps to today, wire for wire', () => {
    const batch = [set(['a'], {}), set(['m'], 3)];
    const a = liveAt('rule', [[set(['a', 'y'], 4)]]).write(0, batch);
    const b = liveAt('today', [[set(['a', 'y'], 4)]]).write(0, batch);
    expect(sameOps(envOf(a), envOf(b))).toBe(true);
    expect(wireOf(envOf(a))).toEqual([
      'a:set:[]:0',
      'a/y:clear:[r0@2]:0',
      'm:set:[]:0',
    ]);
  });
});

describe('MODEL stamp batch: refusal (W)', () => {
  const cases: [string, AOp[], Reason][] = [
    ['set/set', [set(['m'], 1), set(['m'], 2)], 'dup-path'],
    ['set/clear', [set(['a'], {}), clr(['a'])], 'dup-path'],
    ['set/delete', [set(['a', 'y'], 1), del(['a', 'y'])], 'dup-path'],
    ['delete/set', [del(['a', 'y']), set(['a', 'y'], 3)], 'dup-path'],
    [
      'child before its ancestor',
      [set(['a', 'y'], 5), set(['a'], { b: {} })],
      'nested-path',
    ],
    ['child under a delete', [del(['a']), set(['a', 'b'], 7)], 'nested-path'],
    ['child under a clear', [clr(['a']), set(['a', 'y'], 1)], 'nested-path'],
    [
      'child under a non-record set',
      [set(['a'], 5), set(['a', 'b'], 1)],
      'nested-path',
    ],
    [
      'a repeated path also nested',
      [set(['a'], {}), set(['a', 'y'], 1), set(['a', 'y'], 2)],
      'dup-path',
    ],
  ];
  for (const [name, batch, reason] of cases)
    it(`${name}: refused as ${reason}, nothing changes`, () => {
      const w = new World('rule', 2);
      w.write(0, [set(['a', 'y'], 4)]);
      const before = w.reps[0].fingerprint();
      expect(w.write(0, batch).refused).toBe(reason);
      expect(w.reps[0].fingerprint()).toBe(before);
      expect(w.envs.length).toBe(1);
    });
});

describe('MODEL stamp batch: killed alternatives, pinned', () => {
  it('full normalization: [delete a, set a.b 7] stands whole, and the registers disagree with the value written', () => {
    // the same normalization leaves `prev` undetermined for a surviving op after a dead one at its path
    const w = new World('normalize', 2);
    const out = w.write(0, [del(['a']), set(['a', 'b'], 7)], false, 'emit');
    expect(wireOf(envOf(out))).toEqual(['a:delete:[]:0', 'a/b:set:[]:0']);
    expect(applyStore(INIT, [del(['a']), set(['a', 'b'], 7)] as Raw[])).toEqual(
      { ...INIT, a: { b: 7 } },
    );
    expect(lookup(materialize(w.reps[0].table), ['a']).found).toBe(false);
    expect(
      new World('rule', 2).write(0, [del(['a']), set(['a', 'b'], 7)]).refused,
    ).toBe('nested-path');
  });

  it('first op wins: the store shows the last write, the registers the first', () => {
    const w = new World('firstWins', 2);
    const out = w.write(0, [set(['m'], 1), set(['m'], 2)]);
    expect(wireOf(envOf(out))).toEqual(['m:set:[]:0']);
    expect(lookup(w.reps[0].store, ['m']).value).toBe(2);
    expect(lookup(materialize(w.reps[0].table), ['m']).value).toBe(1);
  });

  it('split into envelopes: two bumps climb two epochs and beat a concurrent epoch-2 sibling one write loses to', () => {
    const script = (variant: Variant, batch: AOp[]) => {
      const w = new World(variant, 2);
      w.write(0, [set(['b', 'm'], 5)]);
      w.write(1, [set(['a', 'y'], 7)], true);
      w.write(1, [set(['a', 'y'], 8)], true);
      const out = w.write(0, batch, true);
      w.deliverAll();
      return {
        epochs: (out.envs ?? []).map((e) => wireOf(e.ops)),
        y: w.reps.map((r) => lookup(r.store, ['a', 'y']).value),
      };
    };
    expect(script('split', [set(['a', 'y'], 1), set(['a', 'y'], 2)])).toEqual({
      epochs: [['a/y:set:[]:1'], ['a/y:set:[r0@3]:2']],
      y: [2, 2],
    });
    expect(script('rule', [set(['a', 'y'], 2)])).toEqual({
      epochs: [['a/y:set:[]:1']],
      y: [8, 8],
    });
  });

  it('today: the shortest dup-path trace is one fresh replica writing one path twice', () => {
    const out = new World('today', 1).write(0, [set(['m'], 1), set(['m'], 2)]);
    expect(wireOf(envOf(out))).toEqual(['m:set:[]:0', 'm:set:[]:0']);
  });
});

describe('MODEL stamp batch: inside a commit scope (E6)', () => {
  it('several emissions in one scope: a leaves emission over the scope own child keeps one op there', () => {
    for (const variant of ['today', 'rule'] as const) {
      const w = new World(variant, 2);
      const rep = w.reps[0];
      rep.enter(rep.capture());
      const e1 = w.write(0, [set(['a', 'y'], 4)], false, 'emit');
      const e2 = w.write(
        0,
        [set(['a'], {}), set(['a', 'y'], 5)],
        false,
        'emit',
      );
      rep.exit();
      w.deliverAll();
      const own = dotKey((e1.envs ?? [])[0]);
      if (variant === 'today')
        expect(wireOf(envOf(e2))).toEqual([
          'a:set:[]:0',
          `a/y:clear:[${own}]:0`,
          `a/y:set:[${own}]:0`,
        ]);
      else {
        expect(wireOf(envOf(e2))).toEqual(['a:set:[]:0', `a/y:set:[${own}]:0`]);
        for (const x of w.reps)
          expect(lookup(x.store, ['a']).value).toEqual({ y: 5 });
      }
    }
  });

  it('an uncovered own sibling stays uncited and concurrent, the envelope stays valid', () => {
    const w = new World('rule', 2);
    const rep = w.reps[0];
    const F = rep.capture();
    w.write(0, [set(['a', 'b', 'c'], 9)]);
    rep.enter(F);
    const e1 = w.write(0, [set(['a', 'y'], 4)], false, 'emit');
    const e2 = w.write(
      0,
      [set(['a'], {}), set(['a', 'b'], {}), set(['a', 'y'], 5)],
      false,
      'emit',
    );
    rep.exit();
    w.deliverAll();
    expect(wireOf(envOf(e2))).toEqual([
      'a:set:[]:0',
      'a/b:set:[]:0',
      `a/y:set:[${dotKey((e1.envs ?? [])[0])}]:0`,
    ]);
    const want = materialize(viewOf([SEED, ...w.envs]));
    for (const x of w.reps) expect(x.store).toEqual(want);
  });
});
