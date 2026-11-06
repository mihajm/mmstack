import {
  admits as relayAdmits,
  createRegisterStore,
  MESH_PROTO_VERSION,
  type Dot,
  type Hlc,
  type Key,
  type OpEnvelope,
  type RegisterCheckpoint,
  type StoreOp,
  type SyncOp,
  type SyncSibling,
  validateEnvelope,
} from '@mmstack/mesh-protocol';
import {
  compareSiblings,
  createConvergingApply,
  positional,
  preserve,
  type FoldFn,
  type MergeFn,
} from '@mmstack/primitives/core';
import { describe, expect, it } from 'vitest';
import {
  owedAfterInstall,
  owedAfterRefusal,
  readyValue as clientReadyValue,
  trimByReceipts,
  uncoveredCites,
  welcomeVerdict,
} from './generation';

// ─────────────────────────────────────────────────────────────────────────────
// Generation-cut proof — slab S1 of `_mesh-generation-cut-arc.md`, round 9 (charter §9 D-a..D-f,
// §11 D-a′/D-b′/F-11, §14 closures, §16 R16-1..R16-6: ledger suppression, rehydration owed, ingress
// consistency, the exact T1 domain, client-declared census readiness, the uniform citation gate;
// §17 R17-1 honest stamping discipline, R17-2 the out-of-production peer residual; §19 R19-1
// acknowledged-effect LIVENESS in the ledger, R19-2/R19-3 header corrections; §20 R20-1 retention
// of the cut source before any discharge; r9: §19 R19-3 positional array merge PROVEN into the T1
// domain, §22 N8 container step, §24 N6 owed-install pin and the NO-PERSIST replica as default).
// A cut is a DECLARED HISTORY RESET: (T1) the seed preserves the room STRUCTURALLY — every live
// sibling of every kept register with full identity, dropping only registers no SELECTING fold can
// observe; (T2) seed, authority reset and tail handling conform to the specification; (T3) no
// acknowledged write is lost or applied twice across cut + crash + reload — its sibling retained and
// LIVE (unless an acknowledged cite requires its suppression) or discharged, never discharged while
// hidden, absent or altered, and every supersession it acknowledged still SUPPRESSING what it cited; plus liveness
// under a hard tombstone budget (D11). The compaction theorem must still hold WITHIN a generation.
//
// Ruled physics modeled here: D4′ seed (original dots) with the D-a′ FOLD-INDEPENDENT keep rule and
// D3″ baselines; D5′ verbatim replay with ONE pre-check per envelope; D-f TWO-REGIME covers with the
// CUT as boundary (`preCutMax`), frozen seed extent, floored exemption — applied by the relay to
// EVERY envelope, fresh or replayed (R16-6: one gate, no wire discriminator); D6′ `Applied |
// Conflict` with relay refusals landing in Conflict (D-b), journaled (D-b′), REPLIED to every resend
// (D-b″, a restart resends its outbox) and followed by a durable REHYDRATION OWED until a welcome at
// or past the refusal installs (R16-2); D7 exact-range receipts keyed by ENVELOPE origin, read by
// the trim as exact MEMBERSHIP of the version in the union over every instance of the origin
// (R26-1: a replay is receipted under its own instance; an origin's versions never repeat); D9
// ordering; D-c consensus as a CLIENT-DECLARED ready state (R16-5); D-d welcomes as reorderable
// messages, atomic installation, a persisted client record (generation fields, owed flag, peer-held
// set) with crash points; a same-generation snapshot is installed only if it is not older than
// RELAY-sequenced traffic already delivered, deduplicated echoes included, and peer-held envelopes
// are re-ingested after it (R16-3); D-e the authored envelope (op list + one bump flag).
// R17-1 HONEST STAMPING DISCIPLINE: a replica's fresh writes (re-authors included) cite only dots it
// received FROM THE RELAY (welcome or sequenced delta) or its own earlier dots — never a peer-held
// copy of another origin's dot; it still FOLDS peer copies for display (`Replica.rk` is the view it
// stamps from). The fact behind it: studio ingests document envelopes from the relay socket only
// (`session.ts` `case 'env'`; `peer-links.ts` carries no envelopes), and mmstack's relay-less
// `webrtc-mesh` mode has no relay and therefore no cut. So a relay refusal of an honest fresh write
// is unreachable (`D6-fresh`, asserted); the model's peer channel is an ADVERSARIAL SUPERSET, and
// n42 lets fresh writes cite it (r6) — refusals then land in Conflict, never divergence.
// R19-2 (what the gate proves): `covers` is an UPPER BOUND per origin — a greater retained stamp of
// the same origin covers a smaller one — not exact admission evidence for the cited dot. The
// `T3-resurrect` argument rests on origin FIFO (an honest later envelope cannot overtake an
// unadmitted earlier one of its origin, A1), honest provenance (R17-1) and exact receipts (D7).
//
// Subjects are the REAL relay register store and the REAL client fold (selecting configurations:
// default, one custom per-path selecting fold; residual configurations: `preserve`, a custom
// synthesizing fold). Every oracle is verifier-owned: the D-f covers oracle, the structural T1
// oracle, the T3 acknowledged-effect ledger (retention, expected LIVENESS and suppression, own
// liveness over the checkpoint) and the delivered-history / owed-rehydration records read plain data; none calls the
// store's `covers` or `maxEpoch`, a fold or a materializer.
//
// NON-COVERAGE and PRECONDITIONS (declared; post-green review reads source against this list):
// - transport loss beyond A1 (per-origin FIFO, in-order resend); the ghost writer is the only A1
//   violator and writes into whatever generation is current (excluded from `T3-resurrect`);
//   successful acknowledgments reach the author as the relay's answer to its own send, used ONLY for
//   its ready declaration (R16-5) — trimming uses receipts in welcomes alone (every ack lost = the
//   worst case for D7); refusals are replies, delivered synchronously, repeated on every resend;
//   ready declarations are synchronous messages (a delayed or false one = n39's dishonest case);
// - a delivery to a replica is a RELAY delta (sequenced) iff the relay had admitted the envelope
//   when it was delivered, else a PEER copy (unsequenced); welcomes are reorderable (more adversarial
//   than one FIFO relay socket; the end-of-run drain uses FIFO after one overtaking round);
// - CLIENT RECORD (r9, charter §24 ruled = the real client): NO registers and NO sequence knowledge —
//   tail (outbox, replay cursor, intents), conflicts, owed snapshot, generation fields, admission
//   evidence, emission floors; a restart re-applies its pending writes, shows no compared view and
//   replays nothing until a welcome installs (asked for without seq, outbox resent first). The old
//   persisting replica is a variant (`persistRegisters`), swept too. r9's `T3-recrash` (a replay on
//   the wire + a crash before its record + a second cut ⇒ the original entry escaped the (origin,
//   instance, version) trim and was admitted twice) is CLOSED by R26-1 and ASSERTED (r9.1); n45
//   restores the per-instance trim;
// - storage-adapter atomicity: the relay journal/checkpoint and the client record are persisted
//   atomically per unit (S4 owns the adapter); client crash points are modeled at the record
//   boundary (replay dequeue / outbox / local ingest / classification; install stages; between a
//   relay refusal and the persisted Conflict), not inside an adapter;
// - the conflict UI; the user's choice between discard and re-author is a coin flip;
// - the census LIFECYCLE above the declared flag: countdowns, thresholds, per-threshold defaults,
//   agent auto-votes, lobby-vs-gain for joiners (studio half, charter §9 D-c);
// - policy-version / authority-table changes across generations (`canBump` is constant per run);
// - clock skew beyond HLC well-formedness (one global harness clock);
// - OUT-OF-PRODUCTION RESIDUAL (R17-2): a THIRD party never learns of a refusal (refusals are replies
//   to the author), so a peer copy of a refused envelope stays held until its origin's later
//   admission shows it skipped, or the next cut — `peerRefusedRetained`, REPORTED, never asserted.
//   Production relay rooms carry no peer copies of document ops; refusal broadcast is not modeled
//   (named future, charter §17);
// - the application store: fold deltas are CONSUMED and counted per fold lifetime and intent
//   (T3-apply counts actual ingest invocations), not applied to an application store;
// - a client learns first stamps from every envelope it ingests (welcome, relay delta, peer copy,
//   own write) — one admission structure; any lead or lag against the relay's view yields only a
//   relay refusal ⇒ Conflict (D-b), never an admission of an uncovered cite (tripwire);
// - BUDGET: the HARD budget (fixed per run) is evaluated after every admitted commit and at every
//   step end, never waiting for quiescence; the RELATIVE and SOFT budgets and their scheduler
//   (quiet-commit detection, `MESH_*` defaults) are NOT modeled — the fixed hard budget is the oracle
//   of the hard path only;
// - T1 DOMAIN (charter §16 R16-4, ruled; widened by r9): T1 is a THEOREM for a ROOTED room whose
//   ROOT register holds a live `set` folded by a SELECTING fold (a CONTRIBUTING root), SELECTING
//   folds (the output at a path is one live sibling's kind and value, or abstention) or the
//   POSITIONAL ARRAY fold everywhere else, and arrays as UNIT values (no register below an array
//   path). POSITIONAL ARRAY MERGE: PROVEN r9 (charter §19 R19-3) — the real `positional` merge,
//   folded by the real fold (`mergeFold(positional)` via a policy; `noPolicyFold` by default), is
//   PATH-CLOSED (L1: every key/index of its output is held by a live `set` sibling value at the
//   register; the ancestor `prev` decides, never contributes), so no register D-a′ drops lies inside
//   its output (L2: the containment clause already keeps every such tombstone) and materialization
//   under it is identical across every reaper/consensus cut (`T1-positional`, asserted; lemmas
//   `positional-closure`, asserted, checked at every cut over every register; the no-policy default's
//   differential is `T1-diff`). Everything else is a DECLARED RESIDUAL, reported and pinned, never
//   asserted: synthesizing folds (`preserve` marker keys, `mergeFold` over `prev` for non-arrays,
//   custom synthesizing folds — `T1-residual`), an abstaining root (vivification lost), index-mode
//   registers below arrays (`T1-index`: the contrast, reported; 0 departures so far — the lemmas
//   cover them too).
//   STUDIO (R19-3): (1) rooms configure `policies: []`, so every path incl. the root folds by the
//   default fold — SELECTING, except that an array-valued winner folds POSITIONALLY (`noPolicyFold`,
//   op-sync.ts:763–771) — now in the domain; (2) the sync layer diffs arrays as UNITS by default
//   (`arrays: 'unit'`): no register below an array path; (3) every room starts from a genesis/
//   migration root `set` (S2 asserts it at boot). So studio's default configuration is in the domain
//   for every register (S5's fold-domain assertion: no policy beyond the defaults);
// - VALUE/PATH DOMAIN: plain JSON values (r9: array-valued writes of scalars, records and nested
//   arrays with `prev` as the sync layer's diff carries it, on a second rng stream; index-mode runs
//   add per-slot ops below them; a materialized value that would not survive JSON is never carried
//   as `prev`); present-`undefined` appears only in a pin;
//   string keys, the store keys a path by `String(segment)` joined with the unit separator, so the
//   PATH ENCODING precondition is: no empty segment and no segment containing a control character.
//   The real `validateEnvelope` rejects control characters (`path-control`), duplicate paths
//   (`dup-path`) and, since S2, an empty segment (`path-empty`: `['']` would collide with the root
//   register, pinned); every envelope the harness puts on the wire passes `validateEnvelope`
//   (class `wire`);
// - ROOTED rooms: the genesis carries a root register (the migration document); rootless
//   vivification (OPEN-2) is pinned, not covered;
// - MIGRATION / ROLLBACK scope: their seeds are a SUPPLIED value (the source's default-fold
//   materialization, or the selected historical snapshot), minted as one root sibling; no schema
//   transformation is verified and preservation is relative to the selected source, default fold
//   only; the T3 ledger treats such a cut as discharging every acknowledged op (declared loss).
// ─────────────────────────────────────────────────────────────────────────────

// ─── D5′ + D-f COVERS ORACLE (verifier-owned; written from the charter prose first) ──────────
//
// Charter D5′: every cite of a replayed envelope must be COVERED by the installed state, else the
// whole envelope is a CONFLICT. Charter D-f: a cited dot (o, h) with h ≤ preCutMax[o] (the highest
// stamp the room held from o before the cut) is PRE-CUT and is covered iff the FROZEN SEED EXTENT
// (per path, per origin, the highest retained stamp) reaches it — nothing else answers for it. A
// dot above preCutMax[o] is NEW-GENERATION: covered iff the generation's own registers (siblings
// and supersession marks of every envelope of the generation the replica holds) reach it. The
// oracle builds everything from plain data — its own path keys (`String(segment)`, the store's
// identity), its own stamp order, its own preCutMax — and never collects anything.

type OStamp = { readonly p: number; readonly l: number };
type OCite = { readonly origin: string; readonly hlc: OStamp };
type OEnv = {
  readonly origin: string;
  readonly hlc: OStamp;
  readonly ops: readonly {
    readonly path: readonly (string | number)[];
    readonly cites?: readonly OCite[];
  }[];
};
const oGe = (a: OStamp, b: OStamp): boolean => a.p > b.p || (a.p === b.p && a.l >= b.l);
/** The store keys a register by `String(segment)` joined: the oracle uses the same identity. */
const oPathKey = (path: readonly (string | number)[]): string => JSON.stringify(path.map(String));

type OMarks = Map<string, { sib: Map<string, OStamp>; mark: Map<string, OStamp> }>;
type OState = {
  readonly extent: Map<string, Map<string, OStamp>>;
  readonly preCutMax: ReadonlyMap<string, OStamp>;
  readonly gen: OMarks;
};
const oRaise = (m: Map<string, OStamp>, o: string, h: OStamp): void => {
  const cur = m.get(o);
  if (!cur || !oGe(cur, h)) m.set(o, { p: h.p, l: h.l });
};
const oReg = (s: OMarks, path: readonly (string | number)[]) => {
  const k = oPathKey(path);
  let r = s.get(k);
  if (!r) s.set(k, (r = { sib: new Map(), mark: new Map() }));
  return r;
};

type OSeed = readonly {
  readonly path: readonly (string | number)[];
  readonly siblings: readonly OCite[];
}[];

/** The frozen extent of a seed: per path, per origin, the highest retained stamp. */
function oExtent(seed: OSeed): Map<string, Map<string, OStamp>> {
  const ext = new Map<string, Map<string, OStamp>>();
  for (const r of seed) {
    const k = oPathKey(r.path);
    let m = ext.get(k);
    if (!m) ext.set(k, (m = new Map()));
    for (const sib of r.siblings) oRaise(m, sib.origin, sib.hlc);
  }
  return ext;
}

/** The oracle's own preCutMax: the highest stamp per origin over every dot the room held before the cut. */
function oPreCutMax(heldBefore: readonly OCite[]): Map<string, OStamp> {
  const m = new Map<string, OStamp>();
  for (const d of heldBefore) oRaise(m, d.origin, d.hlc);
  return m;
}

function oView(seed: OSeed, preCutMax: ReadonlyMap<string, OStamp>, envs: readonly OEnv[]): OState {
  const gen: OMarks = new Map();
  for (const e of envs) {
    for (const op of e.ops) {
      const r = oReg(gen, op.path);
      oRaise(r.sib, e.origin, e.hlc);
      for (const c of op.cites ?? []) {
        if (c.origin === e.origin && c.hlc.p === e.hlc.p && c.hlc.l === e.hlc.l) continue;
        oRaise(r.mark, c.origin, c.hlc);
      }
    }
  }
  return { extent: oExtent(seed), preCutMax, gen };
}

const oCovered = (s: OState, path: readonly (string | number)[], c: OCite): boolean => {
  const k = oPathKey(path);
  const ext = s.extent.get(k)?.get(c.origin);
  const pre = s.preCutMax.get(c.origin);
  if (pre && oGe(pre, c.hlc)) return !!ext && oGe(ext, c.hlc); // PRE-CUT: the seed is the only witness
  const r = s.gen.get(k);
  if (!r) return false;
  const sib = r.sib.get(c.origin);
  const mark = r.mark.get(c.origin);
  return (!!sib && oGe(sib, c.hlc)) || (!!mark && oGe(mark, c.hlc));
};

type OVerdict = 'apply' | 'conflict';
/** Per cite: the uncovered cites of an envelope (its own dot is not a cite: the born-dead guard). */
function oUncovered(s: OState, env: OEnv): OCite[] {
  const out: OCite[] = [];
  for (const op of env.ops) {
    for (const c of op.cites ?? []) {
      if (c.origin === env.origin && c.hlc.p === env.hlc.p && c.hlc.l === env.hlc.l) continue;
      if (!oCovered(s, op.path, c)) out.push(c);
    }
  }
  return out;
}
const oracleDecide = (s: OState, env: OEnv): OVerdict =>
  oUncovered(s, env).length ? 'conflict' : 'apply';

describe('generation cut: the covers oracle on its own', () => {
  const sib = (origin: string, p: number): OCite => ({ origin, hlc: { p, l: 0 } });
  const seed = [{ path: ['x'], siblings: [sib('A', 10), sib('B', 20)] }];
  const pre = oPreCutMax([sib('A', 12), sib('B', 20), sib('D', 15)]);
  const env = (cites: OCite[], path = ['x']): OEnv => ({
    origin: 'C',
    hlc: { p: 30, l: 0 },
    ops: [{ path, cites }],
  });
  it('a cite of either retained sibling — winner or loser — is covered', () => {
    const s = oView(seed, pre, []);
    expect(oracleDecide(s, env([sib('A', 10)]))).toBe('apply');
    expect(oracleDecide(s, env([sib('B', 20)]))).toBe('apply');
  });
  it('a pre-cut dot the seed does not reach is uncovered, whatever the generation wrote since', () => {
    const later: OEnv = {
      origin: 'A',
      hlc: { p: 40, l: 0 },
      ops: [{ path: ['x'], cites: [sib('B', 20)] }],
    };
    const s = oView(seed, pre, [later]);
    expect(oracleDecide(s, env([sib('D', 15)]))).toBe('conflict');
    expect(oracleDecide(s, env([sib('A', 12)]))).toBe('conflict'); // A's newer sibling (40) says nothing about 12
    expect(
      oUncovered(s, {
        origin: 'C',
        hlc: { p: 30, l: 0 },
        ops: [{ path: ['x'], cites: [sib('A', 12), sib('D', 15)] }],
      }),
    ).toHaveLength(2);
  });
  it('a new-generation dot is covered by the generation registers (sibling or mark); a create with no cites applies', () => {
    const e1: OEnv = { origin: 'E', hlc: { p: 50, l: 0 }, ops: [{ path: ['x'], cites: [] }] };
    const e2: OEnv = {
      origin: 'A',
      hlc: { p: 60, l: 0 },
      ops: [{ path: ['x'], cites: [sib('E', 50)] }],
    };
    const s = oView(seed, pre, [e1, e2]);
    expect(oracleDecide(s, env([sib('E', 50)]))).toBe('apply');
    expect(oracleDecide(s, env([sib('A', 60)]))).toBe('apply');
    expect(oracleDecide(s, env([], ['fresh']))).toBe('apply');
  });
  it('path identity is the store identity: a numeric and a string segment are one register', () => {
    const s = oView([{ path: ['1'], siblings: [sib('A', 10)] }], pre, []);
    expect(oracleDecide(s, env([sib('A', 10)], [1 as unknown as string]))).toBe('apply');
  });
});

// ─── harness primitives ──────────────────────────────────────────────────────

type Fold = ReturnType<typeof createConvergingApply>;
type Store = ReturnType<typeof createRegisterStore>;

const compareHlc = (a: Hlc, b: Hlc): number => (a.p !== b.p ? a.p - b.p : a.l - b.l);
const pathKey = (path: readonly Key[]): string => path.map(String).join('\u001f');
const isPrefix = (a: readonly Key[], b: readonly Key[]): boolean =>
  a.length < b.length && a.every((s, i) => String(s) === String(b[i]));

const mulberry32 = (seed: number): (() => number) => {
  let a = (seed + 0x9e3779b9) >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
};

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null;
/**
 * PRESENCE-PRESERVING canonical form (verifier-owned): a present `undefined` is not an absent key,
 * an array hole is not an `undefined` slot, key order is ignored. JSON hides both distinctions.
 */
const pcanon = (x: unknown): string => {
  if (x === undefined) return 'U';
  if (x === null) return 'N';
  if (typeof x !== 'object') return JSON.stringify(x);
  if (Array.isArray(x)) {
    const parts: string[] = [];
    for (let i = 0; i < x.length; i++) parts.push(i in x ? pcanon(x[i]) : 'H');
    return `[${parts.join(',')}]`;
  }
  const o = x as Record<string, unknown>;
  return `{${Object.keys(o)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${pcanon(o[k])}`)
    .join(',')}}`;
};

const lookup = (tree: unknown, path: readonly Key[]): { found: boolean; value: unknown } => {
  let cur = tree;
  for (const seg of path) {
    if (!isObj(cur) || !Object.hasOwn(cur, String(seg))) return { found: false, value: undefined };
    cur = cur[String(seg)];
  }
  return { found: true, value: cur };
};

/** ['k'] and ['b', 'x'] are absent from the document: tombstones there mask nothing (droppable). */
const PATHS: readonly (readonly Key[])[] = [
  ['k'],
  ['b', 'x'],
  ['a'],
  ['b'],
  ['b', 'c'],
  ['d'],
  ['d', 'e'],
  ['d', 'e', 'f'],
];
/**
 * r9: the ARRAY-valued paths (scalars, records, nested arrays), absent from the migration document
 * until written; INDEX-mode runs also write below them (`['m', i, 'x']`, `['n', i, j]`, …).
 */
const ARRAY_PATHS: readonly (readonly Key[])[] = [['l'], ['m'], ['n']];
/** The room's migration document: the genesis root register's value. */
const INITIAL = { a: 0, b: { c: 0 }, d: { e: { f: 0 } } };
const rootSibling = (origin: string, hlc: Hlc, value: unknown): SyncSibling => ({
  kind: 'set',
  origin,
  writer: 'system',
  hlc,
  epoch: 0,
  value,
});

// ─── fold configurations (§14 T1 SCOPE: selecting = theorem, synthesizing = declared residual) ─

type FoldCfg = 'default' | 'custom' | 'preserve' | 'synth' | 'positional' | 'ancestor';
/** SELECTING folds: the output at a path is one live sibling's kind + value, or abstention. */
const SELECTING_CFGS: readonly FoldCfg[] = ['default', 'custom'];
/** SYNTHESIZING folds (the declared T1 residual): `preserve` markers; a clear turned into a delete. */
const RESIDUAL_CFGS: readonly FoldCfg[] = ['preserve', 'synth'];
const FOLD_CFGS: readonly FoldCfg[] = [...SELECTING_CFGS, ...RESIDUAL_CFGS];
/**
 * A custom per-path fold selecting the LOWEST sibling of the top epoch (epoch outermost, as the
 * FoldFn contract requires) — a SELECTING fold, the one astra's A2 counterexample needs. Depth 1.
 */
const loserFold: FoldFn = (siblings) => {
  const top = Math.max(...siblings.map((s) => s.epoch));
  const pick = siblings
    .filter((s) => s.epoch === top)
    .reduce((m, s) => (compareSiblings(s, m) < 0 ? s : m));
  return pick.kind === 'set' ? { kind: 'set', value: pick.value } : { kind: pick.kind };
};
/**
 * A custom SYNTHESIZING fold (astra's re-audit counterexample 3): pure and epoch-respecting, it
 * turns a LONE clear into a delete (a kind no live sibling has); otherwise the default winner.
 */
const clearToDeleteFold: FoldFn = (siblings) => {
  if (siblings.length === 1 && siblings[0].kind === 'clear') return { kind: 'delete' };
  const top = siblings.reduce((m, s) => (compareSiblings(s, m) > 0 ? s : m));
  return top.kind === 'set' ? { kind: 'set', value: top.value } : { kind: top.kind };
};
const DEPTHS = [['*'], ['*', '*'], ['*', '*', '*']];
/**
 * n44 (r9): a NON-path-closed array merge — the merged side's ancestor `prev` (astra's re-audit merge
 * = ancestor, restricted to arrays): it can hold an index or key neither live side holds.
 */
const ancestorMerge: MergeFn = (ancestor, mine) =>
  Array.isArray(ancestor) && Array.isArray(mine) ? ancestor : mine;
const cfgOpts = (cfg: FoldCfg) =>
  cfg === 'positional' || cfg === 'ancestor'
    ? {
        // r9: the REAL `positional` merge on every path (the real fold builds `mergeFold(positional)`)
        policies: [[], ...DEPTHS].map((path) => ({
          path,
          merge: cfg === 'positional' ? positional : ancestorMerge,
        })),
      }
    : cfg === 'preserve'
      ? { policies: [[], ...DEPTHS].map((path) => ({ path, merge: preserve })) }
      : cfg === 'custom'
        ? { folds: [{ path: ['*'], fold: loserFold }] }
        : cfg === 'synth'
          ? { folds: DEPTHS.map((path) => ({ path, fold: clearToDeleteFold })) }
          : {};
const foldOf = (cfg: FoldCfg, origin?: string): Fold =>
  createConvergingApply({ origin, ...cfgOpts(cfg) });
const materializeRegs = (
  regs: readonly RegisterCheckpoint[],
  cfg: FoldCfg = 'default',
): unknown => {
  const f = foldOf(cfg);
  f.load(regs);
  return f.materialize();
};

// ─── STRUCTURAL T1 ORACLE (verifier-owned, D-a′) ────────────────────────────
//
// Charter D-a′ (§11, ruled 2026-11-07): the seed preserves every live sibling of every kept register
// with FULL identity (kind, value, writer, epoch, prev, dot); a register is DROPPABLE iff set-free ∧
// at most ONE live non-clear sibling (two concurrent tombstones are a fold-visible fact: F-8) ∧ no
// live-set descendant ∧ — only when it holds a live DELETE (a clear masks nothing: F-12) — no live
// `set` sibling at any proper ancestor whose value contains the path. Every other register is kept.
// The oracle reads plain records with its own liveness and containment.

const oLive = (r: RegisterCheckpoint): SyncSibling[] =>
  r.siblings.filter((s) => {
    const m = r.water[s.origin];
    return !m || s.hlc.p > m.p || (s.hlc.p === m.p && s.hlc.l > m.l);
  });
const oContains = (value: unknown, rel: readonly Key[]): boolean => {
  let cur = value;
  for (const seg of rel) {
    if (typeof cur !== 'object' || cur === null || !Object.hasOwn(cur, String(seg))) return false;
    cur = (cur as Record<string, unknown>)[String(seg)];
  }
  return true;
};
const oSegs = (p: readonly Key[]): string[] => p.map(String);
const oUnder = (a: readonly Key[], b: readonly Key[]): boolean =>
  a.length < b.length && oSegs(a).every((s, i) => s === String(b[i]));

type OKept = Map<string, { path: readonly Key[]; live: SyncSibling[]; baseline: number }>;
/** The registers D-a′ KEEPS in a source (by the oracle's own path key); every other one is droppable. */
function oKept(src: readonly RegisterCheckpoint[]): OKept {
  const regs: OKept = new Map();
  for (const r of src) {
    const k = oPathKey(r.path);
    if (regs.has(k)) continue;
    regs.set(k, {
      path: r.path,
      live: oLive(r),
      baseline: Math.max(r.epoch ?? 0, ...r.siblings.map((s) => s.epoch)),
    });
  }
  const all = [...regs.values()];
  const hasSet = (x: { live: SyncSibling[] }) => x.live.some((s) => s.kind === 'set');
  const kept: OKept = new Map();
  for (const [k, x] of regs) {
    if (!x.live.length) continue;
    const deeper = all.some((d) => oUnder(x.path, d.path) && hasSet(d));
    const masks =
      x.live.some((s) => s.kind === 'delete') &&
      all.some(
        (a) =>
          oUnder(a.path, x.path) &&
          a.live.some((s) => s.kind === 'set' && oContains(s.value, x.path.slice(a.path.length))),
      );
    const multi = x.live.filter((s) => s.kind !== 'clear').length >= 2;
    if (hasSet(x) || deeper || masks || multi) kept.set(k, x);
  }
  return kept;
}

/** The structural T1 verdict: an empty list, or every way the seed departs from D-a′. */
function oStructural(
  src: readonly RegisterCheckpoint[],
  seed: readonly RegisterCheckpoint[],
): string[] {
  const out: string[] = [];
  const kept = oKept(src);
  const got = new Map(seed.map((r) => [oPathKey(r.path), r]));
  for (const [k, x] of kept) {
    const r = got.get(k);
    if (!r) {
      out.push(`${x.path.join('.')} must be kept`);
      continue;
    }
    if (Object.keys(r.water).length) out.push(`${x.path.join('.')} keeps marks`);
    const want = x.live.map(pcanon).sort();
    const have = r.siblings.map(pcanon).sort();
    if (JSON.stringify(want) !== JSON.stringify(have))
      out.push(`${x.path.join('.')} siblings ${have} vs live ${want}`);
    const eff = Math.max(r.epoch ?? 0, ...r.siblings.map((s) => s.epoch));
    if (eff !== x.baseline) out.push(`${x.path.join('.')} baseline ${eff} vs ${x.baseline}`);
  }
  for (const k of got.keys()) if (!kept.has(k)) out.push(`${k} kept but droppable`);
  return out;
}

// ─── POSITIONAL ARRAYS: the PATH-CLOSURE oracle over the REAL fold (r9, charter §19 R19-3) ────
//
// Charter §19 R19-3 (Miha, 2026-11-07): PROVE positional array merge T1-safe and admit it into the
// domain. The argument: positional merge is PATH-CLOSED — every key/index its output holds at a
// register is held by some LIVE `set` sibling value at that register (slot by slot it takes `mine`,
// `theirs`, or a record merge over the keys of `mine` ∪ `theirs`; the ancestor `prev` only DECIDES,
// it never contributes a key) — so a register D-a′ drops (set-free; a live delete only where no live
// `set` value at a proper ancestor contains its path) is never inside a positional output, and
// dropping it cannot change the materialization. The FOLD is the real one: `positional` from
// primitives, folded by the real `createConvergingApply` (`mergeFold` is not exported, so an
// explicit `{ merge: positional }` policy reaches it; the no-policy default reaches `noPolicyFold`,
// studio's configuration). The verifier owns only the path enumeration and the comparisons:
//   L1 PATH-CLOSED: own-key paths of the fold output ⊆ ∪ own-key paths of the live `set` values.
//   L2 PROTECTION: no register D-a′ drops with a live delete lies inside any ancestor's fold output.
// Both are checked at every reaper/consensus cut (class `positional-closure`); the theorem they
// carry, `T1-positional` (materialization under the positional fold identical across the cut), is
// asserted beside them.

/** Every own-key path of a value (array indices as their string keys; a hole is not an own key). */
const oPaths = (v: unknown, at = '', out = new Set<string>()): Set<string> => {
  if (typeof v !== 'object' || v === null) return out;
  for (const k of Object.keys(v)) {
    const p = `${at}\u001f${k}`;
    out.add(p);
    oPaths((v as Record<string, unknown>)[k], p, out);
  }
  return out;
};
type PosMode = 'policy' | 'default' | 'ancestor';
/**
 * The REAL fold's output at one register: its siblings and marks loaded at the ROOT of a fresh fold
 * (positional and `noPolicyFold` read no path), materialized. `undefined` unless the fold sets.
 */
function oFoldAt(r: RegisterCheckpoint, mode: PosMode): { value: unknown } | undefined {
  const f = createConvergingApply(
    mode === 'default'
      ? {}
      : { policies: [{ path: [], merge: mode === 'policy' ? positional : ancestorMerge }] },
  );
  f.load([{ path: [], siblings: r.siblings, water: r.water }]);
  const live = f.liveAt([]);
  if (!live.some((s) => s.kind === 'set')) return undefined;
  const top = live.reduce((m, s) => (compareSiblings(s, m) > 0 ? s : m));
  return top.kind === 'set' ? { value: f.materialize() } : undefined;
}
/** Whether a cut source holds a register strictly below an array (an INDEX-mode register). */
function oIndexMode(src: readonly RegisterCheckpoint[]): boolean {
  for (const r of src) {
    if (!r.siblings.length) continue;
    for (const a of src) {
      if (!oUnder(a.path, r.path)) continue;
      for (const s of oLive(a)) {
        if (s.kind !== 'set') continue;
        let cur = s.value;
        for (const seg of r.path.slice(a.path.length)) {
          if (Array.isArray(cur)) return true;
          if (typeof cur !== 'object' || cur === null || !Object.hasOwn(cur, String(seg))) break;
          cur = (cur as Record<string, unknown>)[String(seg)];
        }
      }
    }
  }
  return false;
}
type PosVerdict = { violations: string[]; folds: number; synth: number; arrays: number };
/** L1 + L2 over a cut source, per fold mode; `synth` counts outputs no single live sibling holds. */
function oPositional(src: readonly RegisterCheckpoint[], mode: PosMode): PosVerdict {
  const v: PosVerdict = { violations: [], folds: 0, synth: 0, arrays: 0 };
  const out = new Map<string, { path: readonly Key[]; value: unknown }>();
  for (const r of src) {
    const sets = oLive(r).filter((s) => s.kind === 'set');
    if (!sets.length) continue;
    const got = oFoldAt(r, mode);
    if (!got) continue;
    out.set(oPathKey(r.path), { path: r.path, value: got.value });
    if (!sets.some((s) => Array.isArray(s.value))) continue;
    v.arrays += 1;
    if (sets.length < 2) continue;
    v.folds += 1;
    if (!sets.some((s) => pcanon(s.value) === pcanon(got.value))) v.synth += 1;
    const held = new Set<string>();
    for (const s of sets) for (const p of oPaths(s.value)) held.add(p);
    for (const p of oPaths(got.value))
      if (!held.has(p))
        v.violations.push(
          `L1 ${r.path.join('.') || '<root>'}: the ${mode} fold output holds ${p.split('\u001f').slice(1).join('.')}, no live sibling does`,
        );
  }
  const kept = oKept(src);
  for (const d of src) {
    if (kept.has(oPathKey(d.path)) || !oLive(d).some((s) => s.kind === 'delete')) continue;
    for (const a of out.values())
      if (oUnder(a.path, d.path) && oContains(a.value, d.path.slice(a.path.length)))
        v.violations.push(
          `L2 dropped delete at ${d.path.join('.')} lies inside the ${mode} fold output at ${a.path.join('.') || '<root>'}`,
        );
  }
  return v;
}

describe('generation cut: the positional path-closure oracle on its own (r9)', () => {
  const arr = (origin: string, p: number, value: unknown, prev?: unknown): SyncSibling => ({
    kind: 'set',
    origin,
    writer: origin,
    hlc: { p, l: 0 },
    epoch: 0,
    value,
    ...(prev === undefined ? {} : { prev }),
  });
  const del = (origin: string, p: number): SyncSibling => ({
    kind: 'delete',
    origin,
    writer: origin,
    hlc: { p, l: 0 },
    epoch: 0,
  });
  const root: RegisterCheckpoint = {
    path: [],
    siblings: [rootSibling('g0', { p: 1, l: 0 }, {})],
    water: {},
  };
  it('the REAL fold merges two concurrent edits of different slots into a value no live sibling holds — path-closed (L1), under the explicit policy and the no-policy default alike', () => {
    const r: RegisterCheckpoint = {
      path: ['l'],
      siblings: [arr('A', 5, ['X', 'b'], ['a', 'b']), arr('B', 6, ['a', 'Y'], ['a', 'b'])],
      water: {},
    };
    for (const mode of ['policy', 'default'] as const) {
      expect(oFoldAt(r, mode)).toEqual({ value: ['X', 'Y'] });
      expect(oPositional([root, r], mode)).toEqual({
        violations: [],
        folds: 1,
        synth: 1,
        arrays: 1,
      });
    }
  });
  it('records in slots merge key by key over mine ∪ theirs; a key only the ancestor holds is never produced', () => {
    const anc = [{ x: 1, z: 9 }];
    const r: RegisterCheckpoint = {
      path: ['m'],
      siblings: [arr('A', 5, [{ x: 1, y: 2 }], anc), arr('B', 6, [{ x: 3, z: 9 }], anc)],
      water: {},
    };
    expect(oFoldAt(r, 'policy')).toEqual({ value: [{ x: 3, y: 2 }] }); // z deleted by A, kept by B unchanged ⇒ deleted
    expect(oPositional([root, r], 'policy').violations).toEqual([]);
  });
  it('n44 shape: a NON-path-closed merge (merge = ancestor) yields a key no live sibling holds (L1) and a dropped lone delete there lies inside the output (L2); the real positional fold is closed on the same registers', () => {
    const regs: RegisterCheckpoint[] = [
      root,
      {
        path: ['m'],
        siblings: [arr('A', 5, [{}], [{ x: 1 }]), arr('B', 6, [{}], [{ x: 1 }])],
        water: {},
      },
      { path: ['m', 0, 'x'], siblings: [del('C', 7)], water: {} },
    ];
    expect(oKept(regs).has(oPathKey(['m', 0, 'x']))).toBe(false); // no live set contains m.0.x: droppable
    expect(oPositional(regs, 'policy').violations).toEqual([]);
    expect(oPositional(regs, 'ancestor').violations).toEqual([
      'L1 m: the ancestor fold output holds 0.x, no live sibling does',
      'L2 dropped delete at m.0.x lies inside the ancestor fold output at m',
    ]);
    const seed = reaperSeed(regs);
    expect(pcanon(materializeRegs(seed, 'positional'))).toBe(
      pcanon(materializeRegs(regs, 'positional')),
    );
    expect(lookup(materializeRegs(regs, 'ancestor'), ['m'])).toEqual({ found: true, value: [{}] });
    expect(lookup(materializeRegs(seed, 'ancestor'), ['m'])).toEqual({
      found: true,
      value: [{ x: 1 }],
    }); // the dropped delete un-masks x: what T1-positional would see
    expect(oIndexMode(regs)).toBe(true);
    expect(oIndexMode(regs.slice(0, 2))).toBe(false);
  });
});

// ─── T3 ACKNOWLEDGED-EFFECT LEDGER (verifier-owned; charter §14) ────────────
//
// Charter §14: per acknowledged envelope, per op, record (path, dot, kind, value, cites). After every
// cut and every recovery (and every step) each record must be (i) RETAINED as a sibling at its path
// with that full identity, or (ii) SUPERSEDED by a later acknowledged op the ledger saw CITING it at
// that path (a cite of (o, h′) with h′ ≥ h: the per-origin watermark the oracle uses everywhere), or
// (iii) DROPPED by a cut as droppable per the structural oracle (`oKept`). Two readings of the
// register's own retention rules complete it: (iv) one sibling per origin per path — a later
// acknowledged op of the SAME origin at the path with a higher stamp REPLACES it (an origin sees
// its own writes); (v) a minted seed (migration / rollback) discharges everything (declared loss).
// An envelope's dot holds one sibling per path (the wire forbids duplicate paths, class `wire`).
// R19-1 adds EXPECTED LIVENESS: an undischarged record's present sibling must be live unless a
// current-generation mark requires its suppression, and a cut never discharges a hidden record.
// R20-1 adds RETENTION BEFORE DISCHARGE: a cut never discharges a record whose sibling is absent or
// altered in the cut source (retention is checked over the source before `lCut`, not only after).
// The ledger reads plain records and the store's CHECKPOINT; it never asks `covers` or `maxEpoch`.

type LRec = {
  readonly what: string;
  readonly key: string;
  readonly origin: string;
  readonly hlc: OStamp;
  /** The sibling identity the op must have become (the register keeps `prev` on a set only). */
  readonly sib: string;
  done?: 'superseded' | 'replaced' | 'dropped' | 'reset';
};
type Ledger = {
  readonly recs: LRec[];
  readonly byKey: Map<string, LRec[]>;
  /**
   * Per path, per origin, the highest stamp an acknowledged op of THIS generation CITED (a cite may
   * precede the op it cites). R16-1: each is also an expected SUPPRESSION effect.
   */
  readonly marks: Map<string, Map<string, OStamp>>;
  /**
   * The cites acknowledged in EARLIER generations since the last minted seed. D4′ drops every
   * watermark at a cut (ruled), so they are not asserted as watermarks; a dot they cite must still
   * never come back LIVE in a later generation (class `T3-resurrect`).
   */
  readonly oldMarks: Map<string, Map<string, OStamp>>;
};
const newLedger = (): Ledger => ({
  recs: [],
  byKey: new Map(),
  marks: new Map(),
  oldMarks: new Map(),
});
const lGt = (a: OStamp, b: OStamp): boolean => oGe(a, b) && !oGe(b, a);

/** An envelope was acknowledged (admitted): record its ops, discharge what they cite or replace. */
function lAck(l: Ledger, env: OpEnvelope): void {
  const seen = new Set<string>();
  for (const op of env.ops) {
    const key = oPathKey(op.path);
    if (seen.has(key)) continue;
    seen.add(key);
    let at = l.byKey.get(key);
    if (!at) l.byKey.set(key, (at = []));
    let marks = l.marks.get(key);
    if (!marks) l.marks.set(key, (marks = new Map()));
    const sop = op as SyncOp;
    for (const c of sop.cites ?? []) {
      if (c.origin === env.origin && oGe(c.hlc, env.hlc) && oGe(env.hlc, c.hlc)) continue;
      oRaise(marks, c.origin, c.hlc);
      for (const r of at)
        if (!r.done && r.origin === c.origin && oGe(c.hlc, r.hlc)) r.done = 'superseded';
    }
    const rec: LRec = {
      what: `${env.instance}:${env.origin}#${env.version}@${key}`,
      key,
      origin: env.origin,
      hlc: env.hlc,
      sib: pcanon({
        kind: op.kind,
        writer: env.writer,
        origin: env.origin,
        hlc: env.hlc,
        epoch: sop.epoch ?? 0,
        ...(op.kind === 'set' ? { value: op.next } : {}),
        ...(op.kind === 'set' && Object.hasOwn(op, 'prev') ? { prev: op.prev } : {}),
      }),
    };
    const cited = marks.get(env.origin);
    if (cited && oGe(cited, env.hlc)) rec.done = 'superseded'; // cited before it was acknowledged
    for (const r of at) {
      if (r.origin !== env.origin) continue;
      if (!r.done && lGt(env.hlc, r.hlc)) r.done = 'replaced';
      else if (lGt(r.hlc, env.hlc)) rec.done = 'replaced';
    }
    at.push(rec);
    l.recs.push(rec);
  }
}

/**
 * R19-1 EXPECTED LIVENESS (verifier-owned; charter §19): every undischarged record whose sibling is
 * PRESENT with full identity (`lMissing`'s job otherwise) must be LIVE by the oracle's own `oLive`,
 * unless a mark of the CURRENT generation requires its suppression (`marks[path][origin]` ≥ its
 * stamp). Present-but-hidden without a justifying mark = an acknowledged effect silently masked (an
 * unjustified watermark: astra audit #4 Q3). Under `lAck` a mark at or above a record's stamp also
 * discharges it as `superseded`, so for an undischarged record the mark clause is a guard that
 * never fires in the driver (counted); it is kept as ruled.
 */
function lHiddenRecs(
  l: Ledger,
  regs: readonly RegisterCheckpoint[],
): { rec: LRec; why: string; justified: boolean }[] {
  const byKey = new Map<string, RegisterCheckpoint>();
  for (const r of regs) if (!byKey.has(oPathKey(r.path))) byKey.set(oPathKey(r.path), r);
  const out: { rec: LRec; why: string; justified: boolean }[] = [];
  for (const rec of l.recs) {
    if (rec.done) continue;
    const r = byKey.get(rec.key);
    const s = r?.siblings.find((x) => x.origin === rec.origin);
    if (!r || !s || pcanon(s) !== rec.sib) continue; // absent or altered: `lMissing` names it
    if (oLive(r).includes(s)) continue;
    const m = l.marks.get(rec.key)?.get(rec.origin);
    const w = r.water[rec.origin];
    out.push({
      rec,
      why: `${rec.what}: acked effect hidden under water ${rec.origin}@${w?.p}.${w?.l}, no acked cite requires it`,
      justified: !!m && oGe(m, rec.hlc),
    });
  }
  return out;
}
function lHidden(l: Ledger, regs: readonly RegisterCheckpoint[]): string[] {
  return lHiddenRecs(l, regs)
    .filter((x) => !x.justified)
    .map((x) => x.why);
}

/**
 * A cut: a minted seed discharges everything; a reaper seed discharges what D-a′ drops — but never a
 * record whose sibling is HIDDEN in the cut source without a justifying mark (R19-1: corruption is
 * not a structural discharge) nor one whose sibling is ABSENT or ALTERED in the source (R20-1: a
 * register lost after the last check is not droppable, it is lost); each such record is returned
 * (class `ledger-discharge`) and stays undischarged. `unchecked` = the r7 ledger (the Q3 and audit
 * #5 pins' demonstration of the gaps). The
 * generation's cites stop being watermark obligations (D4′ drops every watermark) and move to
 * `oldMarks` (a minted seed clears them: nothing of the old history can be cited or come back).
 */
function lCut(
  l: Ledger,
  src: readonly RegisterCheckpoint[],
  minted: boolean,
  unchecked = false,
): string[] {
  const kept = minted ? new Map() : oKept(src);
  const unfit = new Map<LRec, string>();
  if (!minted && !unchecked) {
    for (const x of lMissingRecs(l, src)) unfit.set(x.rec, x.why); // R20-1 retention
    for (const x of lHiddenRecs(l, src)) if (!x.justified) unfit.set(x.rec, x.why); // R19-1
  }
  const refused: string[] = [];
  for (const r of l.recs) {
    if (r.done || kept.has(r.key)) continue;
    const why = unfit.get(r);
    if (why) refused.push(`not discharged as dropped: ${why}`);
    else r.done = minted ? 'reset' : 'dropped';
  }
  if (minted) l.oldMarks.clear();
  else
    for (const [k, m] of l.marks) {
      let old = l.oldMarks.get(k);
      if (!old) l.oldMarks.set(k, (old = new Map()));
      for (const [o, h] of m) oRaise(old, o, h);
    }
  l.marks.clear();
  return refused;
}

/**
 * R16-1 SUPPRESSION (verifier-owned): every acknowledged cite (o, h) at p suppresses o's siblings at
 * p up to h — none of them may be LIVE by the verifier's OWN liveness over the checkpoint (`oLive`:
 * above its origin's watermark). Present-and-marked or gone both pass; the store's `covers` is never
 * asked. `skip` excludes origins outside A1 (the ghost writes stale stamps on purpose).
 */
function lSuppress(
  marks: ReadonlyMap<string, ReadonlyMap<string, OStamp>>,
  regs: readonly RegisterCheckpoint[],
  skip: (origin: string) => boolean = () => false,
): string[] {
  const out: string[] = [];
  for (const r of regs) {
    const m = marks.get(oPathKey(r.path));
    if (!m) continue;
    for (const s of oLive(r)) {
      const h = m.get(s.origin);
      if (h && oGe(h, s.hlc) && !skip(s.origin))
        out.push(
          `${oPathKey(r.path)}: ${s.origin}@${s.hlc.p}.${s.hlc.l} live though an acked op cited ${s.origin} up to ${h.p}.${h.l}`,
        );
    }
  }
  return out;
}

/** Every undischarged record is retained, with full identity, in the store's checkpoint. */
function lMissing(l: Ledger, regs: readonly RegisterCheckpoint[]): string[] {
  return lMissingRecs(l, regs).map((x) => x.why);
}
function lMissingRecs(
  l: Ledger,
  regs: readonly RegisterCheckpoint[],
): { rec: LRec; why: string }[] {
  const held = new Map<string, Map<string, string>>();
  for (const r of regs) {
    const k = oPathKey(r.path);
    let m = held.get(k);
    if (!m) held.set(k, (m = new Map()));
    for (const s of r.siblings) m.set(s.origin, pcanon(s));
  }
  const out: { rec: LRec; why: string }[] = [];
  for (const r of l.recs) {
    if (r.done) continue;
    const got = held.get(r.key)?.get(r.origin);
    if (got !== r.sib)
      out.push({ rec: r, why: `${r.what}: ${got === undefined ? 'absent' : `holds ${got}`}` });
  }
  return out;
}

describe('generation cut: the T3 ledger on its own', () => {
  const env = (origin: string, p: number, ops: SyncOp[], version = 1): OpEnvelope => ({
    proto: MESH_PROTO_VERSION,
    instance: 'g0',
    policyVersion: 0,
    origin,
    writer: origin,
    version,
    hlc: { p, l: 0 },
    ops,
  });
  const set = (path: Key[], next: unknown, cites: Dot[] = []): SyncOp =>
    ({ kind: 'set', path, next, cites, epoch: 0 }) as SyncOp;
  const sib = (origin: string, p: number, value: unknown): SyncSibling => ({
    kind: 'set',
    origin,
    writer: origin,
    hlc: { p, l: 0 },
    epoch: 0,
    value,
  });
  it('a retained record passes; a missing or altered one fails; a cited or same-origin-replaced one is discharged', () => {
    const l = newLedger();
    lAck(l, env('A', 10, [set(['x'], 1)]));
    expect(lMissing(l, [{ path: ['x'], siblings: [sib('A', 10, 1)], water: {} }])).toEqual([]);
    expect(lMissing(l, [])).toHaveLength(1);
    expect(lMissing(l, [{ path: ['x'], siblings: [sib('A', 10, 2)], water: {} }])).toHaveLength(1);
    lAck(l, env('B', 20, [set(['x'], 'b', [{ origin: 'A', hlc: { p: 12, l: 0 } }])]));
    expect(lMissing(l, [{ path: ['x'], siblings: [sib('B', 20, 'b')], water: {} }])).toEqual([]);
    lAck(l, env('B', 30, [set(['x'], 'b2')], 2)); // no cite: B's own newer write replaces B@20
    expect(lMissing(l, [{ path: ['x'], siblings: [sib('B', 30, 'b2')], water: {} }])).toEqual([]);
    lAck(l, env('C', 25, [set(['x'], 'c')])); // nothing cites C@25: it must be retained
    expect(lMissing(l, [{ path: ['x'], siblings: [sib('B', 30, 'b2')], water: {} }])).toHaveLength(
      1,
    );
  });
  it('a cite acknowledged BEFORE the op it cites (P2P order) still supersedes it', () => {
    const l = newLedger();
    lAck(l, env('A', 20, [set(['x'], 'a', [{ origin: 'C', hlc: { p: 10, l: 0 } }])]));
    lAck(l, env('C', 10, [set(['x'], 'c')]));
    expect(lMissing(l, [{ path: ['x'], siblings: [sib('A', 20, 'a')], water: {} }])).toEqual([]);
  });
  it('R16-1: an acked cite must SUPPRESS — the cited sibling under its watermark or gone passes; live again fails; a cut moves the cites to the old marks', () => {
    const l = newLedger();
    lAck(l, env('A', 10, [{ ...set(['x'], 1), epoch: 5 } as SyncOp]));
    lAck(l, env('B', 20, [set(['x'], 2, [{ origin: 'A', hlc: { p: 10, l: 0 } }])]));
    const a: SyncSibling = { ...sib('A', 10, 1), epoch: 5 };
    const marked = { A: { p: 10, l: 0 } };
    expect(
      lSuppress(l.marks, [{ path: ['x'], siblings: [a, sib('B', 20, 2)], water: marked }]),
    ).toEqual([]);
    expect(lSuppress(l.marks, [{ path: ['x'], siblings: [sib('B', 20, 2)], water: {} }])).toEqual(
      [],
    );
    expect(
      lSuppress(l.marks, [{ path: ['x'], siblings: [a, sib('B', 20, 2)], water: {} }]),
    ).toHaveLength(1); // the watermark is lost: A@10 (epoch 5) is live again and wins
    expect(lMissing(l, [{ path: ['x'], siblings: [a, sib('B', 20, 2)], water: {} }])).toEqual([]); // retention alone passes it
    lCut(l, [{ path: ['x'], siblings: [sib('B', 20, 2)], water: {} }], false);
    expect(l.marks.size).toBe(0);
    expect(lSuppress(l.oldMarks, [{ path: ['x'], siblings: [a], water: {} }])).toHaveLength(1);
  });
  it('a cut discharges what D-a′ drops and nothing else; a minted seed discharges everything', () => {
    const l = newLedger();
    lAck(l, env('A', 10, [{ kind: 'delete', path: ['k'], prev: undefined, cites: [], epoch: 0 }]));
    lAck(l, env('B', 11, [set(['y'], 1)]));
    const del: SyncSibling = {
      kind: 'delete',
      origin: 'A',
      writer: 'A',
      hlc: { p: 10, l: 0 },
      epoch: 0,
    };
    const src: RegisterCheckpoint[] = [
      { path: ['k'], siblings: [del], water: {} },
      { path: ['y'], siblings: [sib('B', 11, 1)], water: {} },
    ];
    lCut(l, src, false);
    expect(lMissing(l, [])).toEqual(['g0:B#1@["y"]: absent']);
    lCut(l, src, true);
    expect(lMissing(l, [])).toEqual([]);
  });
  it('R19-1: an acked sibling present but HIDDEN with no justifying mark fails `lHidden` (retention and suppression pass it); a justifying mark passes; `lCut` refuses to discharge a hidden record as dropped', () => {
    const l = newLedger();
    lAck(l, env('A', 10, [set(['x'], 1)]));
    const a = sib('A', 10, 1);
    const hidden: RegisterCheckpoint[] = [
      { path: ['x'], siblings: [a], water: { A: { p: 10, l: 0 } } },
    ];
    expect(lHidden(l, [{ path: ['x'], siblings: [a], water: {} }])).toEqual([]);
    expect(lHidden(l, hidden)).toEqual([
      'g0:A#1@["x"]: acked effect hidden under water A@10.0, no acked cite requires it',
    ]);
    expect(lMissing(l, hidden)).toEqual([]); // the r7 checks pass it
    expect(lSuppress(l.marks, hidden)).toEqual([]);
    expect(lSuppress(l.oldMarks, hidden)).toEqual([]);
    expect(lHidden(l, [])).toEqual([]); // absent is `lMissing`'s verdict, not this one
    // the mark clause on its own (in the driver `lAck` also discharges such a record as superseded)
    const marked = newLedger();
    lAck(marked, env('A', 10, [set(['x'], 1)]));
    marked.marks.set(oPathKey(['x']), new Map([['A', { p: 10, l: 0 }]]));
    expect(lHidden(marked, hidden)).toEqual([]);
    // and as the driver reaches it: B's acked write cites A ⇒ A superseded, its watermark justified
    const cited = newLedger();
    lAck(cited, env('A', 10, [set(['x'], 1)]));
    lAck(cited, env('B', 20, [set(['x'], 2, [{ origin: 'A', hlc: { p: 10, l: 0 } }])]));
    expect(lHidden(cited, [{ ...hidden[0], siblings: [a, sib('B', 20, 2)] }])).toEqual([]);
    // the cut: x is set-free-live (nothing live) ⇒ D-a′ drops it; the r7 cut discharged A's record
    const r7 = structuredClone(l);
    expect(lCut(r7, hidden, false, true)).toEqual([]);
    expect(r7.recs[0].done).toBe('dropped');
    expect(lMissing(r7, [])).toEqual([]); // the seed omits x and nothing fails: the gap
    expect(lCut(l, hidden, false)).toEqual([
      'not discharged as dropped: g0:A#1@["x"]: acked effect hidden under water A@10.0, no acked cite requires it',
    ]);
    expect(l.recs[0].done).toBeUndefined();
    expect(lMissing(l, [])).toEqual(['g0:A#1@["x"]: absent']); // and the seed's loss is named
  });
  it('R20-1: `lCut` refuses to discharge a record whose sibling is ABSENT or ALTERED in the cut source (the R19-1 hidden check alone passes both; the r7 cut discharged them)', () => {
    const mk = () => {
      const l = newLedger();
      lAck(l, env('A', 10, [set(['x'], 1)]));
      return l;
    };
    const absent: RegisterCheckpoint[] = [];
    const altered: RegisterCheckpoint[] = [
      {
        path: ['x'],
        siblings: [{ kind: 'delete', origin: 'A', writer: 'A', hlc: { p: 10, l: 0 }, epoch: 0 }],
        water: {},
      }, // A's acked `set x=1` became a delete at the same dot
    ];
    expect(oKept(altered).has(oPathKey(['x']))).toBe(false); // a lone delete: D-a′ would drop x
    for (const [src, why] of [
      [absent, 'absent'],
      [altered, 'holds '],
    ] as const) {
      expect(lHidden(mk(), src)).toEqual([]); // not hidden: R19-1 alone would discharge it
      const r7 = mk();
      expect(lCut(r7, src, false, true)).toEqual([]);
      expect(r7.recs[0].done).toBe('dropped'); // the gap (astra audit #5)
      const l = mk();
      const refused = lCut(l, src, false);
      expect(refused).toHaveLength(1);
      expect(refused[0]).toContain(`not discharged as dropped: g0:A#1@["x"]: ${why}`);
      expect(l.recs[0].done).toBeUndefined();
      expect(lMissing(l, [])).toEqual(['g0:A#1@["x"]: absent']); // still named after the cut
    }
    // a retained record is still discharged when D-a′ drops its register (no over-refusal)
    const del = newLedger();
    lAck(
      del,
      env('A', 10, [{ kind: 'delete', path: ['k'], prev: undefined, cites: [], epoch: 0 }]),
    );
    const k: SyncSibling = {
      kind: 'delete',
      origin: 'A',
      writer: 'A',
      hlc: { p: 10, l: 0 },
      epoch: 0,
    };
    expect(lCut(del, [{ path: ['k'], siblings: [k], water: {} }], false)).toEqual([]);
    expect(del.recs[0].done).toBe('dropped');
  });
});

// ─── the cut's seeds (impl-shaped: the REAL store's register API, no fold) ───

/** Seed-rule neuters. */
type SeedRule = {
  /** n5′: keep covered siblings too (watermarks still dropped). */
  readonly keepCovered?: boolean;
  /** n6′: drop set-free registers even over a live-set descendant. */
  readonly noDescendantRule?: boolean;
  /** n12: drop effect-bearing tombstones too (r2's literal D4′). */
  readonly dropEffectTombstones?: boolean;
  /** n12′: r3's WINNER-BASED effect test — the default fold's materialization decides (killed by D-a). */
  readonly materializerKeep?: boolean;
  /** n16: the seed does not carry the retained registers' epoch baselines. */
  readonly noSeedBaselines?: boolean;
  /** n28: r4's literal D-a — drop a set-free register even with ≥ 2 live non-clear siblings (F-8). */
  readonly dropMultiLive?: boolean;
  /** n29: r4's literal D-a — the containment clause keeps a CLEAR-only register too (F-12). */
  readonly clearMasks?: boolean;
};

const SEED_NEUTERS = [
  'keepCovered',
  'noDescendantRule',
  'dropEffectTombstones',
  'materializerKeep',
  'noSeedBaselines',
  'dropMultiLive',
  'clearMasks',
] as const satisfies readonly (keyof SeedRule)[];

type LiveReg = { readonly path: readonly Key[]; readonly live: readonly SyncSibling[] };
/**
 * The D-a′ keep rule over live registers (impl-shaped; one rule for the seed builder AND the D11
 * count). Kept iff it holds a live `set`, or a live `set` below it, or ≥ 2 live non-clear siblings,
 * or a live DELETE whose path a live `set` value at a proper ancestor contains. No fold, no winner.
 */
function keepRule(all: readonly LiveReg[], rule: SeedRule = {}): (x: LiveReg) => boolean {
  const hasSet = (x: LiveReg) => x.live.some((s) => s.kind === 'set');
  const deeper = (x: LiveReg) => all.some((d) => isPrefix(x.path, d.path) && hasSet(d));
  const masks = (x: LiveReg) =>
    all.some(
      (a) =>
        isPrefix(a.path, x.path) &&
        a.live.some((s) => s.kind === 'set' && lookup(s.value, x.path.slice(a.path.length)).found),
    );
  const multi = (x: LiveReg) => x.live.filter((s) => s.kind !== 'clear').length >= 2;
  return (x) =>
    !!x.live.length &&
    (hasSet(x) ||
      (!rule.noDescendantRule && deeper(x)) ||
      (!rule.dropEffectTombstones &&
        !rule.materializerKeep &&
        (!!rule.clearMasks || x.live.some((s) => s.kind === 'delete')) &&
        masks(x)) ||
      (!rule.dropMultiLive && multi(x)));
}

/** The source's registers with their retained LIVE siblings (n5′: every retained sibling). */
function liveRegs(
  source: readonly RegisterCheckpoint[],
  st: Store,
  keepCovered = false,
): LiveReg[] {
  const regs = new Map<string, LiveReg>();
  for (const r of source) {
    if (regs.has(pathKey(r.path)) || !r.siblings.length) continue;
    regs.set(pathKey(r.path), {
      path: r.path,
      live: keepCovered ? r.siblings : st.siblings(r.path),
    });
  }
  return [...regs.values()];
}

/**
 * D4′ + D-a′ + D3″: the store's retained LIVE siblings (`siblings(path)`), original dots, no marks;
 * registers dropped by `keepRule`; kept registers carry their epoch baseline.
 */
function reaperSeed(
  source: readonly RegisterCheckpoint[],
  rule: SeedRule = {},
): RegisterCheckpoint[] {
  const st = createRegisterStore();
  st.load(source);
  // S2: the ruled seed IS the real store's `compactionSeed()`; the harness rule below runs only
  // for the seed-rule neuters (each a deliberate departure the real store does not offer)
  if (!SEED_NEUTERS.some((k) => rule[k])) return st.compactionSeed();
  const all = liveRegs(source, st, rule.keepCovered);
  const baseline = (path: readonly Key[]): { epoch?: number } => {
    if (rule.noSeedBaselines) return {};
    const e = st.maxEpoch(path);
    return e > 0 ? { epoch: e } : {};
  };
  const keep = keepRule(all, rule);
  const seed: RegisterCheckpoint[] = all
    .filter(keep)
    .map((x) => ({ path: x.path, siblings: [...x.live], water: {}, ...baseline(x.path) }));
  if (rule.materializerKeep) {
    // r3: a dropped tombstone is kept iff its path shows in the DEFAULT fold's materialization
    for (const x of all
      .filter((y) => !keep(y) && y.live.some((s) => s.kind === 'delete'))
      .sort((a, b) => a.path.length - b.path.length)) {
      if (lookup(materializeRegs(seed), x.path).found)
        seed.push({ path: x.path, siblings: [...x.live], water: {}, ...baseline(x.path) });
    }
  }
  return seed;
}

/** Migration / rollback seed: a SUPPLIED value, minted as ONE root sibling of the new instance. */
const storeOf = (regs: readonly RegisterCheckpoint[]): Store => {
  const st = createRegisterStore();
  st.load(regs);
  return st;
};

const mintedSeed = (value: unknown, instance: string, stamp: Hlc): RegisterCheckpoint[] => [
  {
    path: [],
    siblings: [rootSibling(instance, stamp, value === undefined ? {} : value)],
    water: {},
  },
];

// ─── relay model: admission, receipts, journal, cut, recovery ───────────────

type Policy = 'replay' | 'discard';
type Reason = 'genesis' | 'reaper' | 'migration' | 'rollback' | 'consensus';
type Extent = ReadonlyMap<string, ReadonlyMap<string, Hlc>>;
type StampTable = Readonly<Record<string, Hlc>>;

type Gen = {
  readonly index: number;
  readonly instance: string;
  readonly reason: Reason;
  readonly policy: Policy;
  /** The registers the seed came from: the relay's C store at the cut, or a rollback snapshot. */
  readonly source: readonly RegisterCheckpoint[];
  readonly seed: readonly RegisterCheckpoint[];
  /** F-2: the FROZEN SEED EXTENT — per path, per origin, the highest retained stamp. */
  readonly extent: Extent;
  /** D-f: per origin, the highest stamp the room held before the cut (incl. this seed's dots). */
  readonly preCutMax: StampTable;
  /** The ORACLE's own preCutMax, from its own record of every dot held before the cut. */
  readonly oPreCutMax: ReadonlyMap<string, OStamp>;
  /** D-c: the members ready at the cut, and the intents pending in their outboxes then. */
  readonly census?: ReadonlySet<string>;
  readonly censusPending?: ReadonlySet<string>;
};

const seedExtent = (seed: readonly RegisterCheckpoint[]): Extent => {
  const ext = new Map<string, Map<string, Hlc>>();
  for (const r of seed) {
    let m = ext.get(pathKey(r.path));
    if (!m) ext.set(pathKey(r.path), (m = new Map()));
    for (const s of r.siblings) {
      const cur = m.get(s.origin);
      if (!cur || compareHlc(s.hlc, cur) > 0) m.set(s.origin, s.hlc);
    }
  }
  return ext;
};
const extentCanon = (e: Extent): string =>
  JSON.stringify([...e].map(([k, m]) => [k, [...m].sort(([a], [b]) => (a < b ? -1 : 1))]).sort());
const raise = (t: Record<string, Hlc>, o: string, h: Hlc): void => {
  if (!t[o] || compareHlc(h, t[o]) > 0) t[o] = h;
};

type Admission = {
  settled: Record<string, Hlc>;
  /** F-2 exemption floor: the first stamp admitted from each origin in THIS generation. */
  first: Record<string, Hlc>;
  nextVersion: Map<string, number>;
  admitted: Set<string>;
};
const newAdmission = (): Admission => ({
  settled: {},
  first: {},
  nextVersion: new Map(),
  admitted: new Set(),
});
const cloneAdmission = (a: Admission): Admission => ({
  settled: { ...a.settled },
  first: { ...a.first },
  nextVersion: new Map(a.nextVersion),
  admitted: new Set(a.admitted),
});
const keyOfEnv = (e: OpEnvelope): string => `${e.origin}#${e.version}`;
const gkey = (e: OpEnvelope): string => `${e.instance}:${keyOfEnv(e)}`;
const maxOf = (r: Admission, origin: string): number => {
  let max = 0;
  for (const key of r.admitted) {
    const [o, v] = key.split('#');
    if (o === origin) max = Math.max(max, Number(v));
  }
  return max;
};

/**
 * C5 admission: duplicate and below-max refused. Settled follows the contiguous admitted prefix of
 * THIS generation and a hole stops it (F-2 obligation i); `bridge` (n15) jumps holes. `first` is
 * the first SUCCESSFULLY admitted envelope of the origin in this generation (an old-HLC verbatim
 * replay included).
 */
const admit = (r: Admission, e: OpEnvelope, bridge = false): boolean => {
  if (r.admitted.has(keyOfEnv(e))) return false;
  if (e.version < maxOf(r, e.origin)) return false;
  r.admitted.add(keyOfEnv(e));
  if (!r.first[e.origin]) r.first[e.origin] = e.hlc;
  const next = r.nextVersion.get(e.origin);
  if (next === undefined || e.version === next || bridge) {
    r.nextVersion.set(e.origin, e.version + 1);
    r.settled[e.origin] = e.hlc;
  }
  return true;
};

/** D7: per ENVELOPE origin, per generation, the exact admitted version set (and its maximum). */
type Receipts = Map<string, Map<string, { through: number; versions: Set<number> }>>;
const cloneReceipts = (r: Receipts): Receipts =>
  new Map(
    [...r].map(([o, m]) => [
      o,
      new Map([...m].map(([i, x]) => [i, { through: x.through, versions: new Set(x.versions) }])),
    ]),
  );
const receiptsCanon = (r: Receipts): string =>
  JSON.stringify(
    [...r]
      .sort(([a], [b]) => (a < b ? -1 : 1))
      .map(([o, m]) => [
        o,
        [...m]
          .sort(([a], [b]) => (a < b ? -1 : 1))
          .map(([i, x]) => [i, x.through, [...x.versions].sort((a, b) => a - b)]),
      ]),
  );

type JournalEntry =
  | { readonly kind: 'env'; readonly env: OpEnvelope }
  | { readonly kind: 'cut'; readonly gen: Gen }
  /** F-9: a refusal is durable — a late duplicate of a refused envelope is refused again (D-b″: replied again). */
  | { readonly kind: 'refuse'; readonly key: string; readonly cause: ConflictCause };

/** What the relay persists and recovers (C8 + D-f obligation ii: extent, preCutMax, floors). */
type RelayCore = {
  instance: string;
  stores: Store[];
  admission: Admission;
  receipts: Receipts;
  extent: Extent;
  preCutMax: StampTable;
  /** The highest stamp per origin the room has ever held (admitted or seeded): preCutMax at the next cut. */
  everMax: Record<string, Hlc>;
  /** F-9: envelopes of this generation the relay refused (journaled), with the refusal's cause. */
  refused: Map<string, ConflictCause>;
  /** n3′: keep the whole baseline table across the cut. */
  carryBaselines?: boolean;
  /** n15: settled bridges holes. */
  bridgeHoles?: boolean;
  /** n31 (data loss): skip the register ingest of some admitted envelopes; accounting kept. */
  omitIngest?: boolean;
  /** n32 (data loss): ingest a corrupted value for some admitted envelopes; accounting kept. */
  corruptIngest?: boolean;
  /** n36 (suppression loss): ingest some admitted envelopes WITHOUT their cites — the watermark is lost, the sibling and all accounting kept. */
  dropWater?: boolean;
  /** n43 (hidden effect): raise water[origin] to an admitted, uncited sibling's own stamp; sibling + accounting kept. */
  excessWater?: boolean;
};
/** The data-loss neuters' victims: every envelope whose version is 3 mod 4. */
const victim = (e: OpEnvelope): boolean => e.version % 4 === 3;
/**
 * n43 / R19-1 (a retention defect, never the register code — `settle`/`load` raise water only from
 * cites): water[origin] at `path` raised to `hlc` on every given store, the sibling left in place.
 */
const excessWater = (stores: readonly Store[], path: readonly Key[], origin: string, hlc: Hlc) => {
  for (const s of stores) s.load([{ path, siblings: [], water: { [origin]: hlc } }]);
};

/** n43c / R20-1 (a retention defect): the register at `path` removed whole from every given store. */
const dropRegister = (stores: readonly Store[], path: readonly Key[]) => {
  for (const s of stores) {
    const rest = s.checkpoint().filter((r) => pathKey(r.path) !== pathKey(path));
    s.reset();
    s.load(rest);
  }
};

function applyEntry(core: RelayCore, entry: JournalEntry): boolean {
  if (entry.kind === 'refuse') {
    core.refused.set(entry.key, entry.cause);
    return false;
  }
  if (entry.kind === 'cut') {
    // D2/D3″: mint, reset registers + baseline table + admission evidence, load the seed (which
    // carries its retained registers' baselines); receipts survive (D7); extent/preCutMax frozen
    const g = entry.gen;
    core.instance = g.instance;
    core.extent = g.extent;
    core.preCutMax = g.preCutMax;
    for (const s of core.stores) {
      const baselines = core.carryBaselines
        ? s.checkpoint().map((r) => ({ path: r.path, siblings: [], water: {}, epoch: r.epoch }))
        : [];
      s.reset();
      s.load(g.seed);
      s.load(baselines);
    }
    for (const r of g.seed) for (const s of r.siblings) raise(core.everMax, s.origin, s.hlc);
    core.admission = newAdmission();
    core.refused = new Map();
    return false;
  }
  const e = entry.env;
  if (e.instance !== core.instance)
    throw new Error(
      `inconsistent checkpoint: ${gkey(e)} replayed into generation ${core.instance}`,
    );
  if (!admit(core.admission, e, core.bridgeHoles)) return false;
  const stored: OpEnvelope =
    core.corruptIngest && victim(e)
      ? { ...e, ops: e.ops.map((op) => (op.kind === 'set' ? { ...op, next: 'corrupt' } : op)) }
      : core.dropWater && victim(e)
        ? { ...e, ops: e.ops.map((op) => ({ ...op, cites: [] })) }
        : e;
  if (!(core.omitIngest && victim(e))) for (const s of core.stores) s.ingest(stored);
  if (core.excessWater && victim(e)) {
    // n43 at a commit: the victim's first `set`, still live (uncited) on every store, is hidden
    const op = e.ops.find((x) => x.kind === 'set');
    const live = (s: Store): boolean =>
      !!op && s.siblings(op.path).some((x) => x.origin === e.origin && !compareHlc(x.hlc, e.hlc));
    if (op && core.stores.every(live)) excessWater(core.stores, op.path, e.origin, e.hlc);
  }
  raise(core.everMax, e.origin, e.hlc);
  let byInstance = core.receipts.get(e.origin);
  if (!byInstance) core.receipts.set(e.origin, (byInstance = new Map()));
  let rc = byInstance.get(e.instance);
  if (!rc) byInstance.set(e.instance, (rc = { through: 0, versions: new Set() }));
  rc.versions.add(e.version);
  rc.through = Math.max(rc.through, e.version);
  return true;
}

/**
 * The RULED covers (charter §9 D-f, used by the client pre-check AND the relay tripwire): a cited
 * dot at or below preCutMax[origin] is pre-cut — the frozen seed extent alone answers; above it,
 * the store's live covers ∨ the settled exemption floored at the cited origin's first stamp of this
 * generation (no floor ⇒ no exemption). S2: a THIN WRAPPER over the real relay's `admits`
 * (`@mmstack/mesh-protocol`) — the harness keeps only the context shape. The neuters rewrite the
 * CONTEXT the real function reads, never its code: n14 no extent (an empty extent); n11′ unfloored
 * exemption (every settled origin floored at −∞); n23 the KILLED r3.1 boundary (the cited origin's
 * preCutMax set just below its first stamp of the generation, +∞ without one).
 */
type CoversMode = {
  readonly noExtent?: boolean;
  readonly unflooredExempt?: boolean;
  readonly firstStampBoundary?: boolean;
};
type CoversCtx = {
  readonly extent: Extent;
  readonly preCutMax: StampTable;
  readonly admission: Admission;
};
const extentRecords = new WeakMap<Extent, Record<string, Record<string, Hlc>>>();
/** The wire shape of a frozen extent (cached: an extent never changes within its generation). */
const extentRecord = (e: Extent): Record<string, Record<string, Hlc>> => {
  let r = extentRecords.get(e);
  if (!r) {
    r = Object.fromEntries([...e].map(([k, m]) => [k, Object.fromEntries(m)]));
    extentRecords.set(e, r);
  }
  return r;
};
const BELOW_ALL: Hlc = { p: Number.NEGATIVE_INFINITY, l: 0 };
const ABOVE_ALL: Hlc = { p: Number.POSITIVE_INFINITY, l: 0 };
function admits(
  store: Store,
  ctx: CoversCtx,
  path: readonly Key[],
  c: Dot,
  mode: CoversMode = {},
): boolean {
  const fl = ctx.admission.first[c.origin];
  const preCutMax: StampTable = mode.firstStampBoundary
    ? { [c.origin]: fl ? { p: fl.p, l: fl.l - 0.5 } : ABOVE_ALL }
    : ctx.preCutMax;
  return relayAdmits(
    store,
    {
      extent: mode.noExtent ? {} : extentRecord(ctx.extent),
      preCutMax,
      firstStamp: (o) =>
        mode.unflooredExempt && ctx.admission.settled[o] ? BELOW_ALL : ctx.admission.first[o],
      settled: (o) => ctx.admission.settled[o],
    },
    path,
    c,
  );
}

/**
 * S3: the client's replay pre-check is the REAL `uncoveredCites` (the session's), over the replica's
 * maintained store. The CoversMode neuters rewrite the context it reads, exactly as `admits` above
 * (n23's per-origin boundary is built for every origin the envelope cites).
 */
function clientCovered(
  store: Store,
  ctx: CoversCtx,
  env: OpEnvelope,
  mode: CoversMode = {},
): boolean {
  let preCutMax: StampTable = ctx.preCutMax;
  if (mode.firstStampBoundary) {
    const t: Record<string, Hlc> = {};
    for (const op of env.ops)
      for (const c of op.cites ?? []) {
        const fl = ctx.admission.first[c.origin];
        t[c.origin] = fl ? { p: fl.p, l: fl.l - 0.5 } : ABOVE_ALL;
      }
    preCutMax = t;
  }
  return !uncoveredCites(
    store,
    {
      extent: mode.noExtent ? {} : extentRecord(ctx.extent),
      preCutMax,
      firstStamp: (o) =>
        mode.unflooredExempt && ctx.admission.settled[o] ? BELOW_ALL : ctx.admission.first[o],
      settled: (o) => ctx.admission.settled[o],
    },
    env,
  ).length;
}
/**
 * n45 (the pre-R26-1 trim, r9's FINDING): an entry is trimmed iff its version is in the receipts of
 * its origin under the instance it was AUTHORED in — a replay receipted under its own (newer)
 * instance escapes it. Same shape and order as the real `trimByReceipts`.
 */
function trimPerInstance<T extends TailEntry>(
  pending: readonly T[],
  receipts: Receipts,
): { readonly trimmed: T[]; readonly keep: T[] } {
  const sorted = [...pending].sort(
    (a, b) => a.env.version - b.env.version || (a.env.origin < b.env.origin ? -1 : 1),
  );
  const trimmed: T[] = [];
  const keep: T[] = [];
  for (const t of sorted)
    (receipts.get(t.env.origin)?.get(t.env.instance)?.versions.has(t.env.version)
      ? trimmed
      : keep
    ).push(t);
  return { trimmed, keep };
}
/** The wire shape of the harness receipts (exact admitted versions as ranges), for the real trim. */
const receiptsWire = (r: Receipts): Record<string, Record<string, [number, number][]>> => {
  const out: Record<string, Record<string, [number, number][]>> = {};
  for (const [o, m] of r) {
    out[o] = {};
    for (const [i, x] of m) {
      const ranges: [number, number][] = [];
      for (const v of [...x.versions].sort((a, b) => a - b)) {
        const last = ranges[ranges.length - 1];
        if (last && v === last[1] + 1) last[1] = v;
        else ranges.push([v, v]);
      }
      out[o][i] = ranges;
    }
  }
  return out;
};

// ─── the world ───────────────────────────────────────────────────────────────

/** Neuters (teeth) and pin variants. The default is the charter as ruled. */
type Variant = SeedRule &
  CoversMode & {
    readonly noReceipts?: boolean; // n2
    readonly carryBaselines?: boolean; // n3′
    readonly noReplicaFence?: boolean; // n4
    readonly noBudget?: boolean; // n7
    readonly checkpointNoReceipts?: boolean; // n8
    readonly noPrecheck?: boolean; // n9: the client emits every replay
    readonly authorDuringRebase?: boolean; // n10: D9 off
    readonly checkpointNoExtent?: boolean; // n13a: relay checkpoints omit the frozen extent
    readonly checkpointNoFloors?: boolean; // n13b: relay checkpoints omit the exemption floors
    readonly bridgeHoles?: boolean; // n15
    readonly countAllLone?: boolean; // n17: the OLD budget metric (demonstration)
    readonly nonAtomicInstall?: boolean; // n18: welcome installation persisted in stages
    readonly nonAtomicReplay?: boolean; // n19: replay step persisted in stages
    readonly eagerSettle?: boolean; // n20: over-eager collection at the relay
    readonly acceptStale?: boolean; // n21: install every welcome
    readonly noFloorRestore?: boolean; // n22: a reload forgets the client floors
    readonly ignoreDrop?: boolean; // n25: the author ignores a relay refusal
    readonly reapplyAdmitted?: boolean; // n26: installation re-applies own writes the welcome already admitted
    readonly forgetRefusals?: boolean; // n27: the relay forgets refusals (a late duplicate is admitted)
    readonly silentRefusals?: boolean; // n30: a resend of a refused envelope gets no reply (r4.1 fast path)
    readonly recordNoGen?: boolean; // n33: the client record omits the generation record fields
    readonly acceptOlderSnapshot?: boolean; // n34: install a same-generation snapshot older than ingested traffic
    readonly noReplicaDedup?: boolean; // n35: a replica re-ingests a duplicate delivery of the same envelope
    readonly trimByMax?: boolean; // F-5 pin: trim by admittedThrough
    readonly noScenarios?: boolean; // the driver without the F-2a / F-4 / F-7 scenario steps
    readonly cfg?: FoldCfg; // force the replicas' fold configuration
    readonly residual?: boolean; // replicas pick SYNTHESIZING folds (the declared T1 residual sweep)
    readonly omitIngest?: boolean; // n31: data loss — admitted, receipted, journaled, NOT ingested
    readonly corruptIngest?: boolean; // n32: data loss — a retained value corrupted
    readonly dropWater?: boolean; // n36: suppression loss — a watermark lost, sibling + accounting kept
    readonly ungatedFresh?: boolean; // n40: r5's harness-only discrimination — fresh writes skip the gate
    readonly dedupBeforeSeq?: boolean; // n38: a deduplicated relay echo returns before seq knowledge advances (r5)
    readonly noPeerRetain?: boolean; // n38b: peer-held envelopes are not re-ingested after a snapshot install
    readonly owedClears?: boolean; // N6 (S3 neuter): an install clears `rehydrateOwed` whatever its seq
    readonly noOwed?: boolean; // n37: no durable rehydration-owed flag (a rejected rehydrate is never retried)
    readonly dishonestReady?: boolean; // n39: member C declares ready whenever pressed, tail or not
    readonly silentFill?: boolean; // n41: the ready flag is not re-sent when the outbox fills
    readonly citePeer?: boolean; // n42: fresh writes stamp from the FULL view, citing peer-held dots (r6)
    readonly excessWatermark?: boolean; // n43: at a commit, water raised over an acked uncited sibling (both twins)
    readonly excessWatermarkAtCut?: boolean; // n43b: the same, just before a reaper/consensus cut, after the last check
    readonly dropRegisterAtCut?: boolean; // n43c: at n43b's point, the newest acked set's whole register removed (both twins)
    readonly ancestorMerge?: boolean; // n44: the oracle's array merge is NOT path-closed (merge = ancestor `prev`)
    readonly noArrays?: boolean; // the driver without the r9 steps (the r8.1 generator)
    readonly noN8Step?: boolean; // the driver without the N8 container step (what the model reached before r9)
    readonly persistRegisters?: boolean; // r9: the OLD replica — its record also holds registers, seq knowledge and peer-held envelopes
    readonly trimPerInstance?: boolean; // n45: the pre-R26-1 trim — exact membership per (origin, instance, version)
    readonly r7Ledger?: boolean; // R19-1 off: the r7 ledger (retention + suppression only) — the Q3 pin's gap
  };

/** The intent unit (D-e): one authored ENVELOPE — its raw op list and one bump flag. */
type Intent = {
  readonly id: string;
  readonly replica: string;
  readonly raws: readonly StoreOp[];
  readonly bump: boolean;
  readonly reauthorOf?: string;
};
type TailEntry = {
  readonly intent: Intent;
  readonly instance: string;
  readonly version: number;
  readonly env: OpEnvelope;
};
type ConflictCause = 'uncovered' | 'unauthorized' | 'refused-cite' | 'refused-epoch';
type Conflict = { readonly entry: TailEntry; readonly cause: ConflictCause };
/**
 * D-d: a welcome is a MESSAGE — queued, reorderable, duplicable. It carries the generation record
 * (§12 P-1, §14): the CUT's own welcome carries the immutable `seed`; every later welcome of the
 * generation carries the CURRENT registers; all carry the immutable record fields (extent,
 * preCutMax, policy, index) and the first stamps / receipts as of their seq.
 */
type Welcome = {
  readonly instance: string;
  readonly index: number;
  readonly seq: number;
  readonly policy: Policy;
  readonly seed?: readonly RegisterCheckpoint[];
  readonly registers?: readonly RegisterCheckpoint[];
  readonly extent: Extent;
  readonly preCutMax: StampTable;
  readonly admission: Admission;
  readonly receipts: Receipts;
};
/** The generation record fields the client keeps in its durable record (§14): never read from history. */
type GenRecord = {
  readonly index: number;
  readonly policy: Policy;
  readonly extent: Extent;
  readonly preCutMax: StampTable;
};

type Replica = {
  readonly id: string;
  /** The boot origin: a reboot mints a new one while the old origin's persisted tail is resent. */
  origin: string;
  boots: number;
  instance: string;
  seq: number;
  /** The installed generation's record fields (from the welcome; persisted with the client record). */
  gen: GenRecord;
  cfg: FoldCfg;
  u: Fold;
  c: Fold;
  /**
   * R17-1 the RELAY-KNOWN view the replica stamps from: loaded from the installed welcome, fed its own
   * envelopes and every RELAY-delivered envelope it admitted (deduplicated echoes included), never a
   * peer copy. Fresh writes cite only what it holds (n42 stamps from `u`, peer copies included).
   */
  rk: Fold;
  /**
   * §12 P-2: the client's own RegisterStore for `covers` — loaded from the installed welcome, fed every
   * envelope the folds ingest, settled with the C twin. The pre-check reads it (never a fold API).
   */
  cov: Store;
  admission: Admission;
  /** Persisted outbox: every emitted entry not yet trimmed by a receipt. */
  tail: TailEntry[];
  /** D9: a rebase in progress: the replay cursor = the remaining old-generation entries, in order. */
  rebase?: { remaining: TailEntry[] };
  version: number;
  intents: number;
  /** D6′ surface: conflicts not yet resolved (discard | re-author). */
  unresolved: Conflict[];
  /** In transit to this replica (not durable). */
  inbox: Welcome[];
  connected: boolean;
  pressed: boolean;
  /** T3-apply: per intent, the fold ingest invocations in the CURRENT fold lifetime (memory only). */
  applied: Map<string, number>;
  /** Classifications not yet durable: committed to the observer's outcomes when the record persists. */
  pending: { id: string; kind: 'conflicts' | 'discarded' | 'trimmed' }[];
  /** Set by a reload: the outbox may hold envelopes refused before the crash, until the next resend. */
  resendOwed: boolean;
  /**
   * r9 (charter §24, the real client): false from a restart of the NO-PERSIST replica until a welcome
   * installs — it holds no registers (only its own pending writes re-applied), so it shows no view
   * the properties compare, and its replay waits for the install (D9). Memory only.
   */
  installed: boolean;
  /**
   * §14 welcome order + R16-3: the highest relay seq of a RELAY-delivered envelope of this generation,
   * ingested or deduplicated (the property checks the verifier's own delivered history instead).
   */
  maxSeq: number;
  /** R16-3: peer-copied (unsequenced) envelopes of this generation not yet echoed by the relay. */
  peerHeld: Map<string, OpEnvelope>;
  /** R16-2: the relay seq of the last refusal whose rehydration is still owed (durable). */
  rehydrateOwed?: number;
  /**
   * R16-5: own envelopes the client KNOWS the relay admitted — the relay's answers to its own sends
   * and the admission sets of installed welcomes. Memory only; feeds the ready declaration ONLY
   * (trimming stays receipt-only, D7's worst case).
   */
  acked: Set<string>;
};

/** D-d: the client's durable record, persisted as ONE unit. */
type ClientRecord = {
  origin: string;
  boots: number;
  instance: string;
  seq: number;
  gen: GenRecord;
  u: RegisterCheckpoint[];
  c: RegisterCheckpoint[];
  rk: RegisterCheckpoint[];
  cov: RegisterCheckpoint[];
  floorsU: ReturnType<Fold['emissionFloors']>;
  floorsC: ReturnType<Fold['emissionFloors']>;
  floorsK: ReturnType<Fold['emissionFloors']>;
  admission: Admission;
  tail: TailEntry[];
  rebase?: { remaining: TailEntry[] };
  version: number;
  intents: number;
  unresolved: Conflict[];
  maxSeq: number;
  peerHeld: Map<string, OpEnvelope>;
  rehydrateOwed?: number;
};

type Outcome = { admitted: number; conflicts: number; discarded: number; trimmed: number };

type World = {
  readonly variant: Variant;
  readonly canBump: (writer: string) => boolean;
  readonly gens: Gen[];
  readonly relay: RelayCore & { u: Store; c: Store };
  readonly journal: JournalEntry[];
  maxHlc: Hlc;
  checkpoint?: {
    at: number;
    registers: RegisterCheckpoint[];
    admission: Admission;
    receipts: Receipts;
    instance: string;
    extent: Extent;
    preCutMax: StampTable;
    everMax: Record<string, Hlc>;
    refused: Map<string, ConflictCause>;
  };
  recovered?: RelayCore;
  readonly replicas: Map<string, Replica>;
  /** Envelope origin → the replica (principal) that owns it, across reboots. */
  readonly owner: Map<string, string>;
  readonly envs: Map<string, OpEnvelope>;
  readonly authored: Map<string, OpEnvelope[]>;
  readonly envIntent: Map<string, Intent>;
  /** The relay's admission seq (journal position) per admitted envelope: a relay delta carries it. */
  readonly seqOf: Map<string, number>;
  readonly replayed: Set<string>;
  /** Envelopes the relay refused (D-b): none may remain in any outbox. */
  readonly refused: Set<string>;
  readonly outcomes: Map<string, Outcome>;
  readonly dots: { instance: string; path: readonly Key[]; dot: Dot }[];
  /** T3: the verifier-owned acknowledged-effect LEDGER (records per acked op; discharges). */
  readonly ledger: Ledger;
  /** The oracle's own record of every dot the room has held (admitted or seeded), for its preCutMax. */
  readonly held: OCite[];
  readonly disk: Map<string, ClientRecord>;
  /** VERIFIER: per replica, the envelopes it ingested by PEER copy and has not seen echoed (R16-3). */
  readonly peerIngested: Map<string, Set<string>>;
  /** VERIFIER: per replica, every RELAY-delivered envelope (ingested or deduplicated) — the delivered history. */
  readonly relayDelivered: Map<string, Set<string>>;
  /**
   * VERIFIER (R16-2): per replica, the refusals it was told of (author replies) whose rehydration has
   * not completed — an install with seq ≥ the refusal's seq completes one. Independent of the flag.
   */
  readonly owedTruth: Map<string, Map<string, number>>;
  /** RELAY state (R16-5): each connected member's DECLARED ready flag and the instance it was declared in. */
  readonly declared: Map<string, { ready: boolean; instance: string }>;
  /** VERIFIER: intents a (dishonest) census member still held when its consensus cut fired (n39). */
  readonly leaked: Set<string>;
  /** D11: the run's HARD budget, evaluated after EVERY admitted commit (and at every step end). */
  budget?: number;
  clock: number;
  readonly violations: Map<string, string>;
  readonly n: Record<string, number>;
};

const fail = (w: World, cls: string, msg: string): void => {
  if (!w.violations.has(cls)) w.violations.set(cls, msg);
  w.n[`v:${cls}`] = (w.n[`v:${cls}`] ?? 0) + 1;
};
const count = (w: World, k: string, by = 1): void => {
  w.n[k] = (w.n[k] ?? 0) + by;
};
const genOf = (w: World, instance: string): Gen =>
  w.gens.find((g) => g.instance === instance) as Gen;
const dotEq = (a: { origin: string; hlc: Hlc }, b: Dot): boolean =>
  a.origin === b.origin && compareHlc(a.hlc, b.hlc) === 0;
/** A generation's own origin (genesis or a minted seed's root sibling): never an acknowledged envelope. */
const genInstance = (w: World, origin: string): boolean =>
  w.gens.some((g) => g.instance === origin);
const outcomeOf = (w: World, id: string): Outcome => {
  let o = w.outcomes.get(id);
  if (!o) w.outcomes.set(id, (o = { admitted: 0, conflicts: 0, discarded: 0, trimmed: 0 }));
  return o;
};
const ownerOf = (w: World, origin: string): Replica | undefined => {
  const id = w.owner.get(origin);
  return id ? w.replicas.get(id) : undefined;
};

function createWorld(
  ids: readonly string[],
  variant: Variant = {},
  canBump: (writer: string) => boolean = () => true,
  rootless = false,
): World {
  const seed: RegisterCheckpoint[] = rootless
    ? []
    : [{ path: [], siblings: [rootSibling('g0', { p: 1, l: 0 }, INITIAL)], water: {} }];
  const preCutMax: Record<string, Hlc> = {};
  for (const r of seed) for (const s of r.siblings) raise(preCutMax, s.origin, s.hlc);
  const held: OCite[] = seed.flatMap((r) =>
    r.siblings.map((s) => ({ origin: s.origin, hlc: s.hlc })),
  );
  const genesis: Gen = {
    index: 0,
    instance: 'g0',
    reason: 'genesis',
    policy: 'discard',
    source: [],
    seed,
    extent: seedExtent(seed),
    preCutMax,
    oPreCutMax: oPreCutMax(held),
  };
  const u = createRegisterStore();
  const c = createRegisterStore();
  u.load(seed);
  c.load(seed);
  const w: World = {
    variant,
    canBump,
    gens: [genesis],
    relay: {
      instance: 'g0',
      stores: [u, c],
      u,
      c,
      admission: newAdmission(),
      receipts: new Map(),
      extent: genesis.extent,
      preCutMax,
      everMax: { ...preCutMax },
      refused: new Map(),
      carryBaselines: variant.carryBaselines,
      bridgeHoles: variant.bridgeHoles,
      omitIngest: variant.omitIngest,
      corruptIngest: variant.corruptIngest,
      dropWater: variant.dropWater,
      excessWater: variant.excessWatermark,
    },
    journal: [],
    maxHlc: { p: 1, l: 0 },
    replicas: new Map(),
    owner: new Map(),
    envs: new Map(),
    authored: new Map(),
    envIntent: new Map(),
    seqOf: new Map(),
    replayed: new Set(),
    refused: new Set(),
    outcomes: new Map(),
    dots: seed.flatMap((r) =>
      r.siblings.map((s) => ({
        instance: 'g0',
        path: r.path,
        dot: { origin: s.origin, hlc: s.hlc },
      })),
    ),
    ledger: newLedger(),
    held,
    disk: new Map(),
    peerIngested: new Map(),
    relayDelivered: new Map(),
    owedTruth: new Map(),
    declared: new Map(),
    leaked: new Set(),
    clock: 100,
    violations: new Map(),
    n: {},
  };
  for (const id of ids) {
    const cfg = variant.cfg ?? 'default';
    const fu = foldOf(cfg, id);
    const fc = foldOf(cfg, id);
    const fk = foldOf(cfg, id);
    fu.load(seed);
    fc.load(seed);
    fk.load(seed);
    w.replicas.set(id, {
      id,
      origin: id,
      boots: 0,
      instance: 'g0',
      seq: 0,
      gen: {
        index: 0,
        policy: genesis.policy,
        extent: genesis.extent,
        preCutMax: genesis.preCutMax,
      },
      cfg,
      u: fu,
      c: fc,
      rk: fk,
      cov: storeOf(seed),
      admission: newAdmission(),
      tail: [],
      version: 0,
      intents: 0,
      unresolved: [],
      inbox: [],
      connected: true,
      pressed: false,
      applied: new Map(),
      pending: [],
      resendOwed: false,
      installed: true,
      maxSeq: 0,
      peerHeld: new Map(),
      acked: new Set(),
    });
    w.peerIngested.set(id, new Set());
    w.relayDelivered.set(id, new Set());
    w.owedTruth.set(id, new Map());
    w.owner.set(id, id);
    w.authored.set(id, []);
  }
  for (const rep of w.replicas.values()) persist(w, rep);
  return w;
}

// ─── the client's durable record (D-d) ──────────────────────────────────────

function persist(w: World, rep: Replica): void {
  for (const x of rep.pending) {
    const o = outcomeOf(w, x.id);
    if (x.kind !== 'trimmed' && o.admitted > 0)
      fail(w, 'T3', `acked intent ${x.id} reached the tail policy as ${x.kind}`);
    o[x.kind] += 1;
  }
  rep.pending = [];
  // r9 (charter §24 RULED, the real client's `SessionRecord`): the record holds NO registers and NO
  // sequence knowledge — the tail (outbox + replay cursor, intents), conflicts, the owed snapshot,
  // the generation fields and admission evidence, the emission floors; `persistRegisters` = the old
  // replica (registers, seq, peer-held envelopes too)
  const full = !!w.variant.persistRegisters;
  w.disk.set(
    rep.id,
    structuredClone({
      origin: rep.origin,
      boots: rep.boots,
      instance: rep.instance,
      seq: full ? rep.seq : 0,
      // n33: a record without the generation record fields (recovery has no extent / preCutMax)
      gen: w.variant.recordNoGen ? { ...rep.gen, extent: new Map(), preCutMax: {} } : rep.gen,
      u: full ? rep.u.checkpoint() : [],
      c: full ? rep.c.checkpoint() : [],
      rk: full ? rep.rk.checkpoint() : [],
      cov: full ? rep.cov.checkpoint() : [],
      floorsU: rep.u.emissionFloors(),
      floorsC: rep.c.emissionFloors(),
      floorsK: rep.rk.emissionFloors(),
      admission: rep.admission,
      tail: rep.tail,
      rebase: rep.rebase,
      version: rep.version,
      intents: rep.intents,
      unresolved: rep.unresolved,
      maxSeq: full ? rep.maxSeq : 0,
      peerHeld: full ? rep.peerHeld : new Map(),
      rehydrateOwed: rep.rehydrateOwed,
    }),
  );
}

/**
 * A crash: the replica comes back from its persisted record ALONE (memory is gone; messages in
 * transit to it are lost, so it asks for a fresh welcome). `reboot` mints a NEW origin; the old
 * origin's persisted tail is resent as it is (receipts are keyed by ENVELOPE origin).
 */
function reload(w: World, rep: Replica, reboot = false): void {
  const d = structuredClone(w.disk.get(rep.id) as ClientRecord);
  rep.boots = d.boots;
  rep.origin = d.origin;
  if (reboot) {
    rep.boots += 1;
    rep.origin = `${rep.id}~${rep.boots}`;
    w.owner.set(rep.origin, rep.id);
    w.authored.set(rep.origin, []);
    count(w, 'reboots');
  }
  const mk = (cp: RegisterCheckpoint[], floors: ClientRecord['floorsU']): Fold => {
    const f = foldOf(rep.cfg, rep.origin);
    f.load(cp);
    if (!w.variant.noFloorRestore) f.restoreFloors(floors);
    return f;
  };
  rep.u = mk(d.u, d.floorsU);
  rep.c = mk(d.c, d.floorsC);
  rep.rk = mk(d.rk, d.floorsK);
  rep.cov = storeOf(d.cov);
  rep.instance = d.instance;
  rep.seq = d.seq;
  rep.gen = d.gen;
  rep.admission = d.admission;
  rep.tail = d.tail;
  rep.rebase = d.rebase;
  rep.version = reboot ? 0 : d.version;
  rep.intents = d.intents;
  rep.unresolved = d.unresolved;
  rep.applied = new Map(); // rebuilt folds: a new fold lifetime
  rep.maxSeq = d.maxSeq;
  rep.peerHeld = d.peerHeld;
  rep.rehydrateOwed = d.rehydrateOwed;
  rep.installed = !!w.variant.persistRegisters;
  if (!rep.installed) {
    // r9 NO-PERSIST restart: no registers, no seq (hello without seq); the pending writes of the
    // record's generation are re-applied over the empty folds; unsequenced peer copies are gone with
    // the memory (production relay rooms carry none, charter §17), so the verifier forgets them too
    (w.peerIngested.get(rep.id) as Set<string>).clear();
    for (const t of rep.tail) if (t.instance === rep.instance) ingestApply(w, rep, t.env, true);
    count(w, 'restartsNoRegisters');
  }
  rep.inbox = [];
  rep.pending = []; // classifications that never became durable are gone with the memory
  rep.pressed = false;
  rep.acked = new Set();
  declare(w, rep);
  rep.resendOwed = true;
  postWelcome(w, rep);
  // D-b″ + R16-2: a restart RESENDS its outbox with its hello — a refusal whose Conflict (and owed
  // flag) did not persist before the crash is replied again at once, never left to a welcome that
  // may itself be rejected as older than traffic
  for (const t of [...rep.tail])
    if (t.instance === rep.instance && rep.tail.includes(t)) toRelay(w, t.env);
  if (rep.rebase) count(w, 'reloadMidReplay');
  count(w, 'crashes');
  persist(w, rep);
}

/** The client record's own consistency: an outbox never holds an entry of another generation. */
function recordCheck(w: World, rep: Replica): void {
  const stray = rep.tail.find((t) => t.instance !== rep.instance);
  if (stray)
    fail(
      w,
      'crash',
      `${rep.id} on ${rep.instance} holds ${gkey(stray.env)} in its outbox outside any rebase`,
    );
}

// ─── emission ────────────────────────────────────────────────────────────────

function oracleView(w: World, rep: Replica): OState {
  const envs: OpEnvelope[] = [];
  for (const k of rep.admission.admitted) {
    const e = w.envs.get(`${rep.instance}:${k}`);
    if (e) envs.push(e);
  }
  const g = genOf(w, rep.instance);
  return oView(g.seed, g.oPreCutMax, envs);
}
function relayOracleView(w: World): OState {
  const envs: OpEnvelope[] = [];
  for (const k of w.relay.admission.admitted) {
    const e = w.envs.get(`${w.relay.instance}:${k}`);
    if (e) envs.push(e);
  }
  const g = genOf(w, w.relay.instance);
  return oView(g.seed, g.oPreCutMax, envs);
}

/**
 * T3-apply counts ACTUAL APPLICATIONS: every fold `ingest` invocation of a replica, its returned
 * deltas consumed (counted; a local ingest returns none — the local store already holds the edit).
 * At most ONE invocation per intent per FOLD LIFETIME (installation and reload rebuild the folds and
 * rehydrate the application store, which starts a new lifetime). Repeating the SAME envelope counts.
 */
function ingestApply(
  w: World,
  rep: Replica,
  e: OpEnvelope,
  local: boolean,
  relayKnown = local, // R17-1: own envelopes and relay deliveries feed the stamping view; peer copies never
): void {
  const opt = local ? { local: true } : undefined;
  const deltas = rep.u.ingest(e, opt);
  rep.c.ingest(e, opt);
  if (relayKnown) rep.rk.ingest(e, opt);
  rep.cov.ingest(e);
  count(w, 'applications');
  count(w, 'deltasConsumed', deltas.length);
  const intent = w.envIntent.get(gkey(e));
  if (!intent) return;
  const n = (rep.applied.get(intent.id) ?? 0) + 1;
  rep.applied.set(intent.id, n);
  if (n > 1)
    fail(
      w,
      'T3-apply',
      `${rep.id} applied intent ${intent.id} ${n} times in one fold lifetime (${gkey(e)})`,
    );
}

/** The PATH ENCODING / shape precondition: everything the harness puts on the wire passes `validateEnvelope`. */
const wireCheck = (w: World, env: OpEnvelope): void => {
  const bad = validateEnvelope(env);
  if (bad) fail(w, 'wire', `${gkey(env)} is malformed (${bad}): ${JSON.stringify(env.ops)}`);
};

/** Put an envelope on the wire from a replica: outbox, queue, local ingest. */
function put(w: World, rep: Replica, intent: Intent, env: OpEnvelope): TailEntry {
  wireCheck(w, env);
  const entry: TailEntry = { intent, instance: env.instance, version: env.version, env };
  rep.tail.push(entry);
  w.envs.set(gkey(env), env);
  w.envIntent.set(gkey(env), intent);
  if (!w.authored.has(env.origin)) w.authored.set(env.origin, []);
  (w.authored.get(env.origin) as OpEnvelope[]).push(env);
  for (const op of env.ops)
    w.dots.push({
      instance: env.instance,
      path: op.path,
      dot: { origin: env.origin, hlc: env.hlc },
    });
  admit(rep.admission, env);
  ingestApply(w, rep, env, true);
  if (!w.variant.silentFill) declare(w, rep); // the outbox filled: not ready (R16-5)
  return entry;
}

/**
 * D6-engine, PER CITE: every cite an engine verb emits is covered by the oracle over its own view.
 * A cite of a dot that THIS generation admitted (or this replica applied) yet sits at or below its
 * origin's preCutMax — a replayed refused-hole op — is the D-f residual, classed `D6-residual` (F-11).
 */
function engineCheck(w: World, rep: Replica, env: OpEnvelope, what: string): void {
  const genDots = new Set<string>();
  for (const k of rep.admission.admitted) {
    const e = w.envs.get(`${rep.instance}:${k}`);
    if (e) genDots.add(`${e.origin}@${e.hlc.p}.${e.hlc.l}`);
  }
  for (const c of oUncovered(oracleView(w, rep), env)) {
    const residual = genDots.has(`${c.origin}@${c.hlc.p}.${c.hlc.l}`);
    fail(
      w,
      residual ? 'D6-residual' : 'D6-engine',
      `${what} ${gkey(env)} emits uncovered cite ${c.origin}@${c.hlc.p}.${c.hlc.l}`,
    );
  }
}

/**
 * R17-1, verifier-owned: every cite of a fresh write names a dot the ROOM held (seeded or admitted
 * by the relay, `held`) or one of the author's own dots — never peer-only evidence.
 */
function disciplineCheck(w: World, rep: Replica, ops: readonly SyncOp[]): void {
  for (const op of ops)
    for (const c of op.cites ?? []) {
      if (ownerOf(w, c.origin)?.id === rep.id) continue;
      if (w.held.some((h) => h.origin === c.origin && compareHlc(h.hlc, c.hlc) === 0)) continue;
      fail(
        w,
        'stamp-discipline',
        `${rep.id} cites ${c.origin}@${c.hlc.p}.${c.hlc.l}, never relay-held`,
      );
    }
}

/** Author one intent (an op LIST + one bump flag) from the replica's own fold. Refused while a rebase runs (D9). */
function author(
  w: World,
  id: string,
  raw: StoreOp | readonly StoreOp[],
  opt: { bump?: boolean; lower?: (op: SyncOp) => SyncOp; reauthorOf?: string } = {},
): TailEntry | null {
  const rep = w.replicas.get(id) as Replica;
  if (rep.rebase && !w.variant.authorDuringRebase) {
    count(w, 'authorBlockedByRebase');
    return null;
  }
  const raws = Array.isArray(raw) ? (raw as readonly StoreOp[]) : [raw as StoreOp];
  const intent: Intent = {
    id: `${id}:${++rep.intents}`,
    replica: id,
    raws,
    bump: !!opt.bump,
    reauthorOf: opt.reauthorOf,
  };
  // R17-1 HONEST STAMPING: cite only what the relay delivered (welcome, sequenced delta) or own dots —
  // the replica still FOLDS peer copies for display, it never cites them; n42 stamps from the full view
  let ops = (w.variant.citePeer ? rep.u : rep.rk).stamp(raws, { bump: intent.bump });
  if (opt.lower) ops = ops.map(opt.lower);
  disciplineCheck(w, rep, ops);
  w.clock += 1;
  rep.version += 1;
  const env: OpEnvelope = {
    proto: MESH_PROTO_VERSION,
    instance: rep.instance,
    policyVersion: 0,
    origin: rep.origin,
    writer: rep.id,
    version: rep.version,
    hlc: { p: w.clock, l: 0 },
    ops,
  };
  engineCheck(w, rep, env, opt.reauthorOf ? 'reauthor' : 'fresh');
  return put(w, rep, intent, env);
}

// ─── ingress, refusal, welcomes ─────────────────────────────────────────────

/** Classify a tail entry that will never be admitted (durable with the client record). */
function classify(w: World, rep: Replica, t: TailEntry, kind: 'conflicts' | 'discarded'): void {
  rep.pending.push({ id: t.intent.id, kind });
  count(w, kind);
  if (w.leaked.has(t.intent.id)) count(w, `censusLeak:${kind}`); // n39: counted, never hidden
}

const selfCite = (e: OpEnvelope, c: Dot): boolean =>
  c.origin === e.origin && compareHlc(c.hlc, e.hlc) === 0;
const modeOf = (w: World): CoversMode => ({
  noExtent: w.variant.noExtent,
  unflooredExempt: w.variant.unflooredExempt,
  firstStampBoundary: w.variant.firstStampBoundary,
});
const relayCtx = (core: RelayCore): CoversCtx => ({
  extent: core.extent,
  preCutMax: core.preCutMax,
  admission: core.admission,
});
/** The client's covers context: its OWN record (generation fields + admission), never global history. */
const repCtx = (rep: Replica): CoversCtx => ({
  extent: rep.gen.extent,
  preCutMax: rep.gen.preCutMax,
  admission: rep.admission,
});

type RelayAnswer =
  'admitted' | 'duplicate' | 'order' | 'generation' | 'epoch-bump' | 'unknown-citation';

/**
 * Relay ingress: instance fence (D10), C5 duplicate/order, the epoch-bump gate, and — for REPLAYED
 * and RE-AUTHORED envelopes — the citation rule (D-b): the relay actually REFUSES, and the refusal
 * reaches the author as a `drop`, which lands in Conflict.
 */
function toRelay(w: World, e: OpEnvelope, first = true): RelayAnswer {
  const r = w.relay;
  if (e.instance !== r.instance) {
    const sender = ownerOf(w, e.origin);
    if (sender && sender.instance !== r.instance) postWelcome(w, sender); // the refusal rehydrates (C7)
    return 'generation';
  }
  if (r.admission.admitted.has(keyOfEnv(e))) {
    acked(w, e);
    return 'duplicate';
  }
  const was = r.refused.get(keyOfEnv(e));
  if (was && !w.variant.forgetRefusals) {
    // F-9: refused stays refused. D-b″: every resend is ANSWERED with the same `drop` (idempotent), so an
    // author that crashed before persisting its Conflict learns it now; n30 = the silent fast path
    if (!w.variant.silentRefusals) reply(w, e, was);
    return was === 'refused-epoch' ? 'epoch-bump' : 'unknown-citation';
  }
  const intent = w.envIntent.get(gkey(e));
  // statistics / classification ONLY (R16-6): the admission path below never reads them
  const kind = w.replayed.has(gkey(e)) ? 'replay' : intent?.reauthorOf ? 'reauthor' : 'fresh';
  if (intent?.reauthorOf) count(w, 'reauthorDelivered');
  if (e.version < maxOf(r.admission, e.origin)) {
    if (intent && first && !outcomeOf(w, intent.id).admitted)
      fail(w, 'T3-order', `${gkey(e)} (${intent.id}) dropped as out of order`);
    return 'order';
  }
  for (const op of e.ops) {
    if ((op.epoch ?? 0) > r.c.maxEpoch(op.path) && !w.canBump(e.writer)) {
      // every refusal of an author's own envelope reaches it and lands in Conflict (D-b, C7)
      freshRefused(w, e, kind, 'epoch-bump');
      if (ownerOf(w, e.origin)) drop(w, e, 'refused-epoch');
      return 'epoch-bump';
    }
  }
  // R16-6 UNIFORM GATE: the ruled covers rule on EVERY envelope (fresh, replayed, re-authored —
  // no wire discriminator); per cite, against the oracle over the relay's own generation view.
  // n40 restores r5's harness-only discrimination (fresh writes unverified)
  const view = relayOracleView(w);
  let refuse = false;
  for (const op of w.variant.ungatedFresh && kind === 'fresh' ? [] : e.ops) {
    for (const c of op.cites ?? []) {
      if (selfCite(e, c)) continue;
      const ok = admits(r.c, relayCtx(r), op.path, c, modeOf(w));
      const bad = !oCovered(view, op.path, c); // per cite AND per path
      if (bad) count(w, ok ? 'tripwireMiss' : 'tripwireCaught');
      if (bad && ok)
        fail(w, 'tripwire', `${gkey(e)}: the relay admits uncovered cite ${c.origin}@${c.hlc.p}`);
      if (!bad && !ok)
        fail(
          w,
          'D6-refusal',
          `${gkey(e)}: the relay refuses cite ${c.origin}@${c.hlc.p} its own generation holds`,
        );
      if (!ok) refuse = true;
    }
  }
  count(w, `gate:${kind}`);
  if (refuse) {
    count(w, `gateRefused:${kind}`);
    freshRefused(w, e, kind, 'unknown-citation');
    drop(w, e, 'refused-cite');
    return 'unknown-citation';
  }
  if (kind !== 'fresh' && !w.canBump(e.writer)) {
    // F-4 reach: an unauthorized replay admitted only because the seed carried a retained baseline
    const regs = r.c.checkpoint();
    const decided = e.ops.some((op) => {
      const reg = regs.find((x) => pathKey(x.path) === pathKey(op.path));
      return (op.epoch ?? 0) > Math.max(0, ...(reg?.siblings ?? []).map((x) => x.epoch));
    });
    if (decided) count(w, 'reachF4');
  }
  if (w.recovered) applyEntry(w.recovered, { kind: 'env', env: e }); // C8: the recovered twin keeps pace
  const entry: JournalEntry = { kind: 'env', env: e };
  applyEntry(r, entry);
  w.journal.push(entry);
  w.seqOf.set(gkey(e), w.journal.length);
  lAck(w.ledger, e);
  w.held.push({ origin: e.origin, hlc: e.hlc });
  if (compareHlc(e.hlc, w.maxHlc) > 0) w.maxHlc = e.hlc;
  if (intent) {
    const o = outcomeOf(w, intent.id);
    if (intent.reauthorOf) count(w, 'reauthorAdmitted');
    o.admitted += 1;
    if (o.admitted > 1)
      fail(w, 'T3-double', `intent ${intent.id} admitted twice (latest ${gkey(e)})`);
    if (o.conflicts || o.discarded)
      fail(w, 'T3', `intent ${intent.id} admitted after it was classified`);
  }
  acked(w, e);
  if (w.budget !== undefined) enforceBudget(w, w.budget); // bounded delay: never waits for a lull
  return 'admitted';
}

/**
 * R17-1 D6′ STRENGTHENED: a relay refusal of an honest FRESH write (fresh or re-authored) is
 * unreachable. Under n42 (peer-held cites) it is reached and must still land in Conflict.
 */
function freshRefused(w: World, e: OpEnvelope, kind: string, why: RelayAnswer): void {
  if (kind === 'replay' || !w.envIntent.has(gkey(e))) return;
  count(w, 'freshRefused');
  fail(w, 'D6-fresh', `${gkey(e)} (${kind}) refused at the relay (${why})`);
}

/** The relay's positive answer reaches the author (R16-5 readiness only; D7 trims by receipts alone). */
function acked(w: World, e: OpEnvelope): void {
  const o = ownerOf(w, e.origin);
  if (!o || o.instance !== e.instance) return;
  o.acked.add(keyOfEnv(e));
  declare(w, o); // the outbox may have emptied
}

/** D-b: the relay journals the refusal (F-9) and replies `drop`; the author records a Conflict. */
function drop(w: World, e: OpEnvelope, cause: ConflictCause): void {
  const row: JournalEntry = { kind: 'refuse', key: keyOfEnv(e), cause };
  applyEntry(w.relay, row);
  w.journal.push(row);
  if (w.recovered) applyEntry(w.recovered, row);
  count(w, 'relayRefusals');
  w.refused.add(gkey(e));
  reply(w, e, cause);
}
/**
 * The `drop` REPLY at the author (D-b, D-b″): the outbox entry becomes a Conflict and a
 * same-generation welcome is requested (the rehydrate retracts the optimistic local effect). A reply
 * for an envelope no longer in the outbox (already a Conflict) is a duplicate and changes nothing.
 */
function reply(w: World, e: OpEnvelope, cause: ConflictCause): void {
  const rep = ownerOf(w, e.origin);
  if (!rep || w.variant.ignoreDrop) return;
  count(w, 'refusalReplies');
  const i = rep.tail.findIndex((t) => gkey(t.env) === gkey(e));
  if (i < 0) {
    count(w, 'refusalDuplicates'); // a duplicate of an already-refused envelope
    return;
  }
  const [t] = rep.tail.splice(i, 1);
  rep.unresolved.push({ entry: t, cause });
  classify(w, rep, t, 'conflicts');
  count(w, 'refusalConflicts');
  declare(w, rep); // a Conflict classified (R16-5)
  if (w.refused.has(gkey(e)) && rep.resendOwed) count(w, 'refusalRelearned'); // learned on resend after a crash
  // R16-2: rehydration is OWED (durable with the record) until a welcome with seq ≥ this one installs
  const seq = w.journal.length;
  (w.owedTruth.get(rep.id) as Map<string, number>).set(gkey(e), seq);
  if (!w.variant.noOwed) rep.rehydrateOwed = owedAfterRefusal(rep.rehydrateOwed, seq); // S3: the session's
  postWelcome(w, rep); // the refusal rehydrates: a same-generation welcome drops the refused op locally
}

/**
 * Replica ingress: a RELAY delta (sequenced: the relay admitted the envelope, the delivery carries
 * its seq) or a PEER copy (unsequenced: the relay has not admitted it). D10 fences any other
 * generation. R16-3: sequence knowledge (`maxSeq`, `seen`) advances on EVERY relay-delivered
 * envelope of this generation, ingested or deduplicated (n38: only when ingested — r5); a peer copy
 * is retained (`peerHeld`) until its relay echo arrives or it is fenced.
 */
function toReplica(w: World, e: OpEnvelope, rep: Replica): 'ok' | 'dup' | 'future' | 'dead' {
  const seq = w.seqOf.get(gkey(e));
  const echoed = w.peerIngested.get(rep.id) as Set<string>;
  if (e.instance !== rep.instance && !w.variant.noReplicaFence) {
    count(w, 'fenced');
    return genOf(w, e.instance).index > genOf(w, rep.instance).index ? 'future' : 'dead';
  }
  const relayed = seq !== undefined && e.instance === rep.instance;
  const learnSeq = (): void => {
    rep.maxSeq = Math.max(rep.maxSeq, seq as number);
  };
  if (relayed) {
    // VERIFIER: the delivered history (the welcome-order property reads this, never the subject's state)
    (w.relayDelivered.get(rep.id) as Set<string>).add(gkey(e));
    if (rep.peerHeld.delete(gkey(e))) count(w, 'peerEchoed'); // the echo arrived: no longer held
    echoed.delete(gkey(e));
    if (!w.variant.dedupBeforeSeq) learnSeq();
  }
  if (!admit(rep.admission, e) && !w.variant.noReplicaDedup) {
    if (relayed) count(w, 'echoDeduplicated');
    // R17-1: the relay echo of an envelope the replica already holds (a peer copy) makes it relay-known
    if (relayed && rep.admission.admitted.has(keyOfEnv(e))) rep.rk.ingest(e);
    return 'dup';
  }
  if (e.instance !== rep.instance)
    fail(w, 'T2c', `${rep.id} on ${rep.instance} ingested ${gkey(e)}`);
  ingestApply(w, rep, e, false, relayed);
  if (relayed && w.variant.dedupBeforeSeq) learnSeq(); // n38: r5 — only an INGESTED delivery teaches seq
  if (seq === undefined && e.instance === rep.instance) {
    rep.peerHeld.set(gkey(e), e);
    echoed.add(gkey(e));
    count(w, 'peerCopies');
  }
  return 'ok';
}

/**
 * The relay posts a welcome MESSAGE from its own core: the cut's own welcome carries the seed, a
 * later one the current registers; both the record fields and admission / receipts as of `seq`.
 */
function postWelcome(w: World, rep: Replica, seed?: readonly RegisterCheckpoint[]): void {
  const g = genOf(w, w.relay.instance); // the relay's own persisted cut row (index, policy)
  rep.inbox.push({
    instance: g.instance,
    index: g.index,
    seq: w.journal.length,
    policy: g.policy,
    ...(seed ? { seed } : { registers: w.relay.c.checkpoint() }),
    extent: w.relay.extent,
    preCutMax: w.relay.preCutMax,
    admission: cloneAdmission(w.relay.admission),
    receipts: cloneReceipts(w.relay.receipts),
  });
}

/**
 * D-d: deliver one queued welcome. Accept iff its instance is newer in the chain, or the same
 * instance with seq ≥ the installed one; otherwise it is stale and ignored. Installation is ATOMIC
 * (registers + instance/seq/admission + outbox trim/rebase persist as one record); `crashAt`
 * crashes after stage 1 (registers), 2 (instance/admission) or 3 (outbox) — n18 persists per stage.
 */
function deliverWelcome(w: World, rep: Replica, index: number, crashAt?: number): void {
  const [msg] = rep.inbox.splice(index, 1);
  if (!msg) return;
  // S3: the REAL client fence (the session's `welcomeVerdict`); n21 / n34 override its answer here
  const verdict = welcomeVerdict(
    { index: rep.gen.index, instance: rep.instance, seq: rep.seq, maxSeq: rep.maxSeq },
    msg,
  );
  const newer = verdict === 'newer';
  // R16-2: a rejected welcome while a rehydration is owed is RE-REQUESTED (hello without seq)
  const retry = (): void => {
    // r9: a restarted no-persist replica keeps asking until a welcome installs (one hello per burst)
    if (rep.rehydrateOwed === undefined && rep.installed) return;
    count(w, 'rehydrateRetries');
    postWelcome(w, rep);
  };
  if (verdict === 'stale' && !w.variant.acceptStale) {
    count(w, 'welcomeStale');
    return retry();
  }
  // §14: a same-generation snapshot OLDER than traffic already ingested would replace it — ignored
  if (verdict === 'older-than-traffic' && !w.variant.acceptOlderSnapshot) {
    count(w, 'welcomeOlderThanTraffic');
    return retry();
  }
  const g = genOf(w, msg.instance); // VERIFIER only: the census record and the welcome-content check
  const regs = msg.seed ?? (msg.registers as readonly RegisterCheckpoint[]);
  if (msg.seed && pcanon(msg.seed) !== pcanon(g.seed))
    fail(w, 'welcome', `${msg.instance} cut welcome carries a seed other than the cut's`);
  if (extentCanon(msg.extent) !== extentCanon(g.extent) && !w.variant.checkpointNoExtent)
    fail(w, 'welcome', `${msg.instance} welcome carries an extent other than the cut's`);
  if (!newer) {
    // D-b″: RESEND the outbox before own un-admitted writes are treated as live — a refused envelope
    // is answered again (`drop` ⇒ Conflict + rehydrate) instead of being re-applied as pending
    for (const t of rep.tail.filter(
      (x) => x.instance === msg.instance && !msg.admission.admitted.has(keyOfEnv(x.env)),
    ))
      if (rep.tail.includes(t)) toRelay(w, t.env);
  }
  // stage 1: registers; own writes of that generation the welcome has NOT admitted stay applied
  // locally. Re-applying an ADMITTED one over a collected welcome would resurrect evidence the relay
  // collected (C5 at installation; n26)
  const own = rep.tail.filter(
    (t) =>
      t.instance === msg.instance &&
      (w.variant.reapplyAdmitted || !msg.admission.admitted.has(keyOfEnv(t.env))),
  );
  rep.u = foldOf(rep.cfg, rep.origin);
  rep.u.load(regs);
  rep.c = foldOf(rep.cfg, rep.origin);
  rep.c.load(regs);
  rep.rk = foldOf(rep.cfg, rep.origin);
  rep.rk.load(regs);
  rep.cov = storeOf(regs);
  rep.applied = new Map(); // a new fold lifetime: the application store rehydrates from the welcome
  for (const t of own) ingestApply(w, rep, t.env, true);
  if (w.variant.nonAtomicInstall) persist(w, rep);
  if (crashAt === 1) return reload(w, rep);
  // stage 2: instance, seq, admission evidence (the extent and preCutMax are bound to the instance)
  const wasRebase = !!rep.rebase;
  rep.instance = msg.instance;
  rep.seq = msg.seq;
  rep.gen = { index: msg.index, policy: msg.policy, extent: msg.extent, preCutMax: msg.preCutMax };
  rep.admission = cloneAdmission(msg.admission);
  for (const t of own) admit(rep.admission, t.env);
  // R16-3: peer-held envelopes of this generation the snapshot has not admitted are RE-INGESTED
  // through the same ingress (idempotent); those of another generation are fenced and dropped. The
  // ingress's C5 rule refuses one below its origin's admitted maximum: under A1 (per-origin FIFO) the
  // relay admitted a later version of that origin and not this one, i.e. refused it — dropped too
  for (const [k, e] of [...rep.peerHeld]) {
    if (e.instance !== msg.instance) {
      rep.peerHeld.delete(k);
      continue;
    }
    if (rep.admission.admitted.has(keyOfEnv(e)) || w.variant.noPeerRetain) continue;
    if (!admit(rep.admission, e)) {
      rep.peerHeld.delete(k);
      count(w, 'peerOrderDropped');
      continue;
    }
    ingestApply(w, rep, e, false);
    count(w, 'peerReingested');
    if (w.refused.has(k)) count(w, 'peerRefusedRetained'); // a refusal its holder cannot learn (finding)
  }
  if (w.variant.nonAtomicInstall) persist(w, rep);
  if (crashAt === 2) return reload(w, rep);
  // stage 3: a newer generation trims the outbox by the receipt chain and applies the tail policy
  if (newer) {
    if (wasRebase) count(w, 'cutDuringReplay');
    // S3 + R26-1 (charter §26): the REAL trim (the session's `trimByReceipts`: version order, exact
    // membership of the version in the UNION over every instance of its origin's receipts); the
    // harness keeps only the hole count and the n2 / F-5 / n45 variants
    const prior = [...rep.tail, ...(rep.rebase?.remaining ?? [])].filter(
      (t) => t.instance !== msg.instance,
    );
    const real = w.variant.trimPerInstance
      ? trimPerInstance(prior, msg.receipts)
      : trimByReceipts(prior, w.variant.noReceipts ? {} : receiptsWire(msg.receipts));
    // R26-1: a version held by ANY instance of its origin's receipts was admitted
    const heldAnywhere = (t: TailEntry): boolean =>
      !w.variant.noReceipts &&
      [...(msg.receipts.get(t.env.origin)?.values() ?? [])].some((x) => x.versions.has(t.version));
    const pending = [...real.trimmed, ...real.keep].sort(
      (a, b) => a.version - b.version || (a.env.origin < b.env.origin ? -1 : 1),
    );
    const trimmedByReal = new Set(real.trimmed);
    rep.tail = rep.tail.filter((t) => t.instance === msg.instance);
    const keep: TailEntry[] = [];
    for (const t of pending) {
      const rc = w.variant.noReceipts ? undefined : msg.receipts.get(t.env.origin)?.get(t.instance);
      if (rc && t.version <= rc.through && !rc.versions.has(t.version) && !heldAnywhere(t)) {
        count(w, 'holesBelowThrough');
        if (w.variant.trimByMax)
          fail(
            w,
            'D7-hole',
            `${gkey(t.env)} (${t.intent.id}) trimmed by admittedThrough ${rc.through} but never admitted: LOST`,
          );
      }
      if (trimmedByReal.has(t) || (!!rc && !!w.variant.trimByMax && t.version <= rc.through)) {
        rep.pending.push({ id: t.intent.id, kind: 'trimmed' });
        count(w, 'trimmed');
        continue;
      }
      keep.push(t);
    }
    // `T3-recrash` (r9 finding, closed by R26-1; ASSERTED since r9.1): an entry the receipt trim
    // KEEPS although its intent was already admitted — its replay reached the wire before a crash
    // lost the replayed outbox entry, was admitted under the replay's generation, and the record
    // still holds the ORIGINAL entry of an earlier generation. The detector stays as a counter
    // (`recrashKept`); under the ruled trim it is empty, under n45 it is the first line to fire
    for (const t of keep) {
      if (!outcomeOf(w, t.intent.id).admitted || w.variant.noReceipts) continue;
      // exactly this path: the receipt chain names the SAME (origin, version) under a later instance
      const other = [...(msg.receipts.get(t.env.origin) ?? [])].some(
        ([i, x]) => i !== t.instance && x.versions.has(t.version),
      );
      if (!other) continue;
      count(w, 'recrashKept');
      fail(
        w,
        'T3-recrash',
        `${rep.id} installs ${msg.instance} and keeps ${gkey(t.env)} (${t.intent.id}) though the intent was admitted: receipts ${receiptsCanon(msg.receipts)}`,
      );
    }
    const leaked = keep.filter((t) => g.censusPending?.has(t.intent.id));
    for (const t of leaked) w.leaked.add(t.intent.id);
    count(w, 'censusLeaked', leaked.length);
    if (leaked.length)
      fail(
        w,
        'consensus',
        `${rep.id} was ready at ${g.instance} yet replays ${leaked.map((t) => t.intent.id)}`,
      );
    if (msg.policy === 'discard') {
      for (const t of keep) classify(w, rep, t, 'discarded');
      rep.rebase = undefined;
    } else {
      rep.rebase = keep.length ? { remaining: keep } : undefined;
    }
    rep.pressed = false;
  }
  if (crashAt === 3) {
    if (w.variant.nonAtomicInstall) persist(w, rep);
    return reload(w, rep);
  }
  // D3″ client half: floors = own retained siblings' epochs ∪ own re-applied writes' epochs
  const want = new Map<string, number>();
  const up = (k: string, e: number) => e > 0 && want.set(k, Math.max(want.get(k) ?? 0, e));
  for (const r of regs)
    for (const s of r.siblings) if (s.origin === rep.origin) up(pathKey(r.path), s.epoch);
  for (const t of own) for (const op of t.env.ops) up(pathKey(op.path), op.epoch ?? 0);
  const have = new Map(rep.u.emissionFloors().map((f) => [pathKey(f.path), f.epoch]));
  if (JSON.stringify([...want].sort()) !== JSON.stringify([...have].sort()))
    fail(w, 'T2b', `${rep.id} floors ${JSON.stringify([...have])} vs ${JSON.stringify([...want])}`);
  count(w, newer ? 'installNewer' : 'installSame');
  if (!rep.installed) count(w, 'installAfterRestart');
  rep.installed = true;
  rep.resendOwed = false;
  if (newer) {
    rep.maxSeq = 0;
  }
  // §14 + R16-3 against the DELIVERED history (a verifier record, never the subject's state): every
  // relay-delivered envelope of this generation — ingested or deduplicated — survives the install
  const lost = [...(w.relayDelivered.get(rep.id) as Set<string>)]
    .filter((g) => g.startsWith(`${msg.instance}:`))
    .map((g) => g.slice(msg.instance.length + 1))
    .filter((k) => !rep.admission.admitted.has(k));
  if (lost.length)
    fail(
      w,
      'welcome-order',
      `${rep.id} installed ${msg.instance}@${msg.seq} and lost ingested ${lost}`,
    );
  // R16-3 against the delivered history (verifier record): a peer copy not yet echoed survives the install
  const peers = w.peerIngested.get(rep.id) as Set<string>;
  for (const g of [...peers]) {
    if (!g.startsWith(`${msg.instance}:`)) {
      if (newer) peers.delete(g); // fenced with its generation
      continue;
    }
    const k = g.slice(msg.instance.length + 1);
    const [origin, version] = k.split('#');
    const skipped = maxOf(msg.admission, origin) > Number(version); // the relay admitted past it: refused
    if (!rep.admission.admitted.has(k) && !skipped)
      fail(
        w,
        'peer-retain',
        `${rep.id} installed ${msg.instance}@${msg.seq} and lost peer copy ${g}`,
      );
  }
  // D-b″ holds within a generation: once the relay has cut, the old generation's refusals are gone
  // and the envelope's fate is its replay (the across-cut F-11 route, reported as `refusalAcrossCut`)
  for (const t of own) {
    if (!w.refused.has(gkey(t.env))) continue;
    if (w.relay.instance !== msg.instance) count(w, 'refusalAcrossCut');
    else fail(w, 'D6-drop', `${rep.id} re-applied refused ${gkey(t.env)} as a pending own write`);
  }
  // R16-2: an installed welcome at or past the owed refusal completes the rehydration
  const wasOwed = rep.rehydrateOwed;
  // S3: the session's; N6 (`owedClears`) = the S3 neuter, an install clears the flag whatever its seq
  rep.rehydrateOwed = w.variant.owedClears
    ? undefined
    : owedAfterInstall(rep.rehydrateOwed, msg.seq);
  if (wasOwed !== undefined && rep.rehydrateOwed === undefined) count(w, 'rehydrateCompleted');
  // charter §24 (D-S3-5, R16-2 "keeps requesting"): an install BELOW the owed seq does not complete
  // the rehydration — the client asks for a snapshot again
  if (rep.rehydrateOwed !== undefined && msg.seq < rep.rehydrateOwed) {
    count(w, 'owedReasked');
    postWelcome(w, rep);
  }
  const owed = w.owedTruth.get(rep.id) as Map<string, number>;
  for (const [g, q] of [...owed]) if (msg.seq >= q) owed.delete(g);
  // R16-5: the welcome's admission set tells the client which own envelopes the relay admitted
  if (newer) rep.acked = new Set();
  for (const t of rep.tail)
    if (t.instance === msg.instance && msg.admission.admitted.has(keyOfEnv(t.env)))
      rep.acked.add(keyOfEnv(t.env));
  declare(w, rep);
  persist(w, rep);
}

/** Pins: the relay posts the current welcome and it is installed at once. */
function learn(w: World, rep: Replica): void {
  if (rep.installed && rep.instance === w.relay.instance && !rep.inbox.length) return;
  postWelcome(w, rep);
  deliverWelcome(w, rep, rep.inbox.length - 1);
}

// ─── replay (D5′), resolution (D6′), the cut (D2/D4′), consensus (D-c) ───────

/**
 * One D5′ decision, one ENVELOPE per call (D-e), in version order (D9). The procedure runs the
 * ruled `admits` over the replica's compacted fold (the REAL `RegisterStore.covers`); the oracle
 * reads only its own records. Stages, each a crash point: 1 dequeue, 2 outbox (wire), 3 local
 * ingest, 4 classification. The record persists at the end of the driver step (atomic); n19
 * persists after every stage.
 */
function replayStep(w: World, rep: Replica, crashAt?: number): void {
  replayOne(w, rep, crashAt);
  declare(w, rep); // the replay may have finished (R16-5)
}
function replayOne(w: World, rep: Replica, crashAt?: number): void {
  const rb = rep.rebase;
  if (!rb) return;
  if (!rep.installed) {
    count(w, 'replayWaitsForInstall'); // r9: after a no-persist restart, D9 = install first
    return;
  }
  const stage = (k: number): boolean => {
    if (w.variant.nonAtomicReplay) persist(w, rep);
    if (crashAt !== k) return false;
    reload(w, rep);
    return true;
  };
  const t = rb.remaining.shift() as TailEntry;
  if (!rb.remaining.length) rep.rebase = undefined;
  if (stage(1)) return;
  const env: OpEnvelope = { ...t.env, instance: rep.instance }; // verbatim: same ops, dots, version
  const st = rep.cov; // P-2: the maintained client store
  const ctx = repCtx(rep);
  // P-2 equivalence: the maintained store answers `admits` exactly as the C fold's registers would
  const viaFold = storeOf(rep.c.checkpoint());
  for (const op of env.ops)
    for (const c of op.cites ?? [])
      if (admits(st, ctx, op.path, c) !== admits(viaFold, ctx, op.path, c))
        fail(
          w,
          'compaction',
          `${rep.id}: client covers store and C fold disagree on ${c.origin}@${c.hlc.p}`,
        );
  // S3: the REAL client pre-check (the session's `uncoveredCites` over the maintained store)
  const covered = clientCovered(st, ctx, env, modeOf(w));
  // reach counters: a cite held ONLY by the frozen extent (F-2a); a pre-cut cite of a dropped dot
  // whose origin wrote again at the path in this generation (F-7)
  const g = genOf(w, rep.instance);
  for (const op of env.ops) {
    for (const c of op.cites ?? []) {
      if (selfCite(env, c)) continue;
      const pre = g.preCutMax[c.origin];
      const isPre = !!pre && compareHlc(c.hlc, pre) <= 0;
      if (isPre && admits(st, ctx, op.path, c) && !st.covers(op.path, c)) count(w, 'reachF2a');
      if (isPre && !admits(st, ctx, op.path, c) && st.covers(op.path, c)) count(w, 'reachF7');
    }
  }
  const verdict = oracleDecide(oracleView(w, rep), env);
  if ((covered ? 'apply' : 'conflict') !== verdict) {
    fail(
      w,
      covered ? 'T2a' : 'T2a-gc',
      `${t.intent.id} ${gkey(env)}: procedure ${covered ? 'apply' : 'conflict'}, oracle ${verdict}; cites ${JSON.stringify(env.ops.map((o) => [o.path, o.cites]))}`,
    );
  }
  const authorized = !t.intent.bump || w.canBump(rep.id); // OPEN-5: a revoked bump is surfaced
  if ((!covered && !w.variant.noPrecheck) || !authorized) {
    rep.unresolved.push({ entry: t, cause: authorized ? 'uncovered' : 'unauthorized' });
    if (stage(2)) return;
    classify(w, rep, t, 'conflicts');
    stage(4);
    return;
  }
  engineCheck(w, rep, env, 'replay');
  wireCheck(w, env);
  // stage 2: outbox + wire
  rep.tail.push({ intent: t.intent, instance: env.instance, version: env.version, env });
  w.envs.set(gkey(env), env);
  w.envIntent.set(gkey(env), t.intent);
  w.replayed.add(gkey(env));
  if (!w.authored.has(env.origin)) w.authored.set(env.origin, []);
  (w.authored.get(env.origin) as OpEnvelope[]).push(env);
  for (const op of env.ops)
    w.dots.push({
      instance: env.instance,
      path: op.path,
      dot: { origin: env.origin, hlc: env.hlc },
    });
  if (stage(2)) return;
  // stage 3: local ingest
  admit(rep.admission, env);
  ingestApply(w, rep, env, true);
  if (stage(3)) return;
  count(w, 'applied');
  stage(4);
}

/** D6′: resolve one conflict — discard, or write the raw LIST again as a NEW op (re-author). */
function resolve(w: World, rep: Replica, reauthor: boolean): void {
  if (rep.rebase && !w.variant.authorDuringRebase) return; // fresh emission only after the replay (D9)
  const c = rep.unresolved.shift();
  if (!c) return;
  if (!reauthor) {
    count(w, 'discardedByUser');
    return;
  }
  const bump = c.entry.intent.bump && w.canBump(rep.id);
  if (author(w, rep.id, c.entry.intent.raws, { bump, reauthorOf: c.entry.intent.id }))
    count(w, 'reauthored');
}

/**
 * T3 (verifier-owned): every undischarged acknowledged op is retained with full identity in `store`
 * and LIVE there unless a current mark requires its suppression (R19-1), and every acknowledged cite
 * of this generation SUPPRESSES what it cites (R16-1); a dot cited in an earlier generation never
 * comes back live (`T3-resurrect`; the ghost is outside A1).
 */
function ledgerCheck(w: World, store: Store, label: string): void {
  const regs = store.checkpoint();
  const missing = lMissing(w.ledger, regs);
  if (missing.length)
    fail(w, 'ledger', `${label}: ${missing.length} acked op(s) lost, ${missing[0]}`);
  if (!w.variant.r7Ledger) {
    const hidden = lHiddenRecs(w.ledger, regs);
    count(w, 'hiddenJustified', hidden.filter((x) => x.justified).length);
    const bad = hidden.filter((x) => !x.justified);
    if (bad.length) fail(w, 'ledger', `${label}: ${bad.length} ${bad[0].why}`);
  }
  const live = lSuppress(w.ledger.marks, regs);
  if (live.length)
    fail(w, 'ledger', `${label}: ${live.length} acked supersession(s) lost, ${live[0]}`);
  const back = lSuppress(w.ledger.oldMarks, regs, (o) => o === 'G');
  for (const line of back) fail(w, 'T3-resurrect', `${label}: ${line}`);
  count(w, 'ledgerChecks');
}

/** The cut (D2, atomic at a journal boundary): seed per D4′/D-a′ (reaper, consensus) or minted. */
function cut(
  w: World,
  reason: Reason,
  policy: Policy,
  source?: readonly RegisterCheckpoint[],
  census?: readonly Replica[],
): Gen {
  const keeps = reason === 'reaper' || reason === 'consensus';
  ledgerCheck(w, w.relay.c, 'before the cut');
  // n43b: AFTER the last check, hide the newest acked (non-instance origin) live `set` on both twins
  let hid: { path: readonly Key[]; dot: Dot } | undefined;
  if (w.variant.excessWatermarkAtCut && keeps) {
    for (const r of w.relay.c.checkpoint()) {
      if (!r.path.length) continue;
      for (const x of w.relay.c.siblings(r.path))
        if (
          x.kind === 'set' &&
          !genInstance(w, x.origin) &&
          (!hid || compareHlc(x.hlc, hid.dot.hlc) > 0)
        )
          hid = { path: r.path, dot: { origin: x.origin, hlc: x.hlc } };
    }
    if (hid) {
      excessWater([w.relay.u, w.relay.c], hid.path, hid.dot.origin, hid.dot.hlc);
      count(w, 'excessAtCut');
    }
  }
  // n43c (audit #5): at the same point, REMOVE the newest acked (non-instance) live `set`'s register
  let gone: { path: readonly Key[]; dot: Dot } | undefined;
  if (w.variant.dropRegisterAtCut && keeps) {
    for (const r of w.relay.c.checkpoint()) {
      if (!r.path.length) continue;
      for (const x of w.relay.c.siblings(r.path))
        if (
          x.kind === 'set' &&
          !genInstance(w, x.origin) &&
          (!gone || compareHlc(x.hlc, gone.dot.hlc) > 0)
        )
          gone = { path: r.path, dot: { origin: x.origin, hlc: x.hlc } };
    }
    if (gone) {
      dropRegister([w.relay.u, w.relay.c], gone.path);
      count(w, 'dropAtCut');
    }
  }
  const pre = w.relay.c.checkpoint();
  if (pcanon(materializeRegs(w.relay.u.checkpoint())) !== pcanon(materializeRegs(pre)))
    fail(w, 'compaction', `relay twins materialize differently at the cut`);
  const src = source ?? pre;
  const index = w.gens.length;
  const instance = `g${index}`;
  let seed: RegisterCheckpoint[];
  if (keeps) seed = reaperSeed(src, w.variant);
  else {
    w.maxHlc = { p: w.maxHlc.p, l: w.maxHlc.l + 1 }; // a minted dot above every admitted stamp
    seed = mintedSeed(materializeRegs(src), instance, w.maxHlc);
  }
  if (keeps) {
    for (const m of oStructural(src, seed)) fail(w, 'T1', `${instance} (${reason}): ${m}`);
    // reach: registers each D-a′ clause decides (kept multi-live; clear-only dropped though contained)
    const st = createRegisterStore();
    st.load(src);
    const all = liveRegs(src, st);
    const ruled = keepRule(all);
    const noMulti = keepRule(all, { dropMultiLive: true });
    const clearMasks = keepRule(all, { clearMasks: true });
    for (const x of all) {
      if (ruled(x) && !noMulti(x)) count(w, 'keptMultiLive');
      if (!ruled(x) && clearMasks(x)) count(w, 'droppedClearMasked');
    }
  }
  // r9 POSITIONAL ARRAYS: the path-closure lemmas over the REAL fold (L1 closed, L2 protection), the
  // explicit `positional` policy (n44: a non-closed ancestor merge) and the no-policy default alike
  const posCfg: FoldCfg = w.variant.ancestorMerge ? 'ancestor' : 'positional';
  const idxMode = keeps && oIndexMode(src);
  if (keeps) {
    for (const mode of [w.variant.ancestorMerge ? 'ancestor' : 'policy', 'default'] as const) {
      const v = oPositional(src, mode);
      for (const m of v.violations) fail(w, 'positional-closure', `${instance} (${reason}): ${m}`);
      if (mode === 'default') continue;
      count(w, 'posArrayRegisters', v.arrays);
      count(w, 'posFolds', v.folds);
      count(w, 'posSynth', v.synth);
    }
    count(w, idxMode ? 'cutsIndexMode' : 'cutsUnitMode');
    if (
      !idxMode &&
      src.some((r) => oLive(r).some((x) => x.kind === 'set' && Array.isArray(x.value)))
    )
      count(w, 'cutsUnitArrays');
  }
  for (const cfg of keeps ? [...FOLD_CFGS, posCfg] : (['default'] as const)) {
    const before = pcanon(materializeRegs(src, cfg));
    const after = pcanon(materializeRegs(seed, cfg));
    if (before !== after) {
      // F-8: under `preserve`, concurrent live tombstones of a set-free register render as a conflict
      // VALUE; a departure the ruled multi-live clause repairs exactly is classed `T1-preserve` (n28).
      // Any other departure under a SYNTHESIZING fold is the declared residual (§14): reported only.
      const residual = RESIDUAL_CFGS.includes(cfg);
      const f8 =
        keeps &&
        cfg === 'preserve' &&
        !!w.variant.dropMultiLive &&
        pcanon(materializeRegs(reaperSeed(src, { ...w.variant, dropMultiLive: false }), cfg)) ===
          before;
      // r9: a departure under the positional fold is `T1-positional` (ASSERTED) when no register sits
      // below an array; with INDEX-mode registers (out of the domain: arrays are UNIT values) it is
      // the reported contrast `T1-index`. The no-policy default (also positional on arrays) stays
      // `T1-diff`, asserted everywhere.
      const pos = cfg === posCfg;
      fail(
        w,
        f8
          ? 'T1-preserve'
          : residual
            ? 'T1-residual'
            : pos
              ? idxMode
                ? 'T1-index'
                : 'T1-positional'
              : 'T1-diff',
        `${instance} (${reason}, ${cfg} fold): source ${before} vs seed ${after}`,
      );
    }
  }
  const seedDots = seed.flatMap((r) => r.siblings.map((s) => ({ origin: s.origin, hlc: s.hlc })));
  const preCutMax: Record<string, Hlc> = { ...w.relay.everMax };
  for (const d of seedDots) raise(preCutMax, d.origin, d.hlc);
  const oPre = oPreCutMax([...w.held, ...seedDots]);
  const implPre = Object.keys(preCutMax)
    .sort()
    .map((o) => [o, preCutMax[o]]);
  const oraPre = [...oPre.keys()].sort().map((o) => [o, oPre.get(o)]);
  if (JSON.stringify(implPre) !== JSON.stringify(oraPre))
    fail(
      w,
      'precut',
      `${instance}: relay preCutMax ${JSON.stringify(implPre)} vs oracle ${JSON.stringify(oraPre)}`,
    );
  const gen: Gen = {
    index,
    instance,
    reason,
    policy,
    source: src,
    seed,
    extent: seedExtent(seed),
    preCutMax,
    oPreCutMax: oPre,
    census: census ? new Set(census.map((r) => r.id)) : undefined,
    censusPending: census
      ? new Set(census.flatMap((r) => r.tail.map((t) => t.intent.id)))
      : undefined,
  };
  w.gens.push(gen);
  const entry: JournalEntry = { kind: 'cut', gen };
  // R20-1: retention over the captured source right before any discharge (a loss after the last check)
  if (!w.variant.r7Ledger) {
    const lost = lMissing(w.ledger, pre);
    if (lost.length)
      fail(
        w,
        'ledger',
        `cut source ${instance} (${reason}): ${lost.length} acked op(s) lost, ${lost[0]}`,
      );
  }
  // a reaper cut drops exactly what D-a′ drops from the relay's store — never a hidden, absent or
  // altered acked effect (R19-1, R20-1)
  for (const m of lCut(w.ledger, pre, !keeps, w.variant.r7Ledger))
    fail(w, 'ledger-discharge', `${instance} (${reason}): ${m}`);
  const h = hid;
  if (h) {
    const at = seed.find((r) => pathKey(r.path) === pathKey(h.path));
    if (!at?.siblings.some((x) => dotEq(x, h.dot))) count(w, 'excessSeedOmits'); // n43b: the loss being caught — the seed omits the hidden value
    // astra's case: D-a′ DROPS the register (the r7 ledger discharged it silently); a KEPT register
    // loses the sibling from the seed and the r7 retention check already named it after the cut
    count(w, oKept(src).has(oPathKey(h.path)) ? 'excessKept' : 'excessDropped');
  }
  const d = gone;
  if (d) {
    const at = seed.find((r) => pathKey(r.path) === pathKey(d.path));
    if (!at?.siblings.some((x) => dotEq(x, d.dot))) count(w, 'dropSeedOmits'); // n43c: the loss being caught
  }
  applyEntry(w.relay, entry);
  w.journal.push(entry);
  if (w.recovered) applyEntry(w.recovered, entry);
  ledgerCheck(w, w.relay.c, `after cut ${instance}`);
  if (w.recovered) ledgerCheck(w, w.recovered.stores[0], `recovered, after cut ${instance}`);
  w.held.push(...seedDots);
  for (const r of seed)
    for (const s of r.siblings)
      w.dots.push({ instance, path: r.path, dot: { origin: s.origin, hlc: s.hlc } });
  w.declared.clear(); // the relay resets every declaration (R16-5)
  for (const rep of w.replicas.values()) {
    rep.pressed = false; // a new generation starts with nobody pressed
    postWelcome(w, rep, seed); // the cut's own welcome carries the immutable seed
  }
  count(w, `cut:${reason}`);
  return gen;
}

/**
 * D-c consensus as a READY STATE, R16-5: readiness is CLIENT-DECLARED. A client's honest value is
 * pressed ∧ connected ∧ no replay running ∧ every own outbox envelope KNOWN admitted (its `acked`);
 * it re-sends `compact { ready }` (with its instance) whenever that value changes — press/unpress,
 * outbox fills/empties, a Conflict classified, an installation, a restart. The relay's predicate
 * reads ONLY the declarations: every connected member declared ready in the relay's instance.
 * Safety never depends on it: a false `ready` only means that member's tail replays under D5′ (n39).
 */
const readyValue = (w: World, rep: Replica): boolean =>
  // S3: the REAL client readiness (the session's); an own envelope known admitted is not outstanding
  clientReadyValue({
    pressed: rep.pressed,
    connected: rep.connected,
    replaying: !!rep.rebase,
    outstanding:
      !!w.variant.dishonestReady && rep.id === 'C'
        ? 0 // n39: declares ready with a tail
        : rep.tail.filter((t) => !(t.instance === rep.instance && rep.acked.has(keyOfEnv(t.env))))
            .length,
  });
/** Send the client's ready flag if it changed (synchronous message; a disconnected member has none). */
function declare(w: World, rep: Replica): void {
  if (!rep.connected) {
    w.declared.delete(rep.id);
    return;
  }
  const ready = readyValue(w, rep);
  const cur = w.declared.get(rep.id);
  if (cur && cur.ready === ready && cur.instance === rep.instance) return;
  w.declared.set(rep.id, { ready, instance: rep.instance });
  count(w, 'declarations');
}
function consensusCheck(w: World): Gen | null {
  const members = [...w.replicas.values()].filter((r) => r.connected);
  const ready = (m: Replica): boolean => {
    const d = w.declared.get(m.id);
    return !!d && d.ready && d.instance === w.relay.instance;
  };
  if (!members.length || !members.every(ready)) return null;
  return cut(w, 'consensus', 'replay', undefined, members);
}

// ─── observation (every step) ────────────────────────────────────────────────

const OBSERVED_PATHS: readonly (readonly Key[])[] = [[], ...PATHS, ...ARRAY_PATHS];
const stampOf = (fold: Fold): unknown =>
  [...PATHS, ...ARRAY_PATHS].map((path) =>
    fold
      .stamp([{ kind: 'set', path, next: 0 }])
      .map((op) => ({ cites: op.cites, epoch: op.epoch, kind: op.kind, path: op.path })),
  );

/** All lone tombstones: a register whose only retained sibling is a delete and that keeps no mark. */
const loneTombstones = (s: Store): RegisterCheckpoint[] =>
  s
    .checkpoint()
    .filter(
      (r) =>
        r.siblings.length === 1 && r.siblings[0].kind === 'delete' && !Object.keys(r.water).length,
    );
/**
 * D11 counts DROPPABLE lone tombstones only, by the D-a′ keep rule the seed builder runs (no fold,
 * no materializer). For a lone tombstone (one live delete) the multi-live clause is vacuous and the
 * containment clause always applies, so the count equals the r4 count — stated, and pinned by Q5/F-3.
 */
function droppableTombstonesScan(s: Store): number {
  const all: LiveReg[] = s.checkpoint().map((r) => ({ path: r.path, live: s.siblings(r.path) }));
  const keep = keepRule(all);
  return loneTombstones(s).filter((t) => !keep({ path: t.path, live: s.siblings(t.path) })).length;
}
/** S2: the real store's MAINTAINED count (P-4); the full scan above is its oracle (class `count`). */
const droppableTombstones = (s: Store): number => s.droppableTombstones();

function observe(w: World): void {
  const relay = w.relay;
  for (const r of w.replicas.values()) {
    recordCheck(w, r);
    const mu = pcanon(r.u.materialize());
    if (mu !== pcanon(r.c.materialize()))
      fail(w, 'compaction', `${r.id} materializes differently between twins`);
    if (JSON.stringify(stampOf(r.u)) !== JSON.stringify(stampOf(r.c)))
      fail(w, 'compaction', `${r.id} stamps differ between twins`);
    if (
      pcanon(materializeRegs(r.u.checkpoint(), r.cfg)) !==
      pcanon(materializeRegs(r.c.checkpoint(), r.cfg))
    )
      fail(w, 'compaction', `joiner from ${r.id} differs`);
    // same op set ⇒ same state, per generation (an other-generation op ingested anywhere breaks it);
    // r9: a restarted no-persist replica holds no view until a welcome installs (its app is loading)
    const ref = foldOf(r.cfg);
    ref.load(genOf(w, r.instance).seed);
    for (const k of [...r.admission.admitted].sort()) {
      const e = w.envs.get(`${r.instance}:${k}`);
      if (e) ref.ingest(e);
    }
    const mr = pcanon(ref.materialize());
    if (mr !== mu && r.installed)
      fail(
        w,
        'converge',
        `${r.id} on ${r.instance} materializes ${mu}, its generation's op set gives ${mr}`,
      );
    // a refused envelope may sit in an outbox only between a crash and the next resend (D-b″)
    for (const t of r.tail)
      if (!r.resendOwed && t.instance === relay.instance && w.refused.has(gkey(t.env)))
        fail(w, 'D6-drop', `${r.id} still holds refused ${gkey(t.env)} in its outbox`);
    // R16-5: an honest client's declaration is its current ready value (every change was re-sent)
    if (r.connected && !(w.variant.dishonestReady && r.id === 'C')) {
      const d = w.declared.get(r.id);
      if (!!d?.ready !== readyValue(w, r) || (d && d.instance !== r.instance))
        fail(
          w,
          'census-flag',
          `${r.id} declared ${JSON.stringify(d)}, its ready value is ${readyValue(w, r)}`,
        );
    }
    // R16-2 D6-visible: once no rehydration is owed for it, no OWN refused envelope is in the
    // replica's view (the op set its materialization equals, `converge`) — compared against the
    // relay's refusals of that generation, never the client's flag
    // (within a generation, like D-b″: once the relay has cut, the refusal is gone and the envelope's
    // fate is its replay — the accepted across-cut F-11 route)
    const owed = w.owedTruth.get(r.id) as Map<string, number>;
    for (const k of r.admission.admitted) {
      const g = `${r.instance}:${k}`;
      if (!w.refused.has(g) || owed.has(g) || relay.instance !== r.instance) continue;
      if (ownerOf(w, k.split('#')[0])?.id !== r.id) continue; // a third party's copy: the R16-3 finding
      fail(w, 'D6-visible', `${r.id} still materializes its refused ${g} with no rehydration owed`);
    }
  }
  // D3″: maxEpoch = seed baselines + retained epochs ∪ the generation's admitted ops, exactly
  const gen = genOf(w, relay.instance);
  for (const path of OBSERVED_PATHS) {
    let expect = 0;
    for (const r of gen.seed) {
      if (pathKey(r.path) !== pathKey(path)) continue;
      expect = Math.max(expect, r.epoch ?? 0, ...r.siblings.map((s) => s.epoch));
    }
    for (const k of relay.admission.admitted) {
      for (const op of w.envs.get(`${relay.instance}:${k}`)?.ops ?? [])
        if (pathKey(op.path) === pathKey(path)) expect = Math.max(expect, op.epoch ?? 0);
    }
    const eu = relay.u.maxEpoch(path);
    if (eu !== relay.c.maxEpoch(path))
      fail(w, 'compaction', `relay maxEpoch(${path}) differs between twins`);
    if (eu !== expect)
      fail(
        w,
        'T2b',
        `${relay.instance}: maxEpoch(${path.join('.')}) ${eu}, retained + generation give ${expect}`,
      );
  }
  // admission answers are compared for dots the room HELD in this generation (seeded or admitted):
  // a refused dot can still carry a supersession mark injected by an unverified fresh write, and that
  // mark's collection changes `covers` (F-10, inside the declared fresh-write non-coverage)
  const heldNow = new Set(
    gen.seed.flatMap((r) => r.siblings.map((s) => `${s.origin}@${s.hlc.p}.${s.hlc.l}`)),
  );
  for (const k of relay.admission.admitted) {
    const e = w.envs.get(`${relay.instance}:${k}`);
    if (e) heldNow.add(`${e.origin}@${e.hlc.p}.${e.hlc.l}`);
  }
  const current = w.dots.filter(
    (d) =>
      d.instance === relay.instance && heldNow.has(`${d.dot.origin}@${d.dot.hlc.p}.${d.dot.hlc.l}`),
  );
  for (const { path, dot } of current) {
    if (admits(relay.u, relayCtx(relay), path, dot) !== admits(relay.c, relayCtx(relay), path, dot))
      fail(
        w,
        'compaction',
        `relay admission for ${dot.origin}@${dot.hlc.p} on ${path} depends on collection`,
      );
  }
  const ju = pcanon(materializeRegs(relay.u.checkpoint()));
  if (ju !== pcanon(materializeRegs(relay.c.checkpoint())))
    fail(w, 'compaction', `joiner from relay differs between twins`);
  ledgerCheck(w, relay.c, 'live relay');
  const rec = w.recovered;
  if (rec) {
    const store = rec.stores[0];
    if (rec.instance !== relay.instance)
      fail(w, 'recovery', `recovered instance ${rec.instance} vs ${relay.instance}`);
    if (pcanon(materializeRegs(store.checkpoint())) !== ju)
      fail(w, 'recovery', `joiner from recovered relay differs`);
    for (const path of OBSERVED_PATHS)
      if (store.maxEpoch(path) !== relay.u.maxEpoch(path))
        fail(w, 'recovery', `recovered maxEpoch(${path})`);
    for (const { path, dot } of current) {
      if (admits(relay.u, relayCtx(relay), path, dot) !== admits(store, relayCtx(rec), path, dot))
        fail(w, 'recovery', `recovered admission for ${dot.origin}@${dot.hlc.p} on ${path}`);
    }
    if (extentCanon(rec.extent) !== extentCanon(relay.extent))
      fail(w, 'recovery', `recovered seed extent`);
    if (JSON.stringify(rec.admission.first) !== JSON.stringify(relay.admission.first))
      fail(w, 'recovery', `recovered exemption floors`);
    if (JSON.stringify(rec.admission.settled) !== JSON.stringify(relay.admission.settled))
      fail(w, 'recovery', `recovered settled vector`);
    if ([...rec.admission.admitted].sort().join() !== [...relay.admission.admitted].sort().join())
      fail(w, 'recovery', `recovered ranges`);
    if (receiptsCanon(rec.receipts) !== receiptsCanon(relay.receipts))
      fail(w, 'recovery', `recovered receipts`);
    ledgerCheck(w, store, 'recovered relay');
  }
  for (const [id, o] of w.outcomes) {
    if (o.admitted + o.conflicts + o.discarded > 1 && o.admitted < 2)
      fail(w, 'T3', `intent ${id} classified twice ${JSON.stringify(o)}`);
  }
}

/** R16-2 liveness: every owed rehydration has completed (called after a drain under continuous traffic). */
function owedCheck(w: World): void {
  for (const [id, owed] of w.owedTruth)
    for (const [g, q] of owed)
      fail(w, 'D6-live', `${id} still owes the rehydration of refused ${g} (seq ${q})`);
}

/** T3 at the end of a run: every intent is admitted once, a conflict, discarded — or still pending. */
function finalClassification(w: World): void {
  const pending = new Set<string>();
  for (const r of w.replicas.values())
    for (const t of [...r.tail, ...(r.rebase?.remaining ?? [])]) pending.add(t.intent.id);
  for (const r of w.replicas.values()) {
    for (let i = 1; i <= r.intents; i++) {
      const id = `${r.id}:${i}`;
      const o = outcomeOf(w, id);
      const classes = o.admitted + o.conflicts + o.discarded;
      if (classes === 0 && !pending.has(id))
        fail(
          w,
          'T3',
          `intent ${id} vanished: never admitted, conflicted or discarded, and not pending`,
        );
      if (classes > 1 && o.admitted < 2) fail(w, 'T3', `intent ${id} ended in ${classes} classes`);
    }
  }
}

// ─── relay persistence: checkpoint, observer recovery, and AUTHORITATIVE crash recovery ─

function relayCheckpoint(w: World): void {
  const admission = cloneAdmission(w.relay.admission);
  if (w.variant.checkpointNoFloors) admission.first = {};
  w.checkpoint = {
    at: w.journal.length,
    registers: w.relay.c.checkpoint(),
    admission,
    receipts: w.variant.checkpointNoReceipts ? new Map() : cloneReceipts(w.relay.receipts),
    instance: w.relay.instance,
    extent: w.variant.checkpointNoExtent ? new Map() : w.relay.extent,
    preCutMax: w.relay.preCutMax,
    everMax: { ...w.relay.everMax },
    refused: new Map(w.relay.refused),
  };
}
function relayRecover(w: World, rnd: () => number): RelayCore | undefined {
  const cp = w.checkpoint;
  if (!cp) return undefined;
  const store = createRegisterStore();
  store.load(cp.registers);
  const core: RelayCore = {
    instance: cp.instance,
    stores: [store],
    admission: cloneAdmission(cp.admission),
    receipts: cloneReceipts(cp.receipts),
    extent: cp.extent,
    preCutMax: cp.preCutMax,
    everMax: { ...cp.everMax },
    refused: new Map(cp.refused),
    carryBaselines: w.variant.carryBaselines,
    bridgeHoles: w.variant.bridgeHoles,
    omitIngest: w.variant.omitIngest,
    corruptIngest: w.variant.corruptIngest,
    dropWater: w.variant.dropWater,
    excessWater: w.variant.excessWatermark,
  };
  const slice = w.journal.slice(cp.at);
  if (slice.some((e) => e.kind === 'cut')) count(w, 'recoverAcrossCut');
  for (const e of slice) {
    applyEntry(core, e);
    if (rnd() < 0.3) store.settle(core.admission.settled);
  }
  count(w, 'recoveries');
  ledgerCheck(w, store, 'after recovery');
  return core;
}
/** A relay CRASH: the recovered core becomes THE relay (its C store, admission, receipts, extent, floors). */
function relayCrash(w: World, rnd: () => number): void {
  const core = relayRecover(w, rnd);
  if (!core) return;
  const r = w.relay;
  r.c = core.stores[0];
  r.stores = [r.u, r.c];
  r.admission = core.admission;
  r.receipts = core.receipts;
  r.extent = core.extent;
  r.preCutMax = core.preCutMax;
  r.everMax = core.everMax;
  r.refused = core.refused;
  w.recovered = undefined;
  count(w, 'relayCrashes');
  ledgerCheck(w, r.c, 'after relay crash');
}
function reloadRelayStores(w: World): void {
  const fresh = (from: Store): Store => {
    const st = createRegisterStore();
    st.load(from.checkpoint());
    return st;
  };
  w.relay.u = fresh(w.relay.u);
  w.relay.c = fresh(w.relay.c);
  w.relay.stores = [w.relay.u, w.relay.c];
}

/** D11 hard budget, evaluated after every admitted commit and every step; never waits for quiescence. */
function enforceBudget(w: World, budget: number): void {
  const counted = (): number => {
    if (w.variant.countAllLone) return loneTombstones(w.relay.c).length;
    const maintained = droppableTombstones(w.relay.c);
    const scan = droppableTombstonesScan(w.relay.c);
    if (maintained !== scan)
      fail(w, 'count', `maintained droppable-tombstone count ${maintained} vs full scan ${scan}`);
    return maintained;
  };
  if (!w.variant.noBudget && counted() > budget) {
    if ([...w.replicas.values()].some((x) => x.tail.length || x.rebase))
      count(w, 'budgetCutUnderLoad');
    if ([...w.replicas.values()].some((x) => x.pressed)) count(w, 'budgetCutDuringCensus');
    cut(w, 'reaper', 'replay');
    count(w, 'budgetCuts');
  }
  if (counted() > budget)
    fail(w, 'liveness', `counted tombstones ${counted()} > budget ${budget} after the cut`);
}

// ─── the random driver ───────────────────────────────────────────────────────

const CONTAINERS: readonly string[] = [pathKey(['b']), pathKey(['d']), pathKey(['d', 'e'])];

/**
 * Classes that record an ACCEPTED residual — they never stop a run and are reported, not asserted:
 * `D6-residual` (F-11, ruled 2026-11-07), `T1-residual` (§14 T1 SCOPE: synthesizing folds) and
 * `T1-index` (r9: a positional-fold departure in a source holding INDEX-mode registers below an
 * array — outside the domain, where arrays are UNIT values; the contrast to `T1-positional`).
 */
const FINDINGS = new Set(['D6-residual', 'T1-residual', 'T1-index']);
/**
 * Classes the ADVERSARIAL peer channel (n42) is expected to break: honest stamping (R17-1) holds them
 * at 0 in the base. `peerRefusedRetained` (R17-2) is a COUNTER, never a class: an OUT-OF-PRODUCTION
 * residual (no peer copies of document ops in relay rooms), reported in base and n42, never asserted.
 */
const PEER_CHANNEL: readonly string[] = ['D6-fresh', 'stamp-discipline'];

function run(
  seed: number,
  steps: number,
  variant: Variant = {},
  stopOn: (cls: string) => boolean = (c) => !FINDINGS.has(c),
): World {
  const rnd = mulberry32(seed);
  const ids = ['A', 'B', 'C'];
  const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rnd() * xs.length)];
  // the base runs SELECTING folds only (the theorem's domain; studio rooms configure none); the
  // residual sweep runs synthesizing ones. Each replica picks its own configuration.
  const w = createWorld(ids, variant, (writer) => writer !== 'C'); // C never had bump authority
  for (const rep of w.replicas.values()) {
    rep.cfg = variant.cfg ?? pick(variant.residual ? RESIDUAL_CFGS : SELECTING_CFGS);
    rep.u = foldOf(rep.cfg, rep.id);
    rep.c = foldOf(rep.cfg, rep.id);
    rep.rk = foldOf(rep.cfg, rep.id);
    rep.u.load(w.gens[0].seed);
    rep.c.load(w.gens[0].seed);
    rep.rk.load(w.gens[0].seed);
    rep.cov = storeOf(w.gens[0].seed);
    rep.applied = new Map();
    persist(w, rep);
  }
  const GHOST = 'G';
  w.authored.set(GHOST, []);
  const ghostEntry = 5 + Math.floor(rnd() * 4);
  let ghostVersion = ghostEntry;
  let ghostStale = 0;
  const cursor = new Map<string, number>();
  const budget = rnd() < 0.8 ? Math.floor(rnd() * 2) : Infinity;
  w.budget = budget;
  const snapshots: RegisterCheckpoint[][] = [];
  const R0 = (id: string): Replica => w.replicas.get(id) as Replica;
  const reps = (): Replica[] => [...w.replicas.values()];
  const shuffled = <T>(xs: readonly T[]): T[] => {
    const out = [...xs];
    for (let i = out.length - 1; i > 0; i--) {
      const j = Math.floor(rnd() * (i + 1));
      [out[i], out[j]] = [out[j], out[i]];
    }
    return out;
  };
  /** A connected replica catches up: current welcome, finished replay, outbox flushed in order. */
  const catchUp = (rep: Replica): boolean => {
    learn(w, rep);
    while (rep.rebase && rep.installed) replayStep(w, rep);
    for (const t of [...rep.tail]) toRelay(w, t.env);
    return rep.instance === w.relay.instance;
  };
  const commit = (
    rep: Replica,
    raw: StoreOp,
    opt: { bump?: boolean; lower?: (op: SyncOp) => SyncOp } = {},
  ): TailEntry | null => {
    if (!catchUp(rep)) return null;
    const t = author(w, rep.id, raw, opt);
    return t && toRelay(w, t.env) === 'admitted' ? t : null;
  };
  const valueFor = (path: readonly Key[]): unknown => {
    const n = Math.floor(rnd() * 5);
    const k = pathKey(path);
    if (!CONTAINERS.includes(k) || rnd() < 0.6) return n;
    if (k === pathKey(['b'])) return rnd() < 0.5 ? {} : { c: n };
    if (k === pathKey(['d'])) return rnd() < 0.4 ? {} : { e: rnd() < 0.5 ? {} : { f: n } };
    return rnd() < 0.5 ? {} : { f: n };
  };
  const rawOp = (path: readonly Key[]): StoreOp => {
    const k = rnd();
    return k < 0.55
      ? { kind: 'set', path, next: valueFor(path) }
      : k < 0.85
        ? { kind: 'delete', path, prev: undefined }
        : { kind: 'clear', path };
  };

  // ─── r9: array-valued writes and the N8 container step, on a SECOND rng stream ───
  // The main stream draws exactly as before; `ra` decides only the r9 steps. INDEX-mode runs (30%)
  // also emit per-slot ops below the array paths (`diffOps` with `arrays: 'index'`: same length ⇒
  // per-index descent) — the out-of-domain contrast; every other run is UNIT mode (studio's default).
  const ra = mulberry32(seed + 0x51ed27);
  const pickA = <T>(xs: readonly T[]): T => xs[Math.floor(ra() * xs.length)];
  const indexRun = ra() < 0.3;
  const elemFor = (path: readonly Key[]): unknown => {
    const n = Math.floor(ra() * 100);
    if (path[0] === 'l') return n;
    if (path[0] === 'm') return ra() < 0.5 ? { x: n } : { x: n, y: Math.floor(ra() * 100) };
    return [n, Math.floor(ra() * 100)];
  };
  /** A slot edited in place: a scalar, a record key set/added/removed, an inner array slot. */
  const editSlot = (path: readonly Key[], slot: unknown): unknown => {
    if (path[0] === 'm' && isObj(slot)) {
      const k = ra();
      const copy = { ...slot };
      if (k < 0.3 && Object.keys(copy).length > 1) delete copy[pickA(Object.keys(copy))];
      else copy[k < 0.65 ? 'x' : 'y'] = Math.floor(ra() * 100);
      return copy;
    }
    if (path[0] === 'n' && Array.isArray(slot) && slot.length) {
      const copy = slot.slice();
      copy[Math.floor(ra() * copy.length)] = Math.floor(ra() * 100);
      return copy;
    }
    return elemFor(path);
  };
  /** JSON values only (the PATH/VALUE precondition): a materialized hole or undefined is not carried. */
  const wireable = (v: unknown): boolean =>
    v === undefined || pcanon(v) === pcanon(JSON.parse(JSON.stringify(v)));
  const arrayStep = (): void => {
    const id = pickA(ids);
    const rep = R0(id);
    const path = pickA(ARRAY_PATHS) as Key[];
    const shown = lookup(rep.u.materialize(), path);
    const cur = shown.value;
    if (shown.found && !wireable(cur)) {
      count(w, 'arraySkippedUnwireable');
      return;
    }
    // `prev` as op-sync's diff carries it: the replica's current value at the path, absent ⇒ none
    const prev = shown.found ? { prev: cur } : {};
    const k = ra();
    let raw: StoreOp;
    if (indexRun && Array.isArray(cur) && cur.length && k < 0.4) {
      const i = Math.floor(ra() * cur.length);
      const slot = cur[i];
      if (path[0] === 'm' && isObj(slot) && ra() < 0.6) {
        const key = ra() < 0.6 ? 'x' : 'y';
        raw =
          Object.hasOwn(slot, key) && ra() < 0.45
            ? { kind: 'delete', path: [...path, i, key], prev: undefined }
            : {
                kind: 'set',
                path: [...path, i, key],
                next: Math.floor(ra() * 100),
                ...(Object.hasOwn(slot, key) ? { prev: slot[key] } : {}),
              };
      } else if (path[0] === 'n' && Array.isArray(slot) && slot.length) {
        const j = Math.floor(ra() * slot.length);
        raw = { kind: 'set', path: [...path, i, j], next: Math.floor(ra() * 100), prev: slot[j] };
      } else raw = { kind: 'set', path: [...path, i], next: editSlot(path, slot), prev: slot };
      count(w, 'arrayIndexOps');
    } else if (Array.isArray(cur) && k < 0.88) {
      const next = cur.slice();
      const kk = ra();
      if (kk < 0.75 && next.length) {
        // same length: one or two slots edited (concurrent writers hit different or the same slots)
        for (let e = ra() < 0.4 ? 2 : 1; e > 0; e--) {
          const i = Math.floor(ra() * next.length);
          next[i] = editSlot(path, next[i]);
        }
        count(w, 'arraySlotEdits');
      } else if (kk < 0.9 || next.length < 2) {
        if (ra() < 0.5 || !next.length) next.push(elemFor(path));
        else next.pop();
        count(w, 'arrayResizes');
      } else {
        const i = Math.floor(ra() * next.length);
        const j = (i + 1 + Math.floor(ra() * (next.length - 1))) % next.length;
        [next[i], next[j]] = [next[j], next[i]];
        count(w, 'arrayMoves');
      }
      raw = { kind: 'set', path, next, prev: cur };
    } else if (!Array.isArray(cur) && k < 0.88) {
      const len = 2 + Math.floor(ra() * 2);
      raw = { kind: 'set', path, next: Array.from({ length: len }, () => elemFor(path)), ...prev };
    } else if (k < 0.96) raw = { kind: 'delete', path, prev: undefined };
    else raw = { kind: 'clear', path };
    if (author(w, id, raw)) count(w, 'arrayWrites');
  };
  /**
   * The positional shape on purpose (most random concurrency is two CREATIONS, which carry no `prev`
   * and keep the winner whole): x writes a base array, y and z receive it from the relay and edit a
   * slot each from that same base without seeing each other — a slot merge the fold must synthesize.
   */
  const positionalStep = (): void => {
    const x = pickA(ids);
    const y = pickA(ids.filter((i) => i !== x));
    const z = ids.find((i) => i !== x && i !== y) as string;
    const path = pickA(ARRAY_PATHS) as Key[];
    const at = (id: string) => lookup(R0(id).u.materialize(), path);
    if (!catchUp(R0(x))) return;
    const was = at(x);
    if (was.found && !wireable(was.value)) return;
    const base = Array.from({ length: 2 + Math.floor(ra() * 3) }, () => elemFor(path));
    const b = commit(R0(x), {
      kind: 'set',
      path,
      next: base,
      ...(was.found ? { prev: was.value } : {}),
    });
    if (!b) return;
    for (const id of [y, z]) if (!catchUp(R0(id)) || toReplica(w, b.env, R0(id)) !== 'ok') return;
    for (const id of [y, z]) {
      const cur = at(id).value;
      if (!Array.isArray(cur) || !wireable(cur)) return;
      const next = cur.slice();
      const i = Math.floor(ra() * next.length);
      next[i] = editSlot(path, next[i]);
      const t = author(w, id, { kind: 'set', path, next, prev: cur });
      if (!t || toRelay(w, t.env) !== 'admitted') return;
    }
    count(w, 'scenarioPositional');
  };
  /**
   * N8 (charter §22): a container `set` over a path that holds a lone descendant tombstone. The
   * transcriber's schedule: root `{d:{}}` (a migration mints it from `d = {}`), `delete d.e`
   * (droppable: nothing contains it), then a writer that never saw the delete sets `d = {e:1}` — no
   * expansion clear reaches d.e, its delete stays live and is now contained: the counter must
   * reclassify a DESCENDANT of the written path (class `count` compares it with the full scan).
   */
  const n8Step = (): void => {
    const x = pickA(ids);
    const y = pickA(ids.filter((i) => i !== x));
    if (!commit(R0(x), { kind: 'set', path: ['d'], next: {} })) return;
    cut(w, 'migration', 'discard');
    const Y = R0(y);
    while (Y.inbox.length) deliverWelcome(w, Y, 0); // y installs the minted root BEFORE the delete
    if (Y.instance !== w.relay.instance) return;
    if (!commit(R0(x), { kind: 'delete', path: ['d', 'e'], prev: undefined })) return;
    const before = droppableTombstonesScan(w.relay.c);
    const t = author(w, y, { kind: 'set', path: ['d'], next: { e: 1 } }); // y never saw the delete
    if (!t || toRelay(w, t.env) !== 'admitted') return;
    const stillLive = w.relay.c.siblings(['d', 'e']).some((s) => s.kind === 'delete');
    if (stillLive && droppableTombstonesScan(w.relay.c) < before) count(w, 'reachN8');
    count(w, 'scenarioN8');
  };

  for (let step = 0; step < steps; step++) {
    if (!variant.noArrays) {
      const arrays = ra() < 0.15;
      if (arrays) arrayStep();
      const shaped = ra() < 0.03;
      if (shaped) positionalStep();
      const n8 = ra() < 0.005 && !variant.noN8Step;
      if (n8) n8Step();
      // an r9 step is a driver step of its own: the client record persists at its boundary (an
      // authored envelope is on the wire only with its outbox entry durable — without this, a crash
      // in the same driver step re-used the lost envelope's version: a harness artifact, root-caused)
      if (arrays || shaped || n8) for (const rep of reps()) persist(w, rep);
    }
    const r = rnd();
    if (r < 0.2) {
      const id = pick(ids);
      const p1 = pick(PATHS);
      const raws: StoreOp[] = [rawOp(p1)];
      if (rnd() < 0.25) {
        // D-e: a multi-op envelope (unrelated paths: a nested pair would stamp a duplicate path,
        // which the wire rejects as `dup-path` — a real diff never emits both) under ONE bump flag
        const p2 = pick(
          PATHS.filter((p) => pathKey(p) !== pathKey(p1) && !isPrefix(p, p1) && !isPrefix(p1, p)),
        );
        raws.push(rawOp(p2));
      }
      const lower =
        rnd() < 0.25
          ? (op: SyncOp): SyncOp => ({ ...op, epoch: Math.floor(rnd() * ((op.epoch ?? 0) + 1)) })
          : undefined;
      author(w, id, raws, { bump: id !== 'C' && rnd() < 0.15, lower });
    } else if (r < 0.22) {
      const path = pick(PATHS);
      const stale = ghostVersion > ghostEntry && ghostStale < ghostEntry - 1 && rnd() < 0.3;
      w.clock += 1;
      const v = stale ? ++ghostStale : ++ghostVersion;
      const hlc = stale ? { p: 1 + ghostStale, l: 0 } : { p: w.clock, l: 0 };
      const env: OpEnvelope = {
        proto: MESH_PROTO_VERSION,
        instance: w.relay.instance,
        policyVersion: 0,
        origin: GHOST,
        writer: GHOST,
        version: v,
        hlc,
        ops: [{ kind: 'set', path, next: `ghost-${v}`, cites: [], epoch: 0 }],
      };
      w.envs.set(gkey(env), env);
      (w.authored.get(GHOST) as OpEnvelope[]).push(env);
      w.dots.push({ instance: env.instance, path, dot: { origin: GHOST, hlc } });
    } else if (r < 0.44) {
      const from = pick([...w.authored.keys()]);
      const owner = w.owner.get(from);
      const targets: (Replica | 'relay')[] = reps().filter((x) => x.id !== owner);
      targets.push('relay');
      const to = pick(targets);
      const key = `${from}>${to === 'relay' ? 'relay' : to.id}`;
      const i = cursor.get(key) ?? 0;
      const queue = w.authored.get(from) as OpEnvelope[];
      if (i < queue.length) {
        const res = to === 'relay' ? toRelay(w, queue[i]) : toReplica(w, queue[i], to);
        if (res !== 'future') cursor.set(key, i + 1);
      }
      if (rnd() < 0.2 && i > 0) {
        const dup = queue[Math.floor(rnd() * i)];
        if (to === 'relay') toRelay(w, dup, false);
        else toReplica(w, dup, to);
      }
    } else if (r < 0.47) {
      // a reconnect: one replica resends its whole outbox to the relay, in order
      const rep = pick(reps());
      for (const t of [...rep.tail]) toRelay(w, t.env);
    } else if (r < 0.57) {
      const busy = reps().filter((x) => x.rebase);
      if (busy.length) replayStep(w, pick(busy));
    } else if (r < 0.65) {
      // D-d: deliver one queued welcome, in ANY order, sometimes duplicated
      const waiting = reps().filter((x) => x.inbox.length);
      if (waiting.length) {
        const rep = pick(waiting);
        const i = Math.floor(rnd() * rep.inbox.length);
        if (rnd() < 0.2) rep.inbox.push(rep.inbox[i]);
        deliverWelcome(w, rep, i);
      }
    } else if (r < 0.67) {
      postWelcome(w, pick(reps())); // a rejoin request
    } else if (r < 0.71) {
      const waiting = reps().filter((x) => x.unresolved.length);
      if (waiting.length) resolve(w, pick(waiting), rnd() < 0.7);
    } else if (r < 0.76) {
      const to = pick<Replica | 'relay'>([...reps(), 'relay']);
      if (to === 'relay') {
        const eager: Record<string, Hlc> = {};
        for (const o of [...w.authored.keys(), ...w.gens.map((g) => g.instance)])
          eager[o] = w.maxHlc;
        w.relay.c.settle(variant.eagerSettle ? eager : w.relay.admission.settled);
        if (variant.eagerSettle)
          for (const x of reps()) {
            x.c.settle(eager); // eager on every C twin
            x.cov.settle(eager);
          }
        if (w.recovered && rnd() < 0.5) w.recovered.stores[0].settle(w.recovered.admission.settled);
      } else {
        to.c.settle(to.admission.settled);
        to.cov.settle(to.admission.settled);
      }
    } else if (r < 0.79) {
      if (!w.checkpoint || rnd() < 0.5) relayCheckpoint(w);
      else w.recovered = relayRecover(w, rnd);
    } else if (r < 0.8) {
      relayCrash(w, rnd);
    } else if (r < 0.84) {
      // a replica crash, at a crash point of a replay or a welcome installation, between a relay
      // refusal and the persisted Conflict (D-b″), or between steps
      const rep = pick(reps());
      const k = rnd();
      const open = rep.tail.filter(
        (t) => t.instance === w.relay.instance && !w.relay.admission.admitted.has(keyOfEnv(t.env)),
      );
      if (open.length && k < 0.25) {
        const ans = toRelay(w, open[0].env);
        if (ans === 'unknown-citation' || ans === 'epoch-bump') {
          count(w, 'crashAfterRefusal');
          reload(w, rep);
        }
      } else if (rep.rebase && k < 0.4) replayStep(w, rep, 1 + Math.floor(rnd() * 4));
      else if (rep.inbox.length && k < 0.7)
        deliverWelcome(w, rep, Math.floor(rnd() * rep.inbox.length), 1 + Math.floor(rnd() * 3));
      else reload(w, rep);
      if (rnd() < 0.3) reloadRelayStores(w);
    } else if (r < 0.85) {
      reload(w, pick(reps()), true); // a reboot: a NEW origin, the old origin's outbox resent
    } else if (r < 0.875) {
      const rep = pick(reps());
      rep.connected = !rep.connected; // a member leaves or (re)joins, not ready (P-5)
      rep.pressed = false;
      declare(w, rep);
      count(w, rep.connected ? 'joins' : 'leaves');
    } else if (r < 0.9) {
      // a connected member presses Compact: flush, then pressed (a later write un-readies it)
      const rep = pick(
        reps()
          .filter((x) => x.connected)
          .concat(reps().slice(0, 0)),
      );
      if (rep?.connected) {
        for (const t of [...rep.tail]) toRelay(w, t.env);
        rep.pressed = true;
        declare(w, rep);
        count(w, 'presses');
      }
    } else if (r < 0.925) {
      const k = rnd();
      if (k < 0.5) cut(w, 'reaper', 'replay');
      else if (k < 0.75 || !snapshots.length) cut(w, 'migration', 'discard');
      else cut(w, 'rollback', 'discard', pick(snapshots));
    } else if (r < 0.935 || variant.noScenarios) {
      snapshots.push(w.relay.c.checkpoint());
    } else if (r < 0.95) {
      // F-2a shape: O writes p, X sees it and holds a write citing it; a cut seeds p with O's dot;
      // Y supersedes it, O settles past it, the relay collects; X learns later
      const [o, x, y] = shuffled(ids);
      const p = pick(PATHS) as Key[];
      const a = commit(R0(o), { kind: 'set', path: p, next: 'o' });
      if (
        a &&
        catchUp(R0(x)) &&
        toReplica(w, a.env, R0(x)) === 'ok' &&
        author(w, x, { kind: 'set', path: p, next: 'x' })
      ) {
        cut(w, 'reaper', 'replay');
        commit(R0(y), { kind: 'set', path: p, next: 'y' });
        commit(R0(o), { kind: 'set', path: pick(PATHS) as Key[], next: 'q' });
        w.relay.c.settle(w.relay.admission.settled);
        count(w, 'scenarioF2a');
      }
    } else if (r < 0.962) {
      // F-4 shape: an owner bumps p, C (no authority) sees it and holds a carry; the owner rewrites p
      // at a non-carrying epoch 0; a cut keeps only the newer sibling and the baseline
      const o = pick(['A', 'B']);
      const p = pick(PATHS) as Key[];
      const a = commit(R0(o), { kind: 'set', path: p, next: 'bump' }, { bump: true });
      if (
        a &&
        catchUp(R0('C')) &&
        toReplica(w, a.env, R0('C')) === 'ok' &&
        author(w, 'C', { kind: 'set', path: p, next: 'carry' })
      ) {
        commit(
          R0(o),
          { kind: 'set', path: p, next: 'rewrite' },
          { lower: (op) => ({ ...op, epoch: 0 }) },
        );
        cut(w, 'reaper', 'replay');
        count(w, 'scenarioF4');
      }
    } else if (r < 0.975) {
      // F-7 shape: O1 seen by X; Y supersedes it before the cut; X holds a write citing O1; after the
      // cut O writes p again and Y supersedes that; X learns later
      const [o, x, y] = shuffled(ids);
      const p = pick(PATHS) as Key[];
      const a = commit(R0(o), { kind: 'set', path: p, next: 'o1' });
      if (
        a &&
        catchUp(R0(x)) &&
        toReplica(w, a.env, R0(x)) === 'ok' &&
        catchUp(R0(y)) &&
        toReplica(w, a.env, R0(y)) !== 'future'
      ) {
        commit(R0(y), { kind: 'set', path: p, next: 'y1' });
        if (author(w, x, { kind: 'set', path: p, next: 'x' })) {
          cut(w, 'reaper', 'replay');
          commit(R0(o), { kind: 'set', path: p, next: 'o2' });
          commit(R0(y), { kind: 'set', path: p, next: 'y2' });
          if (rnd() < 0.5) w.relay.c.settle(w.relay.admission.settled);
          count(w, 'scenarioF7');
        }
      }
    } else if (r < 0.99) {
      // D-b shape: Y and X hold pending writes (X's cites Y's); a cut; Y replays and X receives that
      // replay by PEER COPY before the relay does; X's replay is covered locally — and refused
      const [y, x] = shuffled(ids);
      const p = pick(PATHS) as Key[];
      if (catchUp(R0(y)) && catchUp(R0(x))) {
        const ty = author(w, y, { kind: 'set', path: p, next: 'y' });
        if (
          ty &&
          toReplica(w, ty.env, R0(x)) === 'ok' &&
          author(w, x, { kind: 'set', path: p, next: 'x' })
        ) {
          cut(w, 'reaper', 'replay');
          learn(w, R0(y));
          learn(w, R0(x));
          while (R0(y).rebase) replayStep(w, R0(y));
          const yr = R0(y).tail.find((t) => t.intent.id === ty.intent.id);
          if (yr && toReplica(w, yr.env, R0(x)) === 'ok') {
            while (R0(x).rebase) replayStep(w, R0(x));
            for (const t of [...R0(x).tail]) toRelay(w, t.env);
            count(w, 'scenarioDb');
          }
        }
      }
    } else {
      // D-b″ shape: an owner bumps p (not yet at the relay), C sees it by peer copy and writes p with
      // the carried epoch; C's record persists; the relay refuses (epoch-bump) and C crashes before
      // its Conflict persists — it must re-learn the refusal on its next same-generation resend
      const o = pick(['A', 'B']);
      const p = pick(PATHS) as Key[];
      if (catchUp(R0(o)) && catchUp(R0('C'))) {
        const a = author(w, o, { kind: 'set', path: p, next: 'bump' }, { bump: true });
        const c =
          a &&
          toReplica(w, a.env, R0('C')) === 'ok' &&
          author(w, 'C', { kind: 'set', path: p, next: 'carry' });
        if (c) {
          persist(w, R0('C'));
          if (toRelay(w, c.env) === 'epoch-bump') {
            count(w, 'crashAfterRefusal');
            reload(w, R0('C'));
          }
          count(w, 'scenarioDb2');
        }
      }
    }
    for (const rep of reps()) persist(w, rep); // the client record: atomic at the step boundary
    enforceBudget(w, budget);
    consensusCheck(w);
    observe(w);
    if ([...w.violations.keys()].some(stopOn)) {
      for (const [cls, msg] of w.violations)
        w.violations.set(cls, `seed ${seed} step ${step}: ${msg}`);
      return w;
    }
  }
  // R16-2 liveness DRAIN under continuous traffic: each round a fresh write by a replica that owes
  // nothing reaches everyone; in round 0 it OVERTAKES the queued welcomes (astra's race: a rehydrate
  // older than traffic is rejected), afterwards one relay socket orders them (FIFO: queued welcomes first)
  const traffic = (): void => {
    const free = reps().filter((x) => !(w.owedTruth.get(x.id) as Map<string, number>).size);
    const t = free.length
      ? commit(pick(free), { kind: 'set', path: pick(PATHS), next: 'drain' })
      : null;
    if (t)
      for (const rep of reps()) if (w.owner.get(t.env.origin) !== rep.id) toReplica(w, t.env, rep);
  };
  for (let round = 0; round < 4; round++) {
    if (round === 0) traffic();
    for (const rep of reps()) while (rep.inbox.length) deliverWelcome(w, rep, 0);
    if (round > 0) traffic();
    for (const rep of reps()) persist(w, rep);
    observe(w);
  }
  for (const rep of reps()) while (rep.inbox.length) deliverWelcome(w, rep, 0);
  owedCheck(w);
  finalClassification(w);
  for (const [cls, msg] of w.violations) w.violations.set(cls, `seed ${seed} end: ${msg}`);
  return w;
}

type Sweep = {
  first: Map<string, string>;
  failing: Map<string, number>;
  n: Record<string, number>;
  ms: number;
};
const sweeps = new Map<string, Sweep>();
const REACH = [
  'reachF2a',
  'reachF4',
  'reachF7',
  'refusalConflicts',
  'budgetCutDuringCensus',
  'reboots',
  'welcomeStale',
  'cut:consensus',
  'keptMultiLive',
  'droppedClearMasked',
  'crashAfterRefusal',
  'refusalRelearned',
];
function sweep(
  name: string,
  variant: Variant,
  seeds: number,
  steps: number,
  stopOn?: (cls: string) => boolean,
): Sweep {
  const hit = sweeps.get(name);
  if (hit) return hit;
  const t0 = Date.now();
  const s: Sweep = { first: new Map(), failing: new Map(), n: {}, ms: 0 };
  for (let seed = 0; seed < seeds; seed++) {
    const w = run(seed, steps, variant, stopOn);
    for (const [cls, msg] of w.violations) {
      if (!s.first.has(cls)) s.first.set(cls, msg);
      s.failing.set(cls, (s.failing.get(cls) ?? 0) + 1);
    }
    for (const [k, v] of Object.entries(w.n)) s.n[k] = (s.n[k] ?? 0) + v;
    for (const k of REACH) if (w.n[k]) s.n[`seeds:${k}`] = (s.n[`seeds:${k}`] ?? 0) + 1;
  }
  s.ms = Date.now() - t0;
  sweeps.set(name, s);
  return s;
}

const SEEDS = 600;
const STEPS = 100;

const clean = (s: Sweep, ...classes: string[]): void => {
  for (const c of classes) expect(s.first.get(c), `${c} violated`).toBeUndefined();
};
/** A neuter must be OBSERVABLE: the named property fails on at least one seed. */
const observed = (s: Sweep, cls: string): string => {
  expect(s.failing.get(cls) ?? 0, `${cls} never failed under the neuter`).toBeGreaterThan(0);
  return s.first.get(cls) as string;
};
const neuterLog: Record<string, string> = {};
const N = (s: Sweep, k: string): number => s.n[k] ?? 0;
const ALL = [
  'T1',
  'T1-diff',
  'T1-preserve',
  'T1-positional',
  'positional-closure',
  'T2a',
  'T2a-gc',
  'T2b',
  'T2c',
  'converge',
  'precut',
  'D6-engine',
  'D6-refusal',
  'D6-drop',
  'D6-visible',
  'D6-live',
  'D6-fresh',
  'stamp-discipline',
  'tripwire',
  'T3',
  'T3-double',
  'T3-order',
  'T3-apply',
  'ledger',
  'ledger-discharge',
  'T3-resurrect',
  'T3-recrash',
  'crash',
  'recovery',
  'liveness',
  'consensus',
  'census-flag',
  'compaction',
  'welcome',
  'welcome-order',
  'peer-retain',
  'wire',
  'count',
];

describe('generation cut: properties (r9: positional arrays in the T1 domain, the NO-PERSIST replica as default; r8 §19 ledger liveness; §17 honest stamping on top of §16, §14, D-a′/D-b′ and D-a..D-f)', () => {
  const s = (): Sweep => sweep('base', {}, SEEDS, STEPS);
  it('T1 STRUCTURAL (verifier-owned, D-a′) + differential under every SELECTING fold (default, custom selecting) with presence-preserving equality', () => {
    // scope: the seed vs its source at every reaper/consensus cut; migration/rollback = supplied value,
    // default-fold differential only. Synthesizing folds are the declared residual (next property).
    clean(s(), 'T1', 'T1-diff');
    expect(N(s(), 'cut:reaper') + N(s(), 'cut:consensus')).toBeGreaterThan(1000);
  }, 300_000);
  it('T1-POSITIONAL (r9, charter §19 R19-3 — PROVEN): the REAL positional fold is PATH-CLOSED (L1: every key/index of its output is held by a live sibling value) and never covers a tombstone D-a′ drops (L2); materialization under it is identical before/after every reaper/consensus cut (asserted, unit-mode arrays); INDEX-mode registers below arrays are the reported contrast', () => {
    // scope: array-valued registers written as units (studio's `arrays: 'unit'`) with `prev` as the
    // sync layer carries it, under the explicit `positional` policy AND the no-policy default
    // (`noPolicyFold`, whose departures are `T1-diff`); index-mode sources are `T1-index` (reported)
    clean(s(), 'T1-positional', 'positional-closure', 'T1-diff', 'T1');
    neuterLog['T1-positional (base, 600 seeds)'] =
      `${s().failing.get('T1-positional') ?? 0} seeds; positional-closure ${s().failing.get('positional-closure') ?? 0}; T1-index (contrast) ${s().failing.get('T1-index') ?? 0} seeds; array registers at cuts ${N(s(), 'posArrayRegisters')}, multi-sibling folds ${N(s(), 'posFolds')}, synthesized ${N(s(), 'posSynth')}; cuts unit-mode ${N(s(), 'cutsUnitMode')} (with arrays ${N(s(), 'cutsUnitArrays')}), index-mode ${N(s(), 'cutsIndexMode')}; array writes ${N(s(), 'arrayWrites')} (slot edits ${N(s(), 'arraySlotEdits')}, resizes ${N(s(), 'arrayResizes')}, moves ${N(s(), 'arrayMoves')}, index ops ${N(s(), 'arrayIndexOps')}, skipped ${N(s(), 'arraySkippedUnwireable')})`;
    expect(N(s(), 'posSynth')).toBeGreaterThan(0);
    expect(N(s(), 'cutsUnitArrays')).toBeGreaterThan(0);
  }, 300_000);
  it('T1 RESIDUAL (§14, declared, REPORTED not asserted): synthesizing folds (`preserve`, clear→delete) may un-mask at a cut; replicas running them keep every other property', () => {
    const r = sweep('residual', { residual: true }, 300, STEPS);
    clean(r, ...ALL); // every asserted class, incl. T1 structural and the selecting differential
    neuterLog['T1-residual (base, 600 seeds)'] =
      `${s().failing.get('T1-residual') ?? 0} seeds, ${N(s(), 'v:T1-residual')} cuts: ${s().first.get('T1-residual') ?? '-'}`;
    neuterLog['T1-residual (residual replicas, 300 seeds)'] =
      `${r.failing.get('T1-residual') ?? 0} seeds, ${N(r, 'v:T1-residual')} cuts`;
  }, 300_000);
  it('D-a′ (F-8, F-12 ruled): `preserve` sees no departure (T1-preserve empty, every class empty); both new clauses decide registers at random', () => {
    clean(s(), ...ALL); // T1-preserve empty, and every other class with it
    neuterLog['d-a′ reach'] =
      `keptMultiLive ${N(s(), 'keptMultiLive')} (${N(s(), 'seeds:keptMultiLive')} seeds), droppedClearMasked ${N(s(), 'droppedClearMasked')} (${N(s(), 'seeds:droppedClearMasked')} seeds)`;
    expect(N(s(), 'seeds:keptMultiLive')).toBeGreaterThanOrEqual(5); // natural rate (r4 13, r5 8 seeds); pinned F-8
    expect(N(s(), 'seeds:droppedClearMasked')).toBeGreaterThanOrEqual(20);
  }, 300_000);
  it('T2a: every replay pre-check equals the D-f oracle, both directions (the final outcome may still be a Conflict by authority or relay refusal)', () => {
    clean(s(), 'T2a', 'T2a-gc', 'precut');
    expect(N(s(), 'applied')).toBeGreaterThan(1000);
    expect(N(s(), 'seeds:reachF2a')).toBeGreaterThanOrEqual(20);
    expect(N(s(), 'seeds:reachF7')).toBeGreaterThanOrEqual(20);
  }, 300_000);
  it('T2b D3″: relay maxEpoch exact; client floors exact after every installation', () => {
    clean(s(), 'T2b');
    expect(N(s(), 'seeds:reachF4')).toBeGreaterThanOrEqual(20);
  }, 300_000);
  it('T2c fence + D-d welcomes (§14): no other-generation ingest; stale and older-than-traffic welcomes ignored; welcome content = the cut record; every envelope wire-valid; replicas equal their generation op set', () => {
    clean(s(), 'T2c', 'converge', 'welcome', 'welcome-order', 'peer-retain', 'wire');
    expect(N(s(), 'echoDeduplicated')).toBeGreaterThan(100); // R16-3: deduplicated echoes advance seq
    expect(N(s(), 'peerReingested')).toBeGreaterThan(20); // and peer copies survive snapshot installs
    expect(N(s(), 'welcomeOlderThanTraffic')).toBeGreaterThan(5);
    expect(N(s(), 'seeds:welcomeStale')).toBeGreaterThan(100);
    expect(N(s(), 'installSame')).toBeGreaterThan(100);
  }, 300_000);
  it('D6′ (D-b, D-b″, R17-1): per-cite engine coverage; HONEST STAMPING — no fresh write cites peer-only evidence and none is ever refused (D6-fresh, asserted 0); every relay refusal is justified and lands in Conflict; the tripwire misses nothing (the refusal machinery at random: n42)', () => {
    clean(
      s(),
      'D6-engine',
      'D6-refusal',
      'D6-drop',
      'D6-visible',
      'D6-live',
      'D6-fresh',
      'stamp-discipline',
      'tripwire',
    );
    expect(N(s(), 'freshRefused')).toBe(0); // R17-1: unreachable, 0 in 600 seeds
    // R16-6: ONE gate for every envelope — fresh, re-authored and replayed writes all pass through it
    expect(N(s(), 'gate:fresh')).toBeGreaterThan(5000);
    expect(N(s(), 'gate:reauthor')).toBeGreaterThan(50);
    expect(N(s(), 'gate:replay')).toBeGreaterThan(1000);
    expect(N(s(), 'peerCopies')).toBeGreaterThan(1000); // replicas still FOLD peer copies, never cite them
    // the accepted F-11 residual needs a LOST refusal reply, which the ruled driver never loses
    // (`ignoreDrop` is a variant): empty here, carried by its pin
    clean(s(), 'D6-residual');
    expect(N(s(), 'reauthorAdmitted')).toBeGreaterThan(20);
    neuterLog['D6-fresh (base, 600 seeds)'] =
      `${s().failing.get('D6-fresh') ?? 0} seeds; relay refusals of any kind ${N(s(), 'relayRefusals')}; peerRefusedRetained ${N(s(), 'peerRefusedRetained')} (R17-2 out-of-production residual, reported)`;
  }, 300_000);
  it('T3: verifier-owned ledger of acknowledged EFFECTS (live, before/after every cut, every recovery); never twice at the relay; one application invocation per intent per fold lifetime; never lost across crash points and reboots', () => {
    clean(
      s(),
      'T3',
      'T3-double',
      'T3-order',
      'T3-apply',
      'ledger',
      'ledger-discharge',
      'T3-resurrect',
      'crash',
      'recovery',
    );
    expect(N(s(), 'trimmed')).toBeGreaterThan(300);
    expect(N(s(), 'crashes')).toBeGreaterThan(300);
    expect(N(s(), 'relayCrashes')).toBeGreaterThan(100);
    expect(N(s(), 'seeds:reboots')).toBeGreaterThan(100);
    expect(N(s(), 'reloadMidReplay')).toBeGreaterThan(30);
    expect(N(s(), 'cutDuringReplay')).toBeGreaterThan(30);
  }, 300_000);
  it('liveness: the D11 count (droppable by the D-a′ rule) is within budget after every step', () => {
    clean(s(), 'liveness');
    expect(N(s(), 'budgetCuts')).toBeGreaterThan(20);
  }, 300_000);
  it('D-c consensus as a ready state: zero conflicts created for ready members; joins, leaves, writes and budget cuts between pressing and the cut', () => {
    clean(s(), 'consensus');
    expect(N(s(), 'seeds:cut:consensus')).toBeGreaterThan(50);
    expect(N(s(), 'joins') + N(s(), 'leaves')).toBeGreaterThan(200);
    expect(N(s(), 'seeds:budgetCutDuringCensus')).toBeGreaterThan(0);
  }, 300_000);
  it('compaction within each generation: U/C twins unobservable (materialization, stamps, maxEpoch, admission answers)', () => {
    clean(s(), 'compaction');
  }, 300_000);
  it('r9 REPLICA VARIANTS (charter §24): the base runs the NO-PERSIST replica (no registers, no seq knowledge; a restart re-applies its pending writes, asks for a snapshot without seq and resends its outbox first); the OLD persisting replica, 600 seeds, keeps every asserted class empty too; `T3-recrash` (R26-1, r9.1) asserted in both', () => {
    const p = sweep('persisting replica', { persistRegisters: true }, SEEDS, STEPS);
    clean(s(), ...ALL);
    clean(p, ...ALL);
    expect(N(s(), 'restartsNoRegisters')).toBeGreaterThan(1000);
    expect(N(s(), 'installAfterRestart')).toBeGreaterThan(1000);
    expect(N(s(), 'replayWaitsForInstall')).toBeGreaterThan(0);
    expect(N(p, 'restartsNoRegisters')).toBe(0);
    neuterLog['replica variants'] =
      `no-persist (base): restarts ${N(s(), 'restartsNoRegisters')}, installs after restart ${N(s(), 'installAfterRestart')}, replays waiting for the install ${N(s(), 'replayWaitsForInstall')}, T3-recrash ${s().failing.get('T3-recrash') ?? 0}/${SEEDS}, kept-admitted ${N(s(), 'recrashKept')}; persisting: T3-recrash ${p.failing.get('T3-recrash') ?? 0}/${SEEDS}, T1-residual ${p.failing.get('T1-residual') ?? 0}`;
  }, 300_000);
});

describe('generation cut: teeth (each neuter observable at random)', () => {
  const T = 150;
  const look = (cls: string) => (c: string) => c === cls;
  // r7 (R17-1): honest stamping leaves NO relay refusal at random (0 in 600 base seeds), so every
  // neuter of the refusal path (n23, n25, n30, n37) and n40 (whose early cite names a peer-held dot)
  // rides the ADVERSARIAL channel `citePeer` (n42); alone each is 0/600 — stated in the log
  const teeth: [string, Variant, string, ((c: string) => boolean)?][] = [
    ['n2 no receipts', { noReceipts: true }, 'T3-double', look('T3-double')],
    ['n3′ relay keeps its whole baseline table', { carryBaselines: true }, 'T2b'],
    ['n4 relay-only fence', { noReplicaFence: true }, 'converge', look('converge')],
    ['n5′ seed keeps covered siblings', { keepCovered: true }, 'T1'],
    [
      'n6′ seed drops set-free registers over a live descendant (the seed departs from D-a′; the semantic cost is citability, pinned F-6)',
      { noDescendantRule: true },
      'T1',
    ],
    ['n7 hard budget not enforced', { noBudget: true }, 'liveness'],
    [
      'n8 receipts not checkpointed (then the recovered relay becomes THE relay)',
      { checkpointNoReceipts: true },
      'recovery',
    ],
    ['n9 no pre-check', { noPrecheck: true }, 'D6-engine', () => false],
    ['n10 D9 off', { authorDuringRebase: true }, 'T3-order', look('T3-order')],
    ['n11′ unfloored exemption', { unflooredExempt: true }, 'T2a', look('T2a')],
    ['n12 drop effect-bearing tombstones (r2 literal D4′)', { dropEffectTombstones: true }, 'T1'],
    ['n12′ r3 WINNER-BASED keep rule (killed by D-a)', { materializerKeep: true }, 'T1'],
    [
      'n13a checkpoint without the frozen extent (relay crash makes it authoritative)',
      { checkpointNoExtent: true },
      'recovery',
    ],
    ['n13b checkpoint without the exemption floors', { checkpointNoFloors: true }, 'recovery'],
    ['n14 no frozen extent', { noExtent: true }, 'T2a-gc', look('T2a-gc')],
    ['n16 seed without baselines', { noSeedBaselines: true }, 'T1'],
    [
      'n18 welcome installation persisted in stages (new registers + old outbox)',
      { nonAtomicInstall: true },
      'crash',
      look('crash'),
    ],
    ['n19 replay persisted in stages', { nonAtomicReplay: true }, 'T3', look('T3')],
    [
      'n20 eager collection at the relay, across generations',
      { eagerSettle: true },
      'compaction',
      look('compaction'),
    ],
    ['n21 stale welcomes installed', { acceptStale: true }, 'crash', look('crash')],
    // n22 (a reload forgets client floors) is PINNED: it needs an own bumped sibling superseded by a
    // non-carrying write and collected on the C twin before a reload — 0/600 at random
    // refused holes replay only if the refusal reply is lost (refusals land in Conflict otherwise)
    [
      'n23 the KILLED first-stamp boundary (with lost refusal replies) (n42 channel)',
      { firstStampBoundary: true, ignoreDrop: true, citePeer: true },
      'T2a',
      look('T2a'),
    ],
    [
      'n25 the author ignores a relay refusal (n42 channel)',
      { ignoreDrop: true, citePeer: true },
      'D6-drop',
      look('D6-drop'),
    ],
    [
      'n26 installation re-applies admitted own writes',
      { reapplyAdmitted: true },
      'converge',
      look('converge'),
    ],
    // n27 (the relay forgets refusals, D-b′ off) is PINNED (D-b′ RULED pin): 2/600 before the r5 driver
    // change, 0/600 after (the wire-valid multi-op filter shifted the RNG) — it needs a network
    // duplicate of a refused envelope redelivered AFTER the relay acquired the missing evidence
    [
      'n28 r4 literal D-a: drop multi-live set-free registers',
      { dropMultiLive: true },
      'T1-preserve',
      look('T1-preserve'),
    ],
    [
      'n29 r4 literal D-a: keep clear-only contained registers',
      { clearMasks: true },
      'T1',
      look('T1'),
    ],
    [
      'n30 silent duplicate refusal (r4.1 fast path): a refusal unpersisted at a crash is never re-learned (n42 channel)',
      { silentRefusals: true, citePeer: true },
      'D6-drop',
      look('D6-drop'),
    ],
    // n33 (the client record omits the generation record fields) is PINNED: 0/1200 at random — it needs
    // a reload mid-replay, a replay step BEFORE the requested welcome re-installs the fields, and a cite
    // answered only by the extent (F-2a) or wrongly by a newer same-origin sibling (F-7)
    [
      'n34 a same-generation snapshot older than ingested traffic is installed',
      { acceptOlderSnapshot: true },
      'welcome-order',
      look('welcome-order'),
    ],
    [
      'n35 a replica re-applies a duplicate delivery of the SAME envelope (invisible to an identity set)',
      { noReplicaDedup: true },
      'T3-apply',
      look('T3-apply'),
    ],
    [
      'n31 data loss: an admitted envelope is not ingested (admission, receipt, journal kept)',
      { omitIngest: true },
      'ledger',
      look('ledger'),
    ],
    [
      'n32 data loss: a retained value is corrupted (accounting kept)',
      { corruptIngest: true },
      'ledger',
      look('ledger'),
    ],
    [
      'n36 suppression loss: an admitted envelope is ingested without its cites (watermark lost; sibling, admission, receipt, journal kept)',
      { dropWater: true },
      'ledger',
      look('ledger'),
    ],
    [
      'n37 no durable rehydration-owed flag: a rehydrate welcome rejected as stale is never retried (n42 channel)',
      { noOwed: true, citePeer: true },
      'D6-live',
      look('D6-live'),
    ],
    // n38 (a deduplicated relay echo teaches no seq — r5 order) is PINNED (R16-3 Q4 pin): 2/600 at
    // random before the per-commit budget shifted the RNG, 0/600 after — it needs a peer copy, its
    // deduplicated echo, AND a same-generation snapshot queued in between delivered with no later
    // relay-sequenced ingress to that replica
    [
      'n38b peer-held envelopes are not re-ingested after a snapshot install',
      { noPeerRetain: true },
      'peer-retain',
      look('peer-retain'),
    ],
    [
      'n41 the ready flag is not re-sent when the outbox fills (astra: press, write, the census completes)',
      { silentFill: true },
      'consensus',
      look('consensus'),
    ],
    [
      'n40 r5 admission: fresh writes skip the citation gate (harness-only intent test) (n42 channel)',
      { ungatedFresh: true, citePeer: true },
      'T3-resurrect',
      look('T3-resurrect'),
    ],
    [
      'n43 excess watermark at a commit: water raised over an acked uncited sibling on both twins (sibling + accounting kept) — acked effect hidden',
      { excessWatermark: true },
      'ledger',
      look('ledger'),
    ],
    [
      'n44 a NON-path-closed array merge in the oracle fold (merge = ancestor `prev`): the closure lemmas must fail',
      { ancestorMerge: true },
      'positional-closure',
      look('positional-closure'),
    ],
    [
      'n43b excess watermark just before a reaper/consensus cut, after the last check — the cut must not discharge the hidden effect',
      { excessWatermarkAtCut: true },
      'ledger-discharge',
      look('ledger-discharge'),
    ],
    [
      'n43c register removed just before a reaper/consensus cut, after the last check (both twins; admission, receipts, ledger kept) — the cut must not discharge the lost effect',
      { dropRegisterAtCut: true },
      'ledger-discharge',
      look('ledger-discharge'),
    ],
    [
      'n45 the pre-R26-1 trim: exact membership per (origin, instance, version) — a replay receipted under its own instance escapes it after a crash and a second cut',
      { trimPerInstance: true },
      'T3-recrash',
      look('T3-recrash'),
    ],
  ];
  for (const [label, variant, cls, stopOn] of teeth) {
    it(`${label} ⇒ ${cls}`, () => {
      const seeds =
        label.startsWith('n20') ||
        label.startsWith('n22') ||
        label.startsWith('n23') ||
        label.startsWith('n27') ||
        label.startsWith('n28') ||
        label.startsWith('n34') ||
        label.startsWith('n37') ||
        label.startsWith('n40') ||
        label.startsWith('n41') ||
        label.startsWith('n45')
          ? 600
          : T;
      const x = sweep(label, variant, seeds, STEPS, stopOn);
      neuterLog[label] = `${x.failing.get(cls) ?? 0}/${seeds}: ${observed(x, cls)}`;
    }, 120_000);
  }
  it('n9: the ruled relay tripwire catches EVERY uncovered replayed cite (per cite)', () => {
    const x = sweep('n9 no pre-check', { noPrecheck: true }, T, STEPS, () => false);
    expect(N(x, 'tripwireCaught')).toBeGreaterThan(0);
    expect(N(x, 'tripwireMiss')).toBe(0);
    expect(x.failing.get('tripwire') ?? 0).toBe(0);
    neuterLog['n9 tripwire'] = `caught ${N(x, 'tripwireCaught')} missed ${N(x, 'tripwireMiss')}`;
  }, 120_000);
  it("n39 (R16-5): a DISHONEST ready (C declares ready with a tail) ⇒ consensus cuts fire anyway, C's tail replays under D5′ and its conflicts are COUNTED; convergence, T1, T2, T3 and every other class stay intact", () => {
    const x = sweep('n39 dishonest ready', { dishonestReady: true }, 300, STEPS, (c) =>
      c !== 'consensus' ? !FINDINGS.has(c) : false,
    );
    clean(x, ...ALL.filter((c) => c !== 'consensus'));
    neuterLog['n39 dishonest ready'] =
      `consensus ${x.failing.get('consensus') ?? 0}/300 seeds (leaked intents ${N(x, 'censusLeaked')}: conflicts ${N(x, 'censusLeak:conflicts')}, replayed and admitted otherwise); ${observed(x, 'consensus')}`;
    expect(N(x, 'censusLeaked')).toBeGreaterThan(0);
  }, 120_000);
  it('n42 (R17-1): fresh writes cite PEER-HELD dots (r6 stamping) ⇒ D6-fresh fails at random; every such refusal is REPLIED, lands in Conflict and is rehydrated (also across crashes); convergence, T1, T2, T3 and every other class stay intact — the adversarial channel degrades to conflicts, never divergence', () => {
    const x = sweep('n42 cite peer-held dots', { citePeer: true }, SEEDS, STEPS, (c) =>
      PEER_CHANNEL.includes(c) ? false : !FINDINGS.has(c),
    );
    clean(x, ...ALL.filter((c) => !PEER_CHANNEL.includes(c)));
    clean(x, 'D6-residual');
    observed(x, 'stamp-discipline');
    // the refusal machinery (D-b, D-b″, R16-2) at random lives here since R17-1 (r6 asserted it in base)
    expect(N(x, 'refusalConflicts')).toBe(N(x, 'refusalReplies') - N(x, 'refusalDuplicates'));
    expect(N(x, 'seeds:refusalConflicts')).toBeGreaterThan(50);
    expect(N(x, 'seeds:crashAfterRefusal')).toBeGreaterThan(20); // D-b″ crash point reached
    expect(N(x, 'seeds:refusalRelearned')).toBeGreaterThan(20); // and the refusal re-learned on resend
    expect(N(x, 'rehydrateRetries')).toBeGreaterThan(5); // R16-2: rejected rehydrates were re-requested
    expect(N(x, 'rehydrateCompleted')).toBeGreaterThan(100);
    expect(N(x, 'gateRefused:fresh')).toBeLessThan(N(x, 'gate:fresh') / 10);
    neuterLog['n42 cite peer-held dots'] =
      `D6-fresh ${x.failing.get('D6-fresh') ?? 0}/${SEEDS} seeds (${N(x, 'freshRefused')} fresh refusals, every one a Conflict: replies ${N(x, 'refusalReplies')} = conflicts ${N(x, 'refusalConflicts')} + duplicates ${N(x, 'refusalDuplicates')}); peerRefusedRetained ${N(x, 'peerRefusedRetained')} (R17-2, reported); ${observed(x, 'D6-fresh')}`;
  }, 300_000);
  it('n43b under the r7 ledger (R19-1 off): the hidden effect is discharged as `dropped` and the seed omits it — what every other class sees at random (astra audit #4 Q3: the gap, reported)', () => {
    const on = sweep(
      'n43b excess watermark just before a reaper/consensus cut, after the last check — the cut must not discharge the hidden effect',
      { excessWatermarkAtCut: true },
      T,
      STEPS,
      look('ledger-discharge'),
    );
    expect(N(on, 'excessSeedOmits')).toBe(N(on, 'excessAtCut')); // the seed omits every hidden value
    expect(N(on, 'excessDropped')).toBeGreaterThan(0);
    // per seed under the r7 ledger: a run whose only hidden effects sat in DROPPED registers fails
    // NOTHING (every class of ALL silent) — the corruption accepted as a structural discharge
    let silent = 0;
    let dropped = 0;
    const failing: Record<string, number> = {};
    for (let seed = 0; seed < T; seed++) {
      const w = run(seed, STEPS, { excessWatermarkAtCut: true, r7Ledger: true });
      for (const c of w.violations.keys()) failing[c] = (failing[c] ?? 0) + 1;
      if (!w.n['excessDropped']) continue;
      dropped += 1;
      if (!w.n['excessKept'] && ![...w.violations.keys()].some((c) => !FINDINGS.has(c)))
        silent += 1;
    }
    expect(failing['ledger-discharge'] ?? 0).toBe(0); // R19-1 off: never named as a discharge
    expect(silent).toBeGreaterThan(0);
    neuterLog['n43b r7 ledger'] =
      `R19-1 on: hidden at ${N(on, 'excessAtCut')} cuts (dropped register ${N(on, 'excessDropped')}, kept ${N(on, 'excessKept')}), seed omits ${N(on, 'excessSeedOmits')}; R19-1 off: ${dropped}/${T} seeds hid a dropped register, ${silent} of them fail NO class; classes failing ${JSON.stringify(failing)}`;
  }, 120_000);
  it('n43c (R20-1, astra audit #5): the removed register is named on the cut SOURCE (`ledger`) and its records are refused discharge (`ledger-discharge`); the seed omits every removed value; under the r7 ledger nothing names the discharge', () => {
    const on = sweep(
      'n43c register removed just before a reaper/consensus cut, after the last check (both twins; admission, receipts, ledger kept) — the cut must not discharge the lost effect',
      { dropRegisterAtCut: true },
      T,
      STEPS,
      look('ledger-discharge'),
    );
    expect(N(on, 'dropAtCut')).toBeGreaterThan(0);
    expect(N(on, 'dropSeedOmits')).toBe(N(on, 'dropAtCut')); // the seed omits every removed value
    observed(on, 'ledger');
    observed(on, 'ledger-discharge');
    let silent = 0;
    let hit = 0;
    const failing: Record<string, number> = {};
    for (let seed = 0; seed < T; seed++) {
      const w = run(seed, STEPS, { dropRegisterAtCut: true, r7Ledger: true });
      for (const c of w.violations.keys()) failing[c] = (failing[c] ?? 0) + 1;
      if (!w.n['dropAtCut']) continue;
      hit += 1;
      if (![...w.violations.keys()].some((c) => !FINDINGS.has(c))) silent += 1;
    }
    expect(failing['ledger-discharge'] ?? 0).toBe(0); // R20-1 off: never named as a discharge
    neuterLog['n43c'] =
      `R20-1 on: ledger ${on.failing.get('ledger') ?? 0}/${T}, ledger-discharge ${on.failing.get('ledger-discharge') ?? 0}/${T}; removed at ${N(on, 'dropAtCut')} cuts, seed omits ${N(on, 'dropSeedOmits')}; r7 ledger: ${hit}/${T} seeds removed a register, ${silent} of them fail NO class; classes failing ${JSON.stringify(failing)}`;
  }, 120_000);
  it('n44 (r9): under a non-path-closed array merge L1 fails at random (600 seeds, never stopping); the materialization departure it enables needs a dropped index-mode delete inside the invented key — PINNED (oracle unit test "n44 shape"), reported here', () => {
    // reason: a T1 departure needs two live array sets whose `prev` holds a key at a slot neither
    // value holds AND a lone index-mode delete exactly there — L1 alone is the random tooth
    const x = sweep('n44 full', { ancestorMerge: true }, 600, STEPS, () => false);
    observed(x, 'positional-closure');
    neuterLog['n44 full'] =
      `positional-closure ${x.failing.get('positional-closure') ?? 0}/600, T1-positional ${x.failing.get('T1-positional') ?? 0}/600 (${x.first.get('T1-positional') ?? '-'}), T1-index ${x.failing.get('T1-index') ?? 0}/600 (${x.first.get('T1-index') ?? '-'})`;
  }, 300_000);
  it('n17 (demonstration, not a D11 violation): the OLD metric — every lone tombstone counted — storms', () => {
    const x = sweep('n17', { countAllLone: true }, T, STEPS, look('liveness'));
    neuterLog['n17'] = `${x.failing.get('liveness') ?? 0}/${T}: ${observed(x, 'liveness')}`;
  }, 120_000);
  it('report', { timeout: 300_000 }, () => {
    const before = sweep('r4-no-scenarios', { noScenarios: true }, 200, STEPS);
    neuterLog['reach-without-scenarios'] =
      `F-2a ${N(before, 'seeds:reachF2a')} F-4 ${N(before, 'seeds:reachF4')} F-7 ${N(before, 'seeds:reachF7')} refusals ${N(before, 'seeds:refusalConflicts')} (of 200 seeds)`;
    const counts = Object.fromEntries(
      [...sweeps].map(([k, v]) => [k, { ms: v.ms, failing: Object.fromEntries(v.failing) }]),
    );
    console.log(
      JSON.stringify({ neuters: neuterLog, sweeps: counts, base: sweeps.get('base')?.n }, null, 1),
    );
  });
});

// ─── pinned schedules (never retired; every r1–r3 pin kept, re-expressed where the premise changed) ─

const W = (variant: Variant = {}, canBump?: (writer: string) => boolean, rootless = false): World =>
  createWorld(['A', 'B', 'C'], variant, canBump, rootless);
const setOp = (path: Key[], next: unknown): StoreOp => ({ kind: 'set', path, next });
const delOp = (path: Key[]): StoreOp => ({ kind: 'delete', path, prev: undefined });
const clearOp = (path: Key[]): StoreOp => ({ kind: 'clear', path });
const R = (w: World, id: string): Replica => w.replicas.get(id) as Replica;
const sync = (w: World): void => {
  for (const r of w.replicas.values()) persist(w, r);
};
const replayAll = (w: World, id: string): void => {
  while (R(w, id).rebase && R(w, id).installed) replayStep(w, R(w, id));
};
const lastTail = (w: World, id: string): TailEntry => R(w, id).tail[R(w, id).tail.length - 1];
const relayValue = (w: World, path: Key[], cfg: FoldCfg = 'default'): unknown =>
  lookup(materializeRegs(w.relay.c.checkpoint(), cfg), path).value;
const okWorld = (w: World): void => {
  sync(w);
  observe(w);
  expect(Object.fromEntries(w.violations)).toEqual({});
};
const committed = (
  w: World,
  id: string,
  raw: StoreOp | StoreOp[],
  opt: { bump?: boolean; lower?: (op: SyncOp) => SyncOp } = {},
): TailEntry => {
  const t = author(w, id, raw, opt) as TailEntry;
  expect(toRelay(w, t.env)).toBe('admitted');
  return t;
};
const copyTo = (w: World, t: TailEntry, ...to: string[]): void => {
  for (const id of to) expect(toReplica(w, t.env, R(w, id))).toBe('ok');
};
const flush = (w: World, id: string): RelayAnswer[] =>
  [...R(w, id).tail].map((t) => toRelay(w, t.env));
const owner = (writer: string): boolean => writer === 'A';
const atEpoch =
  (e: number) =>
  (op: SyncOp): SyncOp => ({ ...op, epoch: e });
/** A member presses Compact (its client re-sends the ready flag); a (dis)connect is a declaration change too. */
const press = (w: World, id: string): void => {
  R(w, id).pressed = true;
  declare(w, R(w, id));
};
const setConnected = (w: World, id: string, connected: boolean): void => {
  R(w, id).connected = connected;
  R(w, id).pressed = false;
  declare(w, R(w, id));
};
/** r7: violations other than the classes the adversarial peer channel (n42) is EXPECTED to break. */
const beyondPeer = (w: World): Record<string, string> => {
  const v = Object.fromEntries(w.violations);
  for (const c of PEER_CHANNEL) delete v[c];
  return v;
};
const outcome = (w: World, id: string): Outcome => {
  sync(w);
  return outcomeOf(w, id);
};

describe('generation cut: pinned — authority and replay (Q1–Q4, F-4)', () => {
  it('Q1: astra epoch carry AGREES with U (retained epoch 5); Miha epoch schedule still splits U and C (clear-only register dropped with its baseline)', () => {
    const a = W({}, owner);
    for (let i = 0; i < 5; i++) copyTo(a, committed(a, 'A', setOp(['x'], i), { bump: true }), 'B');
    cut(a, 'reaper', 'replay');
    expect(a.relay.c.maxEpoch(['x'])).toBe(5);
    const carry = author(a, 'B', setOp(['x'], 'b')) as TailEntry;
    expect(toRelay(a, carry.env)).toBe('generation');
    learn(a, R(a, 'B'));
    replayAll(a, 'B');
    expect(lastTail(a, 'B').env.ops[0].epoch).toBe(5);
    expect(flush(a, 'B')).toEqual(['admitted']);
    okWorld(a);
    const build = (): World => {
      const w = W({}, owner);
      for (let i = 0; i < 5; i++)
        copyTo(w, committed(w, 'A', setOp(['x'], i), { bump: true }), 'B', 'C');
      committed(w, 'B', clearOp(['x']), { lower: atEpoch(0) });
      return w;
    };
    const u = build();
    const c = build();
    author(c, 'C', setOp(['x'], 'c'));
    cut(c, 'reaper', 'replay');
    expect(u.relay.c.maxEpoch(['x'])).toBe(5);
    expect(c.relay.c.maxEpoch(['x'])).toBe(0);
    const raw: OpEnvelope = {
      proto: MESH_PROTO_VERSION,
      instance: 'g0',
      policyVersion: 0,
      origin: 'Z',
      writer: 'Z',
      version: 1,
      hlc: { p: 500, l: 0 },
      ops: [{ kind: 'set', path: ['x'], next: 1, cites: [], epoch: 5 }],
    };
    expect(toRelay(u, raw)).toBe('admitted');
    expect(toRelay(c, { ...raw, instance: c.relay.instance })).toBe('epoch-bump'); // the old U≡C theorem fails
    learn(c, R(c, 'C'));
    replayAll(c, 'C');
    expect(R(c, 'C').unresolved.map((x) => x.cause)).toEqual(['uncovered']);
  });

  it('Q2: a writer that saw N supersedes it; one that did not is ordinary concurrency — the uncut twin agrees', () => {
    const a = W();
    copyTo(a, committed(a, 'B', setOp(['x'], 'n')), 'A');
    author(a, 'A', setOp(['x'], 't'));
    cut(a, 'reaper', 'replay');
    learn(a, R(a, 'A'));
    replayAll(a, 'A');
    expect(flush(a, 'A')).toEqual(['admitted']);
    expect(relayValue(a, ['x'])).toBe('t');
    okWorld(a);
    const schedule = (withCut: boolean): unknown => {
      const w = W();
      committed(w, 'B', setOp(['x'], 'n'));
      author(w, 'A', setOp(['x'], 't'));
      if (withCut) {
        cut(w, 'reaper', 'replay');
        learn(w, R(w, 'A'));
        replayAll(w, 'A');
      }
      expect(flush(w, 'A')).toEqual(['admitted']);
      okWorld(w);
      return relayValue(w, ['x']);
    };
    expect(schedule(true)).toBe(schedule(false));
  });

  it('Q3: two cuts offline — receipts trim the acked write; without them the verbatim resend is admitted TWICE', () => {
    const schedule = (variant: Variant, replace: 'set' | 'delete'): World => {
      const w = W(variant);
      copyTo(w, committed(w, 'A', setOp(['x'], 't')), 'B');
      committed(w, 'B', replace === 'set' ? setOp(['x'], 'n') : delOp(['x']));
      cut(w, 'reaper', 'replay');
      cut(w, 'reaper', 'replay');
      learn(w, R(w, 'A'));
      replayAll(w, 'A');
      flush(w, 'A');
      sync(w);
      observe(w);
      return w;
    };
    const ok = schedule({}, 'set');
    expect(outcome(ok, 'A:1')).toEqual({ admitted: 1, conflicts: 0, discarded: 0, trimmed: 1 });
    expect(Object.fromEntries(ok.violations)).toEqual({});
    expect(schedule({ noReceipts: true }, 'set').violations.get('T3-double')).toMatch(
      /intent A:1 admitted twice/,
    );
    const del = schedule({ noReceipts: true }, 'delete');
    expect(relayValue(del, ['x'])).toBe('t'); // the delete is undone by a write already applied once
  });

  it('Q4(i): an owner bump replays verbatim at 6 over the retained 5; Q4(iii): a former carry replays at 5, admitted', () => {
    const w = W({}, owner);
    for (let i = 0; i < 5; i++) copyTo(w, committed(w, 'A', setOp(['x'], i), { bump: true }), 'B');
    author(w, 'A', setOp(['x'], 'six'), { bump: true });
    author(w, 'B', setOp(['y'], 'b'));
    cut(w, 'reaper', 'replay');
    learn(w, R(w, 'A'));
    replayAll(w, 'A');
    expect(lastTail(w, 'A').env.ops[0].epoch).toBe(6);
    expect(flush(w, 'A')).toEqual(['admitted']);
    expect(w.relay.c.maxEpoch(['x'])).toBe(6);
    const v = W({}, owner);
    for (let i = 0; i < 5; i++) copyTo(v, committed(v, 'A', setOp(['x'], i), { bump: true }), 'B');
    author(v, 'B', setOp(['x'], 'b'));
    cut(v, 'reaper', 'replay');
    learn(v, R(v, 'B'));
    replayAll(v, 'B');
    expect(lastTail(v, 'B').env.ops[0].epoch).toBe(5);
    expect(flush(v, 'B')).toEqual(['admitted']);
    okWorld(w);
    okWorld(v);
  });

  it('Q4(ii): resurrect-a-folded-delete ⇒ CONFLICT (the cited dot was folded away)', () => {
    const w = W();
    copyTo(w, committed(w, 'A', setOp(['x'], 1)), 'B');
    author(w, 'A', setOp(['x'], 2));
    committed(w, 'B', delOp(['x']));
    cut(w, 'reaper', 'replay');
    learn(w, R(w, 'A'));
    replayAll(w, 'A');
    expect(R(w, 'A').unresolved.length).toBe(1);
    okWorld(w);
  });

  it('F-4 (D3″): a carry covered by EXTENT replays at 5 and is ADMITTED; n16 (no baselines) ⇒ the relay refuses it ⇒ Conflict', () => {
    for (const noSeedBaselines of [false, true]) {
      const w = W({ noSeedBaselines }, owner);
      for (let i = 0; i < 5; i++)
        copyTo(w, committed(w, 'A', setOp(['x'], i), { bump: true }), 'C');
      author(w, 'C', setOp(['x'], 'c'));
      committed(w, 'A', setOp(['x'], 'again'), { lower: atEpoch(0) });
      const g = cut(w, 'reaper', 'replay');
      learn(w, R(w, 'C'));
      replayAll(w, 'C');
      expect(R(w, 'C').unresolved).toEqual([]);
      if (!noSeedBaselines) {
        expect(g.seed.find((r) => pathKey(r.path) === pathKey(['x']))?.epoch).toBe(5);
        expect(flush(w, 'C')).toEqual(['admitted']);
        okWorld(w);
      } else {
        expect(flush(w, 'C')).toEqual(['epoch-bump']);
        expect(R(w, 'C').unresolved.map((x) => x.cause)).toEqual(['refused-epoch']); // D-b: the refusal lands in Conflict
        expect(w.violations.get('T1')).toMatch(/baseline 0 vs 5/);
      }
    }
  });
});

describe('generation cut: pinned — the seed and T1 (D-a′, F-1, F-6, F-8, F-12, OPEN-2, domain)', () => {
  it('F-1: a delete masking a key of an ancestor value is KEPT ⇒ T1 exact; n12 resurrects it', () => {
    for (const dropEffectTombstones of [false, true]) {
      const w = W({ dropEffectTombstones });
      committed(w, 'A', delOp(['d', 'e', 'f']));
      const g = cut(w, 'reaper', 'replay');
      if (!dropEffectTombstones) {
        expect(g.seed.some((r) => pathKey(r.path) === pathKey(['d', 'e', 'f']))).toBe(true);
        expect(droppableTombstones(w.relay.c)).toBe(0);
        okWorld(w);
      } else {
        expect(materializeRegs(g.seed)).toEqual(INITIAL);
        expect(w.violations.get('T1')).toMatch(/d\.e\.f must be kept/);
        expect(w.violations.get('T1-diff')).toBeDefined();
      }
    }
  });

  it('F-1 residue + F-12 RULED (D-a′): a container re-set clears the kept tombstone, settle collects it, the next cut DROPS the clear-only register; n29 (literal D-a) keeps one register per contained path that never cleans', () => {
    const atDEF = (g: Gen): RegisterCheckpoint | undefined =>
      g.seed.find((r) => pathKey(r.path) === pathKey(['d', 'e', 'f']));
    for (const clearMasks of [false, true]) {
      const w = W({ clearMasks });
      committed(w, 'A', delOp(['d', 'e', 'f']));
      cut(w, 'reaper', 'replay');
      learn(w, R(w, 'A'));
      learn(w, R(w, 'B'));
      const reset = committed(w, 'B', setOp(['d', 'e'], {}));
      expect(
        reset.env.ops
          .find((op) => pathKey(op.path) === pathKey(['d', 'e', 'f']))
          ?.cites?.map((c) => c.origin),
      ).toEqual(['A']);
      committed(w, 'A', setOp(['a'], 1));
      w.relay.c.settle(w.relay.admission.settled);
      expect(w.relay.c.checkpoint().some((r) => r.siblings.some((x) => x.kind === 'delete'))).toBe(
        false,
      );
      const g = cut(w, 'reaper', 'replay');
      // the root's migration document still contains d.e.f, so a clear-only register there is
      // "effect-bearing" by the literal clause, though a clear abstains under every fold in the domain
      expect(!!atDEF(g)).toBe(clearMasks);
      if (!clearMasks) {
        okWorld(w);
        continue;
      }
      expect(w.violations.get('T1')).toMatch(/\["d","e","f"\] kept but droppable/);
      // the residue never cleans: quiet cuts keep it, and a second container re-set only replaces
      // the clear with a newer clear (one register per contained path, for as long as the root holds it)
      for (let i = 0; i < 3; i++) expect(!!atDEF(cut(w, 'reaper', 'replay'))).toBe(true);
      learn(w, R(w, 'A'));
      learn(w, R(w, 'B'));
      committed(w, 'B', setOp(['d', 'e'], {}));
      committed(w, 'A', setOp(['a'], 2));
      w.relay.c.settle(w.relay.admission.settled);
      const last = atDEF(cut(w, 'reaper', 'replay'));
      expect(last?.siblings.map((x) => [x.kind, x.origin])).toEqual([['clear', 'B']]);
    }
  });

  it("D-a (astra's static counterexample): ancestor sets {} (default winner) and {k:1} + child delete k — the winner-based rule drops it and the custom fold resurrects k; D-a′ keeps it", () => {
    for (const materializerKeep of [false, true]) {
      const w = W({ materializerKeep });
      committed(w, 'A', setOp(['k'], { k: 1 })); // the default-fold LOSER (lower stamp)
      committed(w, 'B', setOp(['k'], {})); // concurrent: the default-fold WINNER
      copyTo(w, author(w, 'C', delOp(['k', 'k'])) as TailEntry, 'A');
      flush(w, 'C');
      expect(lookup(materializeRegs(w.relay.c.checkpoint(), 'custom'), ['k'])).toEqual({
        found: true,
        value: {},
      });
      const g = cut(w, 'reaper', 'replay');
      const kept = g.seed.some((r) => pathKey(r.path) === pathKey(['k', 'k']));
      if (!materializerKeep) {
        expect(kept).toBe(true);
        okWorld(w);
      } else {
        expect(kept).toBe(false);
        expect(materializeRegs(g.seed, 'custom')).toMatchObject({ k: { k: 1 } }); // k resurrects under the custom fold
        expect(w.violations.get('T1-diff')).toMatch(/custom fold/);
        expect(w.violations.get('T1')).toMatch(/k\.k must be kept/);
      }
    }
  });

  it('F-8 RULED (D-a′): two concurrent deletes of a never-set key render under `preserve` as a conflict VALUE; the register is KEPT; n28 (literal D-a) drops it ⇒ T1-preserve', () => {
    for (const dropMultiLive of [false, true]) {
      const w = W({ dropMultiLive });
      committed(w, 'A', delOp(['k']));
      committed(w, 'B', delOp(['k'])); // concurrent: neither cites the other
      expect(lookup(materializeRegs(w.relay.c.checkpoint(), 'preserve'), ['k']).found).toBe(true);
      expect(lookup(materializeRegs(w.relay.c.checkpoint()), ['k']).found).toBe(false); // default: absent
      const g = cut(w, 'reaper', 'replay');
      expect(g.seed.some((r) => pathKey(r.path) === pathKey(['k']))).toBe(!dropMultiLive);
      if (!dropMultiLive) {
        expect(droppableTombstones(w.relay.c)).toBe(0); // not lone: never counted, never dropped
        okWorld(w);
      } else {
        expect(w.violations.get('T1-preserve')).toMatch(/preserve fold/);
        expect(w.violations.get('T1')).toMatch(/k must be kept/);
      }
    }
  });

  // §14 T1 SCOPE: astra's three static counterexamples, executed — each a DEMONSTRATION of the
  // declared residual (synthesizing folds), with structural T1 and every selecting fold exact.
  const matWith = (
    regs: readonly RegisterCheckpoint[],
    opts: Parameters<typeof createConvergingApply>[0],
  ) => {
    const f = createConvergingApply(opts);
    f.load(regs);
    return f.materialize();
  };
  const residualCut = (w: World): Gen => {
    const g = cut(w, 'reaper', 'replay');
    expect(oStructural(g.source, g.seed)).toEqual([]); // the seed conforms to D-a′ exactly
    for (const cfg of SELECTING_CFGS)
      expect(pcanon(materializeRegs(g.seed, cfg))).toBe(pcanon(materializeRegs(g.source, cfg)));
    return g;
  };
  it('T1 RESIDUAL demo 1 (astra re-audit): a merge fold reading `prev` (merge = ancestor) synthesizes k.x; the dropped `delete k.x` un-masks it', () => {
    const w = W();
    committed(w, 'A', { kind: 'set', path: ['k'], next: {}, prev: { x: 1 } }); // the lower-ranked set
    committed(w, 'B', setOp(['k'], {})); // concurrent, same epoch, the winner
    committed(w, 'C', delOp(['k', 'x']));
    const merge = { policies: [{ path: ['k'], merge: (ancestor: unknown) => ancestor }] };
    expect(lookup(matWith(w.relay.c.checkpoint(), merge), ['k'])).toEqual({
      found: true,
      value: {},
    });
    const g = residualCut(w);
    expect(g.seed.some((r) => pathKey(r.path) === pathKey(['k', 'x']))).toBe(false);
    expect(lookup(matWith(g.seed, merge), ['k'])).toEqual({ found: true, value: { x: 1 } }); // un-masked
    okWorld(w);
  });

  it('T1 RESIDUAL demo 2 (astra re-audit): shipped `preserve` synthesizes `siblings` for two concurrent `{}` sets; the dropped `delete k.siblings` un-masks it', () => {
    const w = W();
    committed(w, 'A', setOp(['k'], {}));
    committed(w, 'B', setOp(['k'], {}));
    committed(w, 'C', delOp(['k', 'siblings']));
    expect(
      lookup(materializeRegs(w.relay.c.checkpoint(), 'preserve'), ['k', 'siblings']).found,
    ).toBe(false);
    const g = residualCut(w);
    expect(lookup(materializeRegs(g.seed, 'preserve'), ['k', 'siblings'])).toEqual({
      found: true,
      value: [{}, {}],
    }); // un-masked
    expect(w.violations.get('T1-residual')).toMatch(/preserve fold/);
    w.violations.delete('T1-residual'); // reported, never asserted: the rest of the world is clean
    okWorld(w);
  });

  it('T1 RESIDUAL demo 3 (astra re-audit): a custom fold turning a lone clear into a delete; the dropped clear-only register un-masks `a`', () => {
    const w = W();
    committed(w, 'A', clearOp(['a']));
    expect(lookup(materializeRegs(w.relay.c.checkpoint(), 'synth'), ['a']).found).toBe(false);
    expect(lookup(materializeRegs(w.relay.c.checkpoint()), ['a'])).toEqual({
      found: true,
      value: 0,
    });
    const g = residualCut(w);
    expect(g.seed.some((r) => pathKey(r.path) === pathKey(['a']))).toBe(false);
    expect(lookup(materializeRegs(g.seed, 'synth'), ['a'])).toEqual({ found: true, value: 0 }); // un-masked
    expect(w.violations.get('T1-residual')).toMatch(/synth fold/);
    w.violations.delete('T1-residual');
    okWorld(w);
  });

  // R16-4 T1 DOMAIN: two OUT-OF-DOMAIN demonstrations (labeled residual, like the synthesizing pins)
  it('R16-4 OUT OF DOMAIN (astra audit #3 Q5): an ABSTAINING root fold (the root register exists, its fold returns `clear`) — before the cut a lone `delete z.x` vivifies `{z:{}}`; D-a′ drops it (no contributing root value contains z.x) and after the cut the room is `undefined`', () => {
    const w = W();
    committed(w, 'A', delOp(['z', 'x']));
    const abstain = { folds: [{ path: [], fold: (() => ({ kind: 'clear' })) as FoldFn }] };
    expect(pcanon(matWith(w.relay.c.checkpoint(), abstain))).toBe(pcanon({ z: {} })); // vivified
    const g = residualCut(w); // the seed conforms to D-a′; every SELECTING fold (contributing root) is exact
    expect(g.seed.some((r) => pathKey(r.path) === pathKey(['z', 'x']))).toBe(false);
    expect(g.seed.some((r) => !r.path.length)).toBe(true); // the root register is still there ...
    expect(matWith(g.seed, abstain)).toBeUndefined(); // ... but abstains: the vivified `{z:{}}` is gone
    okWorld(w);
  });

  it('R16-4 positional demo (r9: PREMISE MOVED — positional merge is now IN the domain, proven path-closed; the index-mode register below the array stays out): `policies: []` merges concurrent array sets POSITIONALLY into a value no live sibling holds; the seed keeps the array register whole and the materialization is exact', () => {
    const anc = ['a', 'b'];
    const arr = (origin: string, p: number, value: unknown): SyncSibling => ({
      kind: 'set',
      origin,
      writer: origin,
      hlc: { p, l: 0 },
      epoch: 0,
      value,
      prev: anc,
    });
    const regs: RegisterCheckpoint[] = [
      { path: [], siblings: [rootSibling('g0', { p: 1, l: 0 }, { arr: anc })], water: {} },
      { path: ['arr'], siblings: [arr('A', 5, ['X', 'b']), arr('B', 6, ['a', 'Y'])], water: {} },
      // an INDEX-MODE register below the array path (never emitted under `arrays: 'unit'`)
      {
        path: ['arr', '1'],
        siblings: [{ kind: 'clear', origin: 'C', writer: 'C', hlc: { p: 7, l: 0 }, epoch: 0 }],
        water: {},
      },
    ];
    const merged = lookup(materializeRegs(regs), ['arr']).value;
    expect(merged).toEqual(['X', 'Y']); // synthesized: equals neither live sibling value
    expect(
      [
        ['X', 'b'],
        ['a', 'Y'],
      ].some((v) => pcanon(v) === pcanon(merged)),
    ).toBe(false);
    const seed = reaperSeed(regs);
    expect(oStructural(regs, seed)).toEqual([]); // the array register is kept WHOLE (every live sibling)
    expect(pcanon(materializeRegs(seed))).toBe(pcanon(materializeRegs(regs)));
    expect(pcanon(materializeRegs(seed, 'positional'))).toBe(
      pcanon(materializeRegs(regs, 'positional')),
    );
    expect(oPositional(regs, 'policy')).toMatchObject({ violations: [], synth: 1 }); // r9: closed
  });

  it('presence: a present-undefined value survives the cut and is distinguished from an absent key (JSON would hide it)', () => {
    const w = W();
    committed(w, 'A', setOp(['k'], { m: undefined }));
    const g = cut(w, 'reaper', 'replay');
    expect(pcanon(materializeRegs(g.seed))).toBe(pcanon(materializeRegs(g.source)));
    expect(pcanon({ m: undefined })).not.toBe(pcanon({}));
    expect(JSON.stringify({ m: undefined })).toBe(JSON.stringify({})); // the hidden distinction
    okWorld(w);
  });

  it('path identity: the store keys a register by String(segment) — a numeric and a string segment are ONE register; the oracle uses the same identity', () => {
    const st = createRegisterStore();
    st.ingest({
      proto: MESH_PROTO_VERSION,
      instance: 'g0',
      policyVersion: 0,
      origin: 'A',
      writer: 'A',
      version: 1,
      hlc: { p: 10, l: 0 },
      ops: [{ kind: 'set', path: ['1'], next: 1, cites: [], epoch: 0 }],
    });
    expect(st.covers([1], { origin: 'A', hlc: { p: 10, l: 0 } })).toBe(true);
    expect(oPathKey([1])).toBe(oPathKey(['1']));
  });

  it('PATH ENCODING precondition (§14): the store joins String(segment) with the unit separator — the real validateEnvelope rejects a separator in a segment, a duplicate path, and (S2) an empty segment, whose register would collide with the root', () => {
    const env = (path: Key[], extra: Key[][] = []): OpEnvelope => ({
      proto: MESH_PROTO_VERSION,
      instance: 'g0',
      policyVersion: 0,
      origin: 'A',
      writer: 'A',
      version: 1,
      hlc: { p: 10, l: 0 },
      ops: [path, ...extra].map((p) => ({ kind: 'set', path: p, next: 1, cites: [], epoch: 0 })),
    });
    expect(validateEnvelope(env(['a\u001fb']))).toBe('path-control'); // would collide with ['a', 'b']
    expect(validateEnvelope(env(['b'], [['b']]))).toBe('dup-path');
    expect(validateEnvelope(env(['']))).toBe('path-empty'); // rejected since S2, because ...
    const st = createRegisterStore();
    st.load([{ path: [], siblings: [rootSibling('g0', { p: 1, l: 0 }, INITIAL)], water: {} }]);
    st.ingest(env(['']));
    expect(st.checkpoint().length).toBe(1); // ... the store would land it IN the root register
    expect(
      st
        .siblings([])
        .map((s) => s.origin)
        .sort(),
    ).toEqual(['A', 'g0']);
  });

  it('F-6: the live-descendant clause is never T1-load-bearing under D-a′; it keeps the tombstone CITABLE so a re-create over a hidden edit applies', () => {
    for (const noDescendantRule of [false, true]) {
      const w = W({ noDescendantRule });
      committed(w, 'A', setOp(['k', 'c'], 1));
      const del = committed(w, 'B', delOp(['k']));
      copyTo(w, del, 'C');
      author(w, 'C', setOp(['k'], {}));
      cut(w, 'reaper', 'replay');
      expect(w.violations.get('T1-diff')).toBeUndefined();
      learn(w, R(w, 'C'));
      replayAll(w, 'C');
      flush(w, 'C');
      if (!noDescendantRule) {
        expect(R(w, 'C').unresolved).toEqual([]);
        expect(relayValue(w, ['k'])).toEqual({ c: 1 });
        okWorld(w);
      } else {
        expect(R(w, 'C').unresolved.length).toBe(1);
        expect(w.violations.get('T1')).toMatch(/k must be kept/);
      }
    }
  });

  it('OPEN-2 (remains; S2 verifies real rooms hold a root): in a ROOTLESS room a delete under an absent parent vivifies `{b:{}}`; the seed cannot', () => {
    const w = W({}, undefined, true);
    committed(w, 'A', delOp(['b', 'c']));
    expect(materializeRegs(w.relay.c.checkpoint())).toEqual({ b: {} });
    cut(w, 'reaper', 'replay');
    expect(w.violations.get('T1-diff')).toMatch(/default fold\): source \{"b":\{\}\} vs seed U/);
  });
});

describe('generation cut: pinned — budget (Q5, F-3)', () => {
  it('Q5: continuous deletes of fresh keys vs the hard budget — within budget, cuts keep coming; document-key deletes never count', () => {
    const w = W();
    for (let round = 0; round < 60; round++) {
      const t = author(w, 'A', delOp([`k${round % 7}`]));
      if (t && toRelay(w, t.env) === 'generation') {
        learn(w, R(w, 'A'));
        replayAll(w, 'A');
        flush(w, 'A');
      }
      enforceBudget(w, 2);
      expect(droppableTombstones(w.relay.c)).toBeLessThanOrEqual(2);
    }
    expect(w.n['budgetCuts'] ?? 0).toBeGreaterThanOrEqual(15);
    okWorld(w);
    const doc = W();
    for (const p of [['a'], ['b', 'c'], ['d', 'e', 'f']] as Key[][]) committed(doc, 'A', delOp(p));
    enforceBudget(doc, 0);
    expect(doc.n['budgetCuts'] ?? 0).toBe(0);
    expect(loneTombstones(doc.relay.c).length).toBe(3);
  });

  it('F-3: tombstones kept by the live-descendant clause are not counted ⇒ no storm; n17 (the old metric) storms', () => {
    for (const countAllLone of [false, true]) {
      const w = W({ countAllLone });
      committed(w, 'A', setOp(['b', 'c'], 1));
      committed(w, 'A', setOp(['d', 'e'], 1));
      committed(w, 'B', delOp(['b']));
      committed(w, 'B', delOp(['d']));
      for (let i = 0; i < 3; i++) enforceBudget(w, 1);
      if (!countAllLone) {
        expect(w.n['budgetCuts'] ?? 0).toBe(0);
        okWorld(w);
      } else expect(w.n['budgetCuts']).toBe(3);
    }
  });
});

describe('generation cut: pinned — N8 (r9, charter §22)', () => {
  it('N8: a container `set` over a path holding a lone descendant tombstone — root `{d:{}}` (minted), `delete d.e` (droppable), a writer that never saw it sets `d = {e:1}` (no expansion clear reaches d.e) ⇒ the delete is now contained and the MAINTAINED count reclassifies the descendant (1 → 0), equal to the full scan', () => {
    const w = W();
    committed(w, 'A', setOp(['d'], {}));
    cut(w, 'migration', 'discard');
    learn(w, R(w, 'A'));
    learn(w, R(w, 'B')); // B installs the minted root before the delete exists
    expect(lookup(relayValue(w, []), ['d'])).toEqual({ found: true, value: {} });
    committed(w, 'A', delOp(['d', 'e']));
    expect(droppableTombstones(w.relay.c)).toBe(1);
    expect(droppableTombstonesScan(w.relay.c)).toBe(1);
    const t = committed(w, 'B', setOp(['d'], { e: 1 }));
    expect(t.env.ops.map((op) => op.path)).toEqual([['d']]); // no clear of d.e: B never saw it
    expect(w.relay.c.siblings(['d', 'e']).map((s) => s.kind)).toEqual(['delete']); // still live ...
    expect(droppableTombstonesScan(w.relay.c)).toBe(0); // ... and contained by d's live set
    expect(droppableTombstones(w.relay.c)).toBe(0); // the real counter reclassified the descendant
    expect(relayValue(w, ['d'])).toEqual({}); // the kept delete masks e
    okWorld(w);
  });
});

describe('generation cut: pinned — covers (D-f, F-2, F-5, F-7)', () => {
  it('F-2a: the frozen extent covers a seed dot the generation superseded AND collected; n14 without it is GC-sensitive', () => {
    for (const noExtent of [false, true]) {
      const w = W({ noExtent });
      copyTo(w, committed(w, 'A', setOp(['x'], 1)), 'C');
      author(w, 'C', setOp(['x'], 'c'));
      cut(w, 'reaper', 'replay');
      learn(w, R(w, 'B'));
      // R16-6: B's FRESH write citing the seed dot passes the same gate — which, without the extent,
      // refuses it too (premise moved in r6: the supersession is then never admitted)
      const tb = author(w, 'B', setOp(['x'], 'b')) as TailEntry;
      expect(toRelay(w, tb.env)).toBe(noExtent ? 'unknown-citation' : 'admitted');
      learn(w, R(w, 'A'));
      committed(w, 'A', setOp(['y'], 1));
      w.relay.c.settle(w.relay.admission.settled);
      learn(w, R(w, 'C'));
      replayAll(w, 'C');
      sync(w);
      observe(w);
      if (!noExtent) {
        expect(R(w, 'C').unresolved.length).toBe(0);
        expect(Object.fromEntries(w.violations)).toEqual({});
      } else expect(w.violations.get('T2a-gc')).toMatch(/procedure conflict, oracle apply/);
    }
  });

  it('§14 client record: the pre-check after a RELOAD reads the extent from the client record ALONE; n33 (record without the generation fields) ⇒ the F-2a replay conflicts (T2a-gc) — r9 (premise moved): with the persisting replica; the NO-PERSIST replica replays only after a welcome re-installs the fields, so n33 cannot bite there', () => {
    for (const persistRegisters of [true, false])
      for (const recordNoGen of [false, true]) {
        const w = W({ recordNoGen, persistRegisters });
        copyTo(w, committed(w, 'A', setOp(['x'], 1)), 'C');
        author(w, 'C', setOp(['x'], 'c'));
        cut(w, 'reaper', 'replay');
        learn(w, R(w, 'B'));
        committed(w, 'B', setOp(['x'], 'b'));
        learn(w, R(w, 'A'));
        committed(w, 'A', setOp(['y'], 1));
        w.relay.c.settle(w.relay.admission.settled);
        learn(w, R(w, 'C')); // installed: the record now holds g1's extent
        sync(w);
        reload(w, R(w, 'C')); // a crash before the replay: memory gone, the record is all there is
        expect(R(w, 'C').rebase?.remaining.length).toBe(1);
        replayAll(w, 'C');
        if (!persistRegisters) {
          expect(R(w, 'C').rebase?.remaining.length).toBe(1); // waits for the install
          learn(w, R(w, 'C'));
          replayAll(w, 'C');
        }
        sync(w);
        observe(w);
        if (!recordNoGen || !persistRegisters) {
          expect(R(w, 'C').unresolved).toEqual([]);
          expect(Object.fromEntries(w.violations)).toEqual({});
        } else expect(w.violations.get('T2a-gc')).toMatch(/procedure conflict, oracle apply/);
      }
  });

  it('F-2b under D-f: a dropped old dot is PRE-CUT ⇒ only the extent answers ⇒ conflict, with or without the floor (n11′ bites only on new-generation dots)', () => {
    for (const unflooredExempt of [false, true]) {
      const w = W({ unflooredExempt });
      copyTo(w, committed(w, 'A', setOp(['x'], 1)), 'B', 'C');
      committed(w, 'B', setOp(['x'], 'b'));
      author(w, 'C', setOp(['x'], 'c'));
      cut(w, 'reaper', 'replay');
      learn(w, R(w, 'A'));
      committed(w, 'A', setOp(['y'], 1));
      learn(w, R(w, 'C'));
      replayAll(w, 'C');
      sync(w);
      observe(w);
      expect(R(w, 'C').unresolved.length).toBe(1);
      expect(Object.fromEntries(w.violations)).toEqual({});
    }
  });

  it('F-7 (r3.1) under D-f: a pre-cut dot covered only by a NEWER same-origin sibling of the generation conflicts, collected or not', () => {
    for (const settle of [false, true]) {
      const w = W();
      copyTo(w, committed(w, 'C', setOp(['x'], 'c1')), 'A', 'B');
      committed(w, 'A', setOp(['x'], 'a1'));
      author(w, 'B', setOp(['x'], 'b'));
      cut(w, 'reaper', 'replay');
      learn(w, R(w, 'C'));
      committed(w, 'C', setOp(['x'], 'c2'));
      learn(w, R(w, 'A'));
      committed(w, 'A', setOp(['x'], 'a2'));
      if (settle) w.relay.c.settle(w.relay.admission.settled);
      learn(w, R(w, 'B'));
      replayAll(w, 'B');
      expect(R(w, 'B').unresolved.length).toBe(1);
      okWorld(w);
    }
  });

  it('D-f KILLED boundary (first stamp of the generation) is ORDER-DEPENDENT: a replayed refused hole lowers the first stamp and a dropped dot covered by a newer sibling APPLIES; without the hole it conflicts; the ruled preCutMax conflicts both ways', () => {
    const schedule = (firstStampBoundary: boolean, withHole: boolean): World => {
      const w = W({ firstStampBoundary, ignoreDrop: true, citePeer: true }, owner); // a lost refusal reply keeps the hole in C's outbox; r7: C's carry of A's PEER-held bump needs n42
      const a1 = author(w, 'A', setOp(['x'], 1), { bump: true }) as TailEntry;
      copyTo(w, a1, 'C');
      if (withHole)
        expect(toRelay(w, (author(w, 'C', setOp(['x'], 'c1')) as TailEntry).env)).toBe(
          'epoch-bump',
        ); // C1: the hole
      expect(toRelay(w, a1.env)).toBe('admitted');
      const c2 = committed(w, 'C', setOp(['y'], 'c2'));
      copyTo(w, c2, 'A', 'B');
      committed(w, 'B', setOp(['y'], 'b1')); // supersedes C2: dropped at the cut
      author(w, 'A', setOp(['y'], 'a2')); // A's pending write cites C2
      cut(w, 'reaper', 'replay');
      learn(w, R(w, 'C'));
      replayAll(w, 'C'); // C1 (if any) replays verbatim and is admitted: first[C] = C1 < C2
      flush(w, 'C');
      committed(w, 'C', setOp(['y'], 'c3')); // C's newer sibling at y
      learn(w, R(w, 'A'));
      replayAll(w, 'A');
      sync(w);
      observe(w);
      return w;
    };
    expect(R(schedule(true, true), 'A').unresolved.length).toBe(0); // killed boundary, hole first: applies (unsound)
    expect(schedule(true, true).violations.get('T2a')).toMatch(/procedure apply, oracle conflict/);
    expect(R(schedule(true, false), 'A').unresolved.length).toBe(1); // killed boundary, no hole: conflicts
    expect(R(schedule(false, true), 'A').unresolved.length).toBe(1); // ruled: conflicts
    expect(R(schedule(false, false), 'A').unresolved.length).toBe(1);
  });

  it('ACCEPTED RESIDUAL (F-11, ruled 2026-11-07) — D-f conservative residual: a replayed hole op is admitted in the new generation, yet a later cite of it is judged by the seed extent ⇒ false conflict (surfaced) — and a fresh write citing it trips D6-residual (F-11)', () => {
    const w = W({ ignoreDrop: true, citePeer: true }, owner); // r7: the hole is an n42 carry of a peer-held bump
    const a1 = author(w, 'A', setOp(['x'], 1), { bump: true }) as TailEntry;
    copyTo(w, a1, 'C');
    const c1 = author(w, 'C', setOp(['x'], 'c1')) as TailEntry;
    expect(toRelay(w, c1.env)).toBe('epoch-bump');
    copyTo(w, c1, 'B');
    author(w, 'B', setOp(['x'], 'b')); // B's pending write cites C1
    expect(toRelay(w, a1.env)).toBe('admitted');
    committed(w, 'C', setOp(['y'], 'c2')); // preCutMax[C] = C2 > C1
    cut(w, 'reaper', 'replay');
    learn(w, R(w, 'C'));
    replayAll(w, 'C');
    expect(flush(w, 'C')).toEqual(['admitted']); // C1 is now in this generation
    learn(w, R(w, 'B'));
    replayAll(w, 'B');
    expect(R(w, 'B').unresolved.map((x) => x.cause)).toEqual(['uncovered']); // the residual: a false conflict
    learn(w, R(w, 'A')); // A's welcome holds C1
    author(w, 'A', setOp(['x'], 'a')); // a FRESH write citing C1 (live in A's view)
    expect(w.violations.get('D6-residual')).toMatch(/fresh .* uncovered cite C@/);
  });

  it('F-5: receipts are exact RANGES — a hole whose refusal reply was lost is kept; the by-maximum reading LOSES it', () => {
    for (const trimByMax of [false, true]) {
      const w = W({ trimByMax, ignoreDrop: true, citePeer: true }, owner); // r7: the hole via n42
      const bump = author(w, 'A', setOp(['x'], 1), { bump: true }) as TailEntry;
      copyTo(w, bump, 'C');
      const c1 = author(w, 'C', setOp(['x'], 'c')) as TailEntry;
      expect(toRelay(w, c1.env)).toBe('epoch-bump');
      committed(w, 'C', setOp(['y'], 2));
      cut(w, 'reaper', 'replay');
      learn(w, R(w, 'C'));
      expect(w.n['holesBelowThrough']).toBe(1);
      if (!trimByMax) expect(outcome(w, c1.intent.id).trimmed).toBe(0);
      else {
        expect(outcome(w, c1.intent.id)).toMatchObject({ admitted: 0, trimmed: 1 });
        expect(w.violations.get('D7-hole')).toMatch(/g0:C#1 .* LOST/);
      }
    }
  });

  it('F-2 obligation (i): settled never bridges a hole — bridging lets a skipped (conflicted) version be exempt (n15)', () => {
    for (const bridgeHoles of [false, true]) {
      const w = W({ bridgeHoles, citePeer: true }); // r7: C builds on A#2 by PEER copy only under n42
      copyTo(w, committed(w, 'B', setOp(['z'], 1)), 'A');
      copyTo(w, committed(w, 'B', delOp(['z'])), 'A');
      author(w, 'A', setOp(['y'], 5));
      const a2 = author(w, 'A', setOp(['z'], 'again')) as TailEntry; // cites the tombstone ⇒ conflict
      author(w, 'A', setOp(['q'], 7));
      copyTo(w, a2, 'C');
      author(w, 'C', setOp(['z'], 'c')); // builds on A#2 by peer copy
      cut(w, 'reaper', 'replay');
      learn(w, R(w, 'A'));
      replayAll(w, 'A');
      expect(flush(w, 'A')).toEqual(['admitted', 'admitted']);
      learn(w, R(w, 'C'));
      replayAll(w, 'C');
      sync(w);
      observe(w);
      if (!bridgeHoles) {
        expect(R(w, 'C').unresolved.length).toBe(1);
        expect(beyondPeer(w)).toEqual({}); // n42 channel: only the discipline breach itself (`stamp-discipline`)
        expect(w.violations.get('stamp-discipline')).toBeDefined();
      } else expect(w.violations.get('T2a')).toMatch(/procedure apply, oracle conflict/);
    }
  });

  it('F-2 obligation (ii): recovery persists the extent and the floors, SEPARATELY observable (n13a, n13b)', () => {
    for (const v of [{}, { checkpointNoExtent: true }, { checkpointNoFloors: true }] as Variant[]) {
      const w = W(v);
      committed(w, 'A', setOp(['x'], 1));
      cut(w, 'reaper', 'replay');
      learn(w, R(w, 'A'));
      committed(w, 'A', setOp(['y'], 2));
      relayCheckpoint(w);
      w.recovered = relayRecover(w, () => 0.9);
      sync(w);
      observe(w);
      if (v.checkpointNoExtent)
        expect(w.violations.get('recovery')).toMatch(/seed extent|admission/);
      else if (v.checkpointNoFloors)
        expect(w.violations.get('recovery')).toMatch(/floors|admission/);
      else expect(Object.fromEntries(w.violations)).toEqual({});
    }
  });
});

describe('generation cut: pinned — protocol (Q6, D10, kill target, OPEN-1/3/4/5, FINDING-3)', () => {
  it('Q6: a relay crash after the cut recovers whole from the pre-cut OR the post-cut checkpoint and becomes THE relay; a mix refuses to boot', () => {
    for (const when of ['pre', 'post'] as const) {
      const w = W();
      committed(w, 'A', setOp(['x'], 1));
      committed(w, 'B', setOp(['y'], 2));
      if (when === 'pre') relayCheckpoint(w);
      author(w, 'A', setOp(['x'], 'pending'));
      cut(w, 'reaper', 'replay');
      if (when === 'post') relayCheckpoint(w);
      const before = pcanon(materializeRegs(w.relay.c.checkpoint()));
      relayCrash(w, () => 0.9);
      expect(w.relay.instance).toBe('g1');
      expect(pcanon(materializeRegs(w.relay.c.checkpoint()))).toBe(before);
      learn(w, R(w, 'A'));
      replayAll(w, 'A');
      expect(outcome(w, 'A:1').trimmed).toBe(1);
      expect(flush(w, 'A')).toEqual(['admitted']);
      okWorld(w);
      const stale = author(w, 'B', setOp(['z'], 'old')) as TailEntry; // B never learned: authored under g0
      const cp = w.checkpoint as NonNullable<World['checkpoint']>;
      const core: RelayCore = {
        instance: cp.instance,
        stores: [createRegisterStore()],
        admission: newAdmission(),
        receipts: new Map(),
        extent: cp.extent,
        preCutMax: cp.preCutMax,
        everMax: {},
        refused: new Map(),
      };
      core.stores[0].load(cp.registers);
      expect(() =>
        [...w.journal.slice(cp.at), { kind: 'env', env: stale.env } as JournalEntry].forEach((e) =>
          applyEntry(core, e),
        ),
      ).toThrow(/inconsistent checkpoint/);
    }
  });

  it('D5 kill target: cites of the loser, both, or the winner are all covered ⇒ apply; the fold decides', () => {
    for (const keep of [['A'], ['A', 'B'], ['B']]) {
      const w = W();
      const x = committed(w, 'A', setOp(['x'], 'loser'));
      const y = committed(w, 'B', setOp(['x'], 'winner'));
      copyTo(w, x, 'C');
      copyTo(w, y, 'C');
      author(w, 'C', setOp(['x'], 'c'), {
        lower: (op) => ({ ...op, cites: (op.cites ?? []).filter((d) => keep.includes(d.origin)) }),
      });
      cut(w, 'reaper', 'replay');
      learn(w, R(w, 'C'));
      replayAll(w, 'C');
      expect(flush(w, 'C')).toEqual(['admitted']);
      expect(relayValue(w, ['x'])).toBe('c');
      okWorld(w);
    }
  });

  it('D10: an old-generation peer copy delivered after the cut is refused by the replica; without the fence it diverges', () => {
    for (const noReplicaFence of [false, true]) {
      const w = W({ noReplicaFence });
      committed(w, 'A', setOp(['x'], 1));
      const late = author(w, 'A', setOp(['x'], 'late')) as TailEntry;
      cut(w, 'migration', 'discard');
      learn(w, R(w, 'B'));
      const res = toReplica(w, late.env, R(w, 'B'));
      sync(w);
      observe(w);
      if (!noReplicaFence) {
        expect(res).toBe('dead');
        expect(Object.fromEntries(w.violations)).toEqual({});
      } else expect(w.violations.get('converge')).toMatch(/B on g1 materializes/);
    }
  });

  it('OPEN-1/3/4 dissolved: an offline create applies; an untouched path replays across 1, 2 and 5 cuts; two pending writes on one path both apply', () => {
    const create = W();
    author(create, 'A', setOp(['z'], 'new'));
    cut(create, 'reaper', 'replay');
    learn(create, R(create, 'A'));
    replayAll(create, 'A');
    expect(flush(create, 'A')).toEqual(['admitted']);
    okWorld(create);
    for (const cuts of [1, 2, 5]) {
      const w = W();
      committed(w, 'A', setOp(['x'], 1));
      author(w, 'A', setOp(['x'], 2));
      author(w, 'A', setOp(['x'], 3));
      for (let i = 0; i < cuts; i++) cut(w, 'reaper', 'replay');
      learn(w, R(w, 'A'));
      replayAll(w, 'A');
      expect(flush(w, 'A')).toEqual(['admitted', 'admitted']);
      expect(relayValue(w, ['x'])).toBe(3);
      okWorld(w);
    }
  });

  it('FINDING-3 (accepted residual): a re-create citing a dropped tombstone ⇒ CONFLICT; re-author (the raw LIST) writes it again, admitted', () => {
    const w = W();
    copyTo(w, committed(w, 'A', setOp(['z'], 1)), 'B');
    copyTo(w, committed(w, 'B', delOp(['z'])), 'A');
    const t = author(w, 'A', setOp(['z'], 'again')) as TailEntry;
    cut(w, 'reaper', 'replay');
    learn(w, R(w, 'A'));
    replayAll(w, 'A');
    expect(R(w, 'A').unresolved.map((c) => c.entry.intent.id)).toEqual([t.intent.id]);
    resolve(w, R(w, 'A'), true);
    expect(toRelay(w, lastTail(w, 'A').env)).toBe('admitted');
    expect(relayValue(w, ['z'])).toBe('again');
    okWorld(w);
  });

  it('OPEN-5 (remains): a bump intent without authority, pending across the cut, is surfaced as a conflict', () => {
    const w = W({}, owner);
    committed(w, 'A', setOp(['x'], 1));
    author(w, 'B', setOp(['x'], 'b'), { bump: true });
    cut(w, 'reaper', 'replay');
    learn(w, R(w, 'B'));
    replayAll(w, 'B');
    expect(R(w, 'B').unresolved.map((x) => x.cause)).toEqual(['unauthorized']);
    okWorld(w);
  });
});

describe('generation cut: pinned — the T3 ledger (§14)', () => {
  it("astra's discriminating schedule: A's first epoch-0 `set x` admitted but NOT ingested ⇒ the ledger fails at once; the r4 proxy (covers ∨ first ≤ h ≤ settled) passed it", () => {
    for (const omitIngest of [false, true]) {
      const w = W({ omitIngest });
      for (let i = 1; i <= 3; i++) committed(w, 'A', setOp([`x${i}`], i)); // A#3 is the victim
      const a3 = w.journal.length;
      const env = (w.journal[a3 - 1] as { env: OpEnvelope }).env;
      const d = { origin: env.origin, hlc: env.hlc };
      const adm = w.relay.admission;
      const proxy =
        w.relay.c.covers(['x3'], d) ||
        (compareHlc(d.hlc, adm.settled['A']) <= 0 && compareHlc(d.hlc, adm.first['A']) >= 0);
      expect(proxy).toBe(true); // the killed proxy certifies the op either way
      expect(w.relay.receipts.get('A')?.get('g0')?.versions.has(3)).toBe(true);
      sync(w);
      observe(w);
      if (!omitIngest) expect(Object.fromEntries(w.violations)).toEqual({});
      else expect(w.violations.get('ledger')).toMatch(/g0:A#3@\["x3"\]: absent/);
    }
  });

  it("R16-1 (astra audit #3 Q2): A's acked `set x=1` at epoch 5, B's acked epoch-0 `set x=2` citing A ⇒ x=2; n36 loses B's watermark (sibling + accounting kept) ⇒ A is live again and wins (x=1) — the SUPPRESSION check names it, retention alone would pass", () => {
    for (const dropWater of [false, true]) {
      const w = W({ dropWater }, owner);
      for (let i = 5; i >= 1; i--) committed(w, 'A', setOp(['x'], i), { bump: true }); // x=1 at epoch 5
      expect(w.relay.c.maxEpoch(['x'])).toBe(5);
      committed(w, 'B', setOp(['y'], 1));
      committed(w, 'B', setOp(['z'], 1));
      copyTo(w, lastTail(w, 'A'), 'B');
      const b = committed(w, 'B', setOp(['x'], 2), { lower: atEpoch(0) }); // B#3: the n36 victim
      expect(b.env.ops[0].cites?.map((c) => c.origin)).toEqual(['A']);
      sync(w);
      observe(w);
      expect(lMissing(w.ledger, w.relay.c.checkpoint())).toEqual([]); // retention holds either way
      if (!dropWater) {
        expect(relayValue(w, ['x'])).toBe(2);
        expect(Object.fromEntries(w.violations)).toEqual({});
        cut(w, 'reaper', 'replay'); // the cut keeps B only; the obligation moves to the old marks
        okWorld(w);
      } else {
        expect(relayValue(w, ['x'])).toBe(1); // the acknowledged supersession is gone
        expect(w.violations.get('ledger')).toMatch(/acked supersession.*A@\d+\.0 live/);
      }
    }
  });

  it("R19-1 (astra audit #4 Q3, 5 steps): A's sole acked `set x=1` (no cites); a retention defect raises water[A] = A's stamp at x on BOTH twins (sibling + accounting kept); x disappears; retention and both suppression checks pass; the cut drops x, the seed omits it — under the r7 ledger the record is discharged `dropped` and EVERY class stays silent (A's acked write is gone from A's own screen); R19-1 names it before the cut (`ledger`) and refuses the discharge (`ledger-discharge`)", () => {
    for (const r7Ledger of [true, false]) {
      const w = W({ r7Ledger });
      const a = committed(w, 'A', setOp(['x'], 1)); // 1. acknowledged, no citations
      expect(a.env.ops[0].cites).toEqual([]);
      const rec = w.ledger.recs.find((r) => r.key === oPathKey(['x'])) as LRec;
      expect(rec.done).toBeUndefined();
      excessWater([w.relay.u, w.relay.c], ['x'], 'A', a.env.hlc); // 2. the defect, on both twins
      const regs = w.relay.c.checkpoint();
      expect(regs.find((r) => pathKey(r.path) === pathKey(['x']))?.siblings).toHaveLength(1);
      expect(relayValue(w, ['x'])).toBeUndefined(); // 3. the acknowledged value disappears
      expect(lMissing(w.ledger, regs)).toEqual([]); // 4. retention passes ...
      expect(lSuppress(w.ledger.marks, regs)).toEqual([]); // ... and both suppression checks
      expect(lSuppress(w.ledger.oldMarks, regs)).toEqual([]);
      expect(lHidden(w.ledger, regs)).toEqual([
        'g0:A#1@["x"]: acked effect hidden under water A@' +
          `${a.env.hlc.p}.0, no acked cite requires it`,
      ]);
      sync(w);
      observe(w); // the twins agree: every differential check is silent
      if (r7Ledger) expect(Object.fromEntries(w.violations)).toEqual({});
      else
        expect(w.violations.get('ledger')).toMatch(
          /live relay: 1 g0:A#1@\["x"\]: acked effect hidden/,
        );
      const g = cut(w, 'reaper', 'replay'); // 5. D-a′ sees nothing live at x and drops the register
      expect(oKept(g.source).has(oPathKey(['x']))).toBe(false);
      expect(g.seed.some((r) => pathKey(r.path) === pathKey(['x']))).toBe(false); // the seed omits x
      if (r7Ledger) {
        expect(rec.done).toBe('dropped'); // corruption accepted as a structural discharge
        learn(w, R(w, 'A'));
        expect(lookup(R(w, 'A').u.materialize(), ['x']).found).toBe(false); // gone from its author too
        okWorld(w); // every class silent: the gap R19-1 closes
      } else {
        expect(rec.done).toBeUndefined();
        expect(w.violations.get('ledger-discharge')).toMatch(
          /g1 \(reaper\): not discharged as dropped: g0:A#1@\["x"\]: acked effect hidden/,
        );
        expect(lMissing(w.ledger, w.relay.c.checkpoint())).toEqual(['g0:A#1@["x"]: absent']); // still named
      }
    }
  });

  it("R20-1 (astra audit #5, 4 steps): A's sole acked `set x=1` (no cites); the pre-cut check passes; at n43b's point (after that check, before the source is read) the WHOLE register x is removed from both twins (admission, receipts, ledger kept); the R19-1 hidden check skips the absent sibling, D-a′ has no x, so an unchecked discharge marks the record `dropped` and every invoked check passes — the ruled cut names the loss on the source (`ledger`) and refuses the discharge (`ledger-discharge`)", () => {
    for (const r7Ledger of [true, false]) {
      const w = W({ dropRegisterAtCut: true, r7Ledger });
      const a = committed(w, 'A', setOp(['x'], 1)); // 1. acknowledged, no citations
      expect(a.env.ops[0].cites).toEqual([]);
      const rec = w.ledger.recs.find((r) => r.key === oPathKey(['x'])) as LRec;
      expect(w.relay.receipts.get('A')?.get('g0')?.versions.has(a.env.version)).toBe(true);
      sync(w);
      observe(w);
      expect(Object.fromEntries(w.violations)).toEqual({}); // 2. the last check before the cut passes
      const before = structuredClone(w.ledger);
      const g = cut(w, 'reaper', 'replay'); // 2. ... and inside the cut x is removed from u and c
      expect(w.n['dropAtCut']).toBe(1);
      expect(g.source.some((r) => pathKey(r.path) === pathKey(['x']))).toBe(false);
      expect(lHidden(before, g.source)).toEqual([]); // 3. the hidden check skips the absent sibling
      expect(oKept(g.source).has(oPathKey(['x']))).toBe(false); // 3. ... and D-a′ has no x
      expect(lMissing(before, g.source)).toEqual(['g0:A#1@["x"]: absent']); // what a source check sees
      expect(g.seed.some((r) => pathKey(r.path) === pathKey(['x']))).toBe(false); // the seed omits x
      expect(w.n['dropSeedOmits']).toBe(1);
      if (r7Ledger) {
        expect(rec.done).toBe('dropped'); // 3. the loss accepted as a structural discharge
        learn(w, R(w, 'A'));
        expect(lookup(R(w, 'A').u.materialize(), ['x']).found).toBe(false); // gone from its author too
        okWorld(w); // 4. every invoked check passes (the post-cut `lMissing` skips discharged records)
      } else {
        expect(rec.done).toBeUndefined();
        expect(w.violations.get('ledger')).toMatch(
          /^cut source g1 \(reaper\): 1 acked op\(s\) lost, g0:A#1@\["x"\]: absent$/,
        );
        expect(w.violations.get('ledger-discharge')).toMatch(
          /^g1 \(reaper\): not discharged as dropped: g0:A#1@\["x"\]: absent$/,
        );
        expect(lMissing(w.ledger, w.relay.c.checkpoint())).toEqual(['g0:A#1@["x"]: absent']); // still named
      }
    }
  });

  it('R16-6 × R16-1 (r7: premise moved — the early cite needs the adversarial channel): a supersession acked BEFORE the op it cites is lost at the cut when that op replays verbatim — an HONEST writer never cites the pending peer copy (R17-1), the uniform gate refuses it when one does (n42 ⇒ D6-fresh, a Conflict), and only both off together (n42 + n40) lose it ⇒ T3-resurrect', () => {
    for (const [citePeer, ungatedFresh] of [
      [false, false],
      [true, false],
      [true, true],
    ]) {
      const w = W({ citePeer, ungatedFresh }, owner);
      const ta = author(w, 'A', setOp(['x'], 1), { bump: true }) as TailEntry; // pending at A
      copyTo(w, ta, 'B');
      const tb = author(w, 'B', setOp(['x'], 2), {
        lower: atEpoch(0),
      }) as TailEntry;
      const cited = tb.env.ops[0].cites?.some((c) => c.origin === 'A') ?? false;
      expect(cited).toBe(citePeer); // R17-1: B folds A's peer copy (x=1 on screen) but cites only relay-known dots
      expect(toRelay(w, tb.env)).toBe(citePeer && !ungatedFresh ? 'unknown-citation' : 'admitted');
      cut(w, 'reaper', 'replay');
      learn(w, R(w, 'A'));
      replayAll(w, 'A');
      expect(flush(w, 'A')).toEqual(['admitted']);
      sync(w);
      observe(w);
      if (!citePeer) {
        // honest: B's write is concurrent with A's bump, never a supersession — A@epoch 1 wins by the fold
        expect(relayValue(w, ['x'])).toBe(1);
        expect(Object.fromEntries(w.violations)).toEqual({});
      } else if (!ungatedFresh) {
        expect(R(w, 'B').unresolved.map((c) => c.cause)).toEqual(['refused-cite']);
        expect(w.violations.get('D6-fresh')).toMatch(/g0:B#1 \(fresh\) refused at the relay/);
        expect(beyondPeer(w)).toEqual({});
      } else {
        expect(relayValue(w, ['x'])).toBe(1); // A@epoch 1 is live again and beats B's acked write
        expect(w.violations.get('T3-resurrect')).toMatch(/A@\d+\.0 live/);
      }
    }
  });

  it('the ledger follows acked ops across cuts and a relay crash: retained in the seed with full identity, discharged only by a cite, a same-origin replacement or a D-a′ drop; n32 corrupts a value ⇒ caught', () => {
    for (const corruptIngest of [false, true]) {
      const w = W({ corruptIngest });
      committed(w, 'A', setOp(['x'], 1));
      committed(w, 'A', setOp(['y'], 1));
      committed(w, 'A', setOp(['z'], 1)); // the victim under n32
      copyTo(w, committed(w, 'B', delOp(['k'])), 'A');
      committed(w, 'A', setOp(['k'], 'again')); // cites B's tombstone: superseded
      relayCheckpoint(w);
      cut(w, 'reaper', 'replay');
      relayCrash(w, () => 0.9);
      cut(w, 'reaper', 'replay');
      sync(w);
      observe(w);
      const open = w.ledger.recs.filter((r) => !r.done).map((r) => r.key);
      expect(open.sort()).toEqual(['["k"]', '["x"]', '["y"]', '["z"]']);
      if (!corruptIngest) expect(Object.fromEntries(w.violations)).toEqual({});
      else expect(w.violations.get('ledger')).toMatch(/A#3@\["z"\]: holds .*corrupt/);
    }
  });
});

describe('generation cut: pinned — client boundaries (D-d welcomes + crash points, reboots, D-b, D-c, D-e)', () => {
  it('D-d: a STALE welcome (an older generation) arriving after the newer one and after new-generation traffic is ignored; n21 installs it', () => {
    for (const acceptStale of [false, true]) {
      const w = W({ acceptStale });
      committed(w, 'A', setOp(['x'], 1));
      cut(w, 'reaper', 'replay'); // g1 welcome queued
      const g1 = R(w, 'B').inbox[0];
      cut(w, 'reaper', 'replay'); // g2 welcome queued
      R(w, 'B').inbox = [R(w, 'B').inbox[1]];
      deliverWelcome(w, R(w, 'B'), 0); // B installs g2
      committed(w, 'B', setOp(['y'], 2)); // new-generation traffic
      R(w, 'B').inbox.push(g1);
      deliverWelcome(w, R(w, 'B'), 0); // the stale g1 welcome
      sync(w);
      observe(w);
      if (!acceptStale) {
        expect(R(w, 'B').instance).toBe('g2');
        expect(w.n['welcomeStale']).toBe(1);
        expect(Object.fromEntries(w.violations)).toEqual({});
      } else {
        expect(R(w, 'B').instance).toBe('g1');
        expect(w.violations.get('crash')).toMatch(/B on g1 holds g2:B#1/);
      }
    }
  });

  it("D-d (astra's post-green bug): a crash during installation — ATOMIC ⇒ nothing half-installed; n18 ⇒ new registers + old outbox", () => {
    for (const nonAtomicInstall of [false, true]) {
      const w = W({ nonAtomicInstall });
      committed(w, 'A', setOp(['x'], 1));
      author(w, 'A', setOp(['x'], 2)); // pending
      cut(w, 'reaper', 'replay');
      const rep = R(w, 'A');
      sync(w); // the record as of the last step boundary
      deliverWelcome(w, rep, rep.inbox.length - 1, 2); // crash after registers + instance, before the outbox
      sync(w);
      observe(w);
      if (!nonAtomicInstall) {
        expect(rep.instance).toBe('g0'); // nothing of the installation survived; a fresh welcome is queued
        learn(w, rep);
        replayAll(w, rep.id);
        expect(flush(w, 'A')).toEqual(['admitted']);
        okWorld(w);
      } else {
        expect(rep.instance).toBe('g1');
        expect(w.violations.get('crash')).toMatch(
          /A on g1 holds g0:A#[12] in its outbox outside any rebase/,
        );
      }
    }
  });

  it('D-d: a crash after the replay dequeue — ATOMIC ⇒ the entry is still in the cursor; n19 ⇒ it vanishes (T3)', () => {
    for (const nonAtomicReplay of [false, true]) {
      const w = W({ nonAtomicReplay });
      committed(w, 'A', setOp(['x'], 1));
      author(w, 'A', setOp(['x'], 2));
      cut(w, 'reaper', 'replay');
      learn(w, R(w, 'A'));
      replayStep(w, R(w, 'A'), 1);
      // r9 (premise moved): the no-persist restart replays nothing until a welcome installs
      expect(R(w, 'A').installed).toBe(false);
      learn(w, R(w, 'A'));
      replayAll(w, 'A');
      flush(w, 'A');
      sync(w);
      finalClassification(w);
      if (!nonAtomicReplay) expect(outcome(w, 'A:2').admitted).toBe(1);
      else expect(w.violations.get('T3')).toMatch(/intent A:2 vanished/);
    }
  });

  it('reboot: a NEW origin resends the OLD origin persisted outbox; receipts are found by ENVELOPE origin', () => {
    const w = W();
    committed(w, 'A', setOp(['x'], 1)); // acked, ack lost
    author(w, 'A', setOp(['y'], 2)); // pending
    sync(w);
    reload(w, R(w, 'A'), true); // the restart resends the OLD origin's outbox (A#1 duplicate, A#2 admitted)
    expect(R(w, 'A').origin).toBe('A~1');
    expect(w.relay.admission.admitted.has('A#2')).toBe(true); // r6: resent at the restart (premise moved)
    author(w, 'A', setOp(['z'], 3)); // the new boot writes under its own origin
    cut(w, 'reaper', 'replay');
    learn(w, R(w, 'A'));
    replayAll(w, 'A');
    expect(
      R(w, 'A')
        .tail.map((t) => keyOfEnv(t.env))
        .sort(),
    ).toEqual(['A~1#1']); // A#1 and A#2 trimmed by the OLD origin's receipt
    expect(flush(w, 'A')).toEqual(['admitted']);
    expect(outcome(w, 'A:1').trimmed).toBe(1);
    expect(outcome(w, 'A:2')).toMatchObject({ admitted: 1, trimmed: 1 });
    okWorld(w);
  });

  it('D-b: local coverage resting on PEER-held evidence the relay has not admitted ⇒ the relay refuses ⇒ Conflict; n25 (ignored) ⇒ D6-drop', () => {
    for (const ignoreDrop of [false, true]) {
      const w = W({ ignoreDrop, citePeer: true }); // r7: A's original write cites B's PEER-held write (n42)
      const ty = author(w, 'B', setOp(['x'], 'y')) as TailEntry;
      copyTo(w, ty, 'A');
      author(w, 'A', setOp(['x'], 'a')); // cites B's pending write
      cut(w, 'reaper', 'replay');
      learn(w, R(w, 'B'));
      learn(w, R(w, 'A'));
      replayAll(w, 'B');
      expect(toReplica(w, lastTail(w, 'B').env, R(w, 'A'))).toBe('ok'); // B's replay reaches A by peer copy first
      replayAll(w, 'A'); // covered locally
      expect(R(w, 'A').unresolved).toEqual([]);
      expect(flush(w, 'A')).toEqual(['unknown-citation']); // the relay never saw B's replay
      sync(w);
      observe(w);
      if (!ignoreDrop) {
        expect(R(w, 'A').unresolved.map((x) => x.cause)).toEqual(['refused-cite']);
        expect(beyondPeer(w)).toEqual({}); // n42 channel: only the discipline breach itself (`stamp-discipline`)
        expect(w.violations.get('stamp-discipline')).toBeDefined();
      } else expect(w.violations.get('D6-drop')).toMatch(/A still holds refused/);
    }
  });

  it('D-b′ RULED (F-9): a refusal is DURABLE (journaled `refuse` rows) — a late duplicate of a refused envelope is refused again; n27 admits it after the Conflict', () => {
    for (const forgetRefusals of [false, true]) {
      const w = W({ forgetRefusals, citePeer: true }); // r7: as the D-b pin, through n42
      const ty = author(w, 'B', setOp(['x'], 'y')) as TailEntry;
      copyTo(w, ty, 'A');
      author(w, 'A', setOp(['x'], 'a'));
      cut(w, 'reaper', 'replay');
      learn(w, R(w, 'B'));
      learn(w, R(w, 'A'));
      replayAll(w, 'B');
      toReplica(w, lastTail(w, 'B').env, R(w, 'A'));
      replayAll(w, 'A');
      const refused = lastTail(w, 'A').env;
      expect(toRelay(w, refused)).toBe('unknown-citation');
      flush(w, 'B'); // now the relay holds the evidence
      const late = toRelay(w, refused); // a late network duplicate
      sync(w);
      observe(w);
      if (!forgetRefusals) {
        expect(late).toBe('unknown-citation');
        expect(beyondPeer(w)).toEqual({}); // n42 channel: only the discipline breach itself (`stamp-discipline`)
        expect(w.violations.get('stamp-discipline')).toBeDefined();
      } else {
        expect(late).toBe('admitted');
        expect(w.violations.get('T3')).toMatch(
          /admitted after it was classified|reached the tail policy/,
        );
      }
    }
  });

  it("D-b″ (astra's refusal crash): outbox persisted → the relay journals a refusal → the author crashes before persisting its Conflict → restart resends in the SAME generation ⇒ the refusal is replied again ⇒ Conflict + rehydrate; n30 (silent) ⇒ the refused edit stays pending and visible", () => {
    for (const silentRefusals of [false, true]) {
      // r7 (premise moved): C's carry of A's PEER-held bump is the adversarial channel (n42); an honest
      // C stamps from its relay-known view and is admitted (the last assertion below)
      const w = W({ silentRefusals, citePeer: true }, owner);
      const a1 = author(w, 'A', setOp(['x'], 1), { bump: true }) as TailEntry; // not yet at the relay
      copyTo(w, a1, 'C');
      const c1 = author(w, 'C', setOp(['x'], 'c')) as TailEntry; // carries A's epoch 1 (n42)
      sync(w); // 1. the author's outbox is persisted
      expect(toRelay(w, c1.env)).toBe('epoch-bump'); // 2. the relay journals the refusal (and replies)
      // 3. crash before the Conflict persisted; 4. the restart RESENDS its outbox with its hello (r6:
      // the resend moved from the welcome install into the restart — premise moved, same verdicts)
      reload(w, R(w, 'C'));
      expect(R(w, 'C').unresolved.length).toBe(silentRefusals ? 0 : 1);
      deliverWelcome(w, R(w, 'C'), R(w, 'C').inbox.length - 1); // the same-generation welcome
      while (R(w, 'C').inbox.length) deliverWelcome(w, R(w, 'C'), 0);
      sync(w);
      observe(w);
      const shown = lookup(R(w, 'C').u.materialize(), ['x']);
      if (!silentRefusals) {
        expect(R(w, 'C').unresolved.map((x) => x.cause)).toEqual(['refused-epoch']);
        expect(R(w, 'C').tail).toEqual([]);
        // the optimistic local effect is retracted; r9 (premise moved): the NO-PERSIST restart forgot
        // A's unsequenced peer copy (r6–r8.1 kept it visible, x = 1), the relay never admitted it ⇒ absent
        expect(shown).toEqual({ found: false, value: undefined });
        expect(outcome(w, c1.intent.id)).toMatchObject({
          admitted: 0,
          conflicts: 1,
        });
        expect(w.violations.get('D6-fresh')).toMatch(
          /g0:C#1 \(fresh\) refused at the relay \(epoch-bump\)/,
        );
        expect(beyondPeer(w)).toEqual({});
      } else {
        expect(R(w, 'C').tail.map((t) => t.intent.id)).toEqual([c1.intent.id]); // pending forever
        expect(shown).toEqual({ found: true, value: 'c' }); // and visible
        expect(w.violations.get('D6-drop')).toMatch(/C re-applied refused g0:C#1/);
      }
    }
    // R17-1 honest: the same schedule without n42 — C cites nothing it did not get from the relay
    const h = W({}, owner);
    const ha = author(h, 'A', setOp(['x'], 1), { bump: true }) as TailEntry;
    copyTo(h, ha, 'C');
    const hc = author(h, 'C', setOp(['x'], 'c')) as TailEntry;
    expect(hc.env.ops[0].epoch).toBe(0); // no carry of the peer-held bump
    expect(toRelay(h, hc.env)).toBe('admitted');
    okWorld(h);
  });

  it("R16-2 (astra audit #3 Q3): refusal, crash before the Conflict persists, resend (refusal replied again ⇒ Conflict + rehydrate requested at s), an unrelated relay-admitted write reaches C at s+1, every queued welcome is rejected as older — the OWED flag re-requests and the edit is retracted; n37 (no flag) ⇒ x='c' stays on screen forever", () => {
    for (const noOwed of [false, true]) {
      // r7 (premise moved): the refusal is reached through the adversarial channel (n42), as in D-b″
      // r9 (premise moved): the PERSISTING replica — the schedule needs C's screen to survive the
      // crash; a no-persist restart shows nothing until a welcome installs (N6 pin: the owed rider)
      const w = W({ noOwed, citePeer: true, persistRegisters: true }, owner);
      const a1 = author(w, 'A', setOp(['x'], 1), { bump: true }) as TailEntry; // not yet at the relay
      copyTo(w, a1, 'C');
      const c1 = author(w, 'C', setOp(['x'], 'c')) as TailEntry; // carries A's epoch 1 (n42)
      sync(w); // 1. C's optimistic x='c' is persisted
      expect(toRelay(w, c1.env)).toBe('epoch-bump'); // 2. the relay refuses ...
      reload(w, R(w, 'C')); // ... C crashes before the Conflict persists; 3. the restart resends ⇒ replied again
      expect(R(w, 'C').unresolved.map((x) => x.cause)).toEqual(['refused-epoch']);
      expect(R(w, 'C').rehydrateOwed).toBe(noOwed ? undefined : w.journal.length);
      const b = committed(w, 'B', setOp(['y'], 'b')); // 4. an unrelated write admitted at s+1 ...
      expect(toReplica(w, b.env, R(w, 'C'))).toBe('ok'); // ... reaches C first (relay-sequenced)
      while (R(w, 'C').inbox.length) deliverWelcome(w, R(w, 'C'), 0); // 5. every queued welcome
      sync(w);
      observe(w);
      owedCheck(w); // 6. the room is quiet
      const shown = lookup(R(w, 'C').u.materialize(), ['x']);
      if (!noOwed) {
        expect(w.n['welcomeOlderThanTraffic']).toBeGreaterThanOrEqual(2); // the race was lost ...
        expect(w.n['rehydrateRetries']).toBeGreaterThanOrEqual(1); // ... and re-requested
        expect(R(w, 'C').rehydrateOwed).toBeUndefined();
        expect(shown).toEqual({ found: true, value: 1 }); // retracted (A's peer-held bump remains)
        expect(w.violations.get('D6-fresh')).toMatch(/g0:C#1 \(fresh\) refused/);
        expect(beyondPeer(w)).toEqual({});
      } else {
        expect(R(w, 'C').unresolved.length).toBe(1); // a durable Conflict ...
        expect(R(w, 'C').tail).toEqual([]); // ... an empty outbox ...
        expect(shown).toEqual({ found: true, value: 'c' }); // ... and the refused edit still on screen
        expect(w.violations.get('D6-live')).toMatch(
          /C still owes the rehydration of refused g0:C#1/,
        );
      }
    }
  });

  it("N6 (charter §24, r9): an install BELOW the owed seq must not clear `rehydrateOwed` — the owed value survives the install and the next snapshot request follows; the N6 neuter (`owedAfterInstall` clears at any seq) loses the flag there, and once the rehydrate welcome is rejected as older than traffic the refused edit's rehydration is never completed (D6-live)", () => {
    for (const owedClears of [false, true]) {
      // the refusal needs the adversarial channel (n42), as in the R16-2 pin
      const w = W({ owedClears, citePeer: true }, owner);
      const C = R(w, 'C');
      postWelcome(w, C); // 1. a snapshot C asked for earlier: seq s0
      const s0 = C.inbox[0].seq;
      const a1 = author(w, 'A', setOp(['x'], 1), { bump: true }) as TailEntry; // not yet at the relay
      copyTo(w, a1, 'C');
      const c1 = author(w, 'C', setOp(['x'], 'c')) as TailEntry; // carries A's epoch 1 (n42)
      expect(toRelay(w, c1.env)).toBe('epoch-bump'); // 2. refused: Conflict, owed = q, rehydrate asked
      const q = w.journal.length;
      expect(C.rehydrateOwed).toBe(q);
      expect(q).toBeGreaterThan(s0);
      expect(C.inbox.map((x) => x.seq)).toEqual([s0, q]);
      deliverWelcome(w, C, 0); // 3. the OLDER snapshot (s0 < q) installs: not stale, not older than traffic
      expect(w.n['installSame']).toBe(1);
      if (!owedClears) {
        expect(C.rehydrateOwed).toBe(q); // the owed value survives the install ...
        expect(w.n['owedReasked']).toBe(1); // ... and the next snapshot request follows
        expect(C.inbox.map((x) => x.seq)).toEqual([q, q]);
      } else expect(C.rehydrateOwed).toBeUndefined(); // N6: lost at a seq below the refusal
      const b = committed(w, 'B', setOp(['y'], 'b')); // 4. newer relay traffic reaches C first
      expect(toReplica(w, b.env, C)).toBe('ok');
      while (C.inbox.length) deliverWelcome(w, C, 0); // 5. every queued welcome
      sync(w);
      observe(w);
      owedCheck(w); // 6. the room is quiet
      if (!owedClears) {
        expect(w.n['welcomeOlderThanTraffic']).toBeGreaterThanOrEqual(2); // q, q rejected ...
        expect(w.n['rehydrateRetries']).toBeGreaterThanOrEqual(1); // ... and asked again
        expect(C.rehydrateOwed).toBeUndefined(); // completed by an install at or past q
        expect(beyondPeer(w)).toEqual({});
      } else {
        expect(w.n['rehydrateRetries'] ?? 0).toBe(0); // nothing owed, nothing asked
        expect(w.violations.get('D6-live')).toMatch(
          /C still owes the rehydration of refused g0:C#1/,
        );
      }
    }
  });

  it("R26-1 (charter §26; r9's FINDING `T3-recrash`, re-stated r9.1 — both replica variants): a replay reaches the wire, the client crashes before its record holds the replayed entry, the relay admits it under the REPLAY's generation, a second cut follows — the record's ORIGINAL entry is trimmed at the g2 install (receipt (B, g1, {1}) holds version 1: membership across instances), nothing replays, the write is admitted ONCE and a superseding write stays superseding; n45 (the per-instance trim) keeps it, replays it and it is admitted twice — and, superseded, B's dot returns LIVE", () => {
    for (const trimPerInstance of [false, true])
      for (const persistRegisters of [false, true])
        for (const supersede of [false, true]) {
          const w = W({ persistRegisters, trimPerInstance });
          const B = R(w, 'B');
          author(w, 'B', setOp(['a'], 'b1')); // 1. B's pending write g0:B#1
          sync(w);
          cut(w, 'reaper', 'replay'); // 2. a cut; B installs g1, its cursor holds g0:B#1
          learn(w, B);
          sync(w);
          expect(B.rebase?.remaining.map((t) => gkey(t.env))).toEqual(['g0:B#1']);
          replayStep(w, B, 2); // 3. the replay g1:B#1 is ON THE WIRE; B crashes before its record holds it
          expect(B.rebase?.remaining.map((t) => gkey(t.env))).toEqual(['g0:B#1']);
          const wire = (w.authored.get('B') as OpEnvelope[]).at(-1) as OpEnvelope;
          expect(gkey(wire)).toBe('g1:B#1');
          expect(toRelay(w, wire)).toBe('admitted'); // 4. admitted, receipt (B, g1, {1})
          expect(receiptsCanon(w.relay.receipts)).toMatch(/B.*g1.*1/);
          expect(w.relay.receipts.get('B')?.get('g0')?.versions.has(1) ?? false).toBe(false);
          if (supersede) {
            learn(w, R(w, 'C')); // C's welcome holds g1:B#1 (relay-known)
            const c = committed(w, 'C', setOp(['a'], 'c')); // C supersedes it (cites B's dot)
            expect(c.env.ops[0].cites?.map((x) => x.origin)).toEqual(['B']);
          }
          cut(w, 'reaper', 'replay'); // 5. a second cut (g2); B's sibling dropped if superseded
          const trimmed0 = w.n['trimmed'] ?? 0;
          learn(w, B); // 6. B installs g2 and trims its tail by the receipts
          replayAll(w, 'B');
          const answers = flush(w, 'B');
          sync(w);
          observe(w);
          if (!trimPerInstance) {
            // R26-1: version 1 is held by (B, g1) ⇒ the original g0 entry is trimmed, never resent
            expect((w.n['trimmed'] ?? 0) - trimmed0).toBe(1);
            expect(B.rebase).toBeUndefined();
            expect(answers).toEqual([]);
            expect(outcomeOf(w, 'B:1').admitted).toBe(1);
            expect(w.n['recrashKept'] ?? 0).toBe(0);
            if (supersede) {
              // the acked supersession holds: B's dot is NOT live in g2, the value is C's
              expect(w.relay.c.siblings(['a']).map((x) => x.origin)).not.toContain('B');
              expect(lSuppress(w.ledger.oldMarks, w.relay.c.checkpoint())).toHaveLength(0);
              expect(relayValue(w, ['a'], 'custom')).toBe('c');
            } else expect(relayValue(w, ['a'], 'custom')).toBe('b1');
            expect(Object.fromEntries(w.violations)).toEqual({}); // every class silent
            continue;
          }
          // n45: the per-instance trim looks up (B, g0, 1), finds nothing, replays g2:B#1 verbatim
          expect(answers).toEqual(['admitted']);
          expect(outcomeOf(w, 'B:1').admitted).toBe(2);
          expect(w.n['recrashKept']).toBe(1);
          expect(w.violations.get('T3-recrash')).toMatch(
            /B installs g2 and keeps g0:B#1 \(B:1\) though the intent was admitted/,
          );
          expect(w.violations.get('T3-double')).toMatch(
            /intent B:1 admitted twice \(latest g2:B#1\)/,
          );
          if (supersede) {
            // the acked supersession is undone: B's dot is live again beside C's in g2
            expect(
              w.relay.c
                .siblings(['a'])
                .map((x) => x.origin)
                .sort(),
            ).toEqual(['B', 'C']);
            expect(lSuppress(w.ledger.oldMarks, w.relay.c.checkpoint())).toHaveLength(1);
            expect(w.violations.get('T3-resurrect')).toMatch(/B@/);
            expect(relayValue(w, ['a'], 'custom')).toBe('b1'); // a selecting fold shows the resurrected value
          }
          const v = Object.fromEntries(w.violations);
          for (const c of ['T3-recrash', 'T3-double', 'T3-resurrect']) delete v[c];
          expect(v).toEqual({}); // every other class silent: the finding is this one path
        }
  });

  it('§14 T3-apply counts application INVOCATIONS: a duplicate delivery of the same envelope is deduplicated; n35 applies it twice (one envelope identity — the r4.1 Set could not see it)', () => {
    for (const noReplicaDedup of [false, true]) {
      const w = W({ noReplicaDedup });
      const a = committed(w, 'A', setOp(['x'], 1));
      expect(toReplica(w, a.env, R(w, 'B'))).toBe('ok');
      toReplica(w, a.env, R(w, 'B')); // a network duplicate
      sync(w);
      observe(w);
      if (!noReplicaDedup) expect(Object.fromEntries(w.violations)).toEqual({});
      else
        expect(w.violations.get('T3-apply')).toMatch(
          /B applied intent A:1 2 times in one fold lifetime/,
        );
    }
  });

  it('§14 same-generation order: an OLDER snapshot of the installed generation arriving after later traffic is ignored; n34 installs it and loses the ingested envelope', () => {
    for (const acceptOlderSnapshot of [false, true]) {
      const w = W({ acceptOlderSnapshot });
      postWelcome(w, R(w, 'B')); // a snapshot at seq s0, still in transit
      const a = committed(w, 'A', setOp(['x'], 1)); // admitted at a later seq
      copyTo(w, a, 'B'); // B ingests it (the delivery carries its seq)
      deliverWelcome(w, R(w, 'B'), 0); // the older snapshot arrives
      sync(w);
      observe(w);
      if (!acceptOlderSnapshot) {
        expect(w.n['welcomeOlderThanTraffic']).toBe(1);
        expect(lookup(R(w, 'B').u.materialize(), ['x'])).toEqual({ found: true, value: 1 });
        expect(Object.fromEntries(w.violations)).toEqual({});
      } else {
        expect(lookup(R(w, 'B').u.materialize(), ['x']).found).toBe(false); // replaced by older state
        expect(w.violations.get('welcome-order')).toMatch(/B installed g0@0 and lost ingested A#1/);
      }
    }
  });

  it("R16-3 (astra audit #3 Q4): B's snapshot queued at s0; A's write reaches B by PEER copy first; the relay admits it at s1 and its echo to B is DEDUPLICATED — seq knowledge still advances, so the older snapshot is ignored; n38 (dedup before seq) installs it and erases the write", () => {
    for (const dedupBeforeSeq of [false, true]) {
      const w = W({ dedupBeforeSeq });
      postWelcome(w, R(w, 'B')); // 1. B's snapshot at s0, in transit
      const a = author(w, 'A', setOp(['x'], 1)) as TailEntry;
      expect(toReplica(w, a.env, R(w, 'B'))).toBe('ok'); // 2. peer copy: no relay seq yet
      expect(R(w, 'B').peerHeld.size).toBe(1);
      expect(toRelay(w, a.env)).toBe('admitted'); // 3. the relay admits it at s1
      expect(toReplica(w, a.env, R(w, 'B'))).toBe('dup'); // 4. the relay echo, deduplicated
      deliverWelcome(w, R(w, 'B'), 0); // 5. the older snapshot
      sync(w);
      observe(w);
      if (!dedupBeforeSeq) {
        expect(R(w, 'B').maxSeq).toBe(w.seqOf.get(gkey(a.env)));
        expect(R(w, 'B').peerHeld.size).toBe(0); // dropped on its echo
        expect(w.n['welcomeOlderThanTraffic']).toBe(1);
        expect(lookup(R(w, 'B').u.materialize(), ['x'])).toEqual({ found: true, value: 1 });
        expect(Object.fromEntries(w.violations)).toEqual({});
      } else {
        expect(R(w, 'B').peerHeld.size).toBe(0); // the echo dropped it (as ruled) but taught no seq
        expect(lookup(R(w, 'B').u.materialize(), ['x']).found).toBe(false); // erased by the older snapshot
        expect(w.violations.get('welcome-order')).toMatch(/B installed g0@0 and lost ingested A#1/);
      }
    }
  });

  it('R16-3: a peer copy NOT yet echoed survives a same-generation snapshot install (retained, re-ingested); n38b erases it until the echo', () => {
    for (const noPeerRetain of [false, true]) {
      const w = W({ noPeerRetain });
      const a = author(w, 'A', setOp(['x'], 1)) as TailEntry;
      expect(toReplica(w, a.env, R(w, 'B'))).toBe('ok'); // peer copy; the relay has not admitted it
      postWelcome(w, R(w, 'B')); // a same-generation snapshot without it
      deliverWelcome(w, R(w, 'B'), 0);
      sync(w);
      observe(w);
      if (!noPeerRetain) {
        expect(lookup(R(w, 'B').u.materialize(), ['x'])).toEqual({ found: true, value: 1 });
        expect(toRelay(w, a.env)).toBe('admitted');
        expect(toReplica(w, a.env, R(w, 'B'))).toBe('dup'); // the echo drops it from the held set
        expect(R(w, 'B').peerHeld.size).toBe(0);
        okWorld(w);
      } else {
        expect(lookup(R(w, 'B').u.materialize(), ['x']).found).toBe(false);
        expect(w.violations.get('peer-retain')).toMatch(
          /B installed g0@\d+ and lost peer copy g0:A#1/,
        );
      }
    }
  });

  it('D-d: installation re-applies only own writes the welcome has NOT admitted; n26 re-applies an admitted one over a collected welcome (C5 at install)', () => {
    for (const reapplyAdmitted of [false, true]) {
      const w = W({ reapplyAdmitted, cfg: 'preserve' }); // preserve shows a resurrected sibling as a conflict value
      const c = committed(w, 'C', setOp(['x'], 'y')); // admitted; stays in C's outbox (no ack)
      copyTo(w, c, 'A');
      committed(w, 'A', setOp(['x'], 'q')); // supersedes it
      w.relay.c.settle(w.relay.admission.settled); // collected at the relay
      postWelcome(w, R(w, 'C')); // a same-generation welcome
      deliverWelcome(w, R(w, 'C'), R(w, 'C').inbox.length - 1);
      sync(w);
      observe(w);
      if (!reapplyAdmitted) expect(Object.fromEntries(w.violations)).toEqual({});
      else expect(w.violations.get('converge')).toMatch(/C on g0 materializes/);
    }
  });

  it('n22: a reload must restore client floors — without them the collected twin forgets an epoch its uncollected twin keeps', () => {
    // r9 (premise moved): the persisting replica; a no-persist restart rebuilds BOTH twins empty
    for (const noFloorRestore of [false, true]) {
      const w = W({ noFloorRestore, persistRegisters: true }, owner);
      const a = committed(w, 'A', setOp(['a'], 1), { bump: true });
      copyTo(w, a, 'B');
      const b = committed(w, 'B', setOp(['a'], 2), { lower: atEpoch(0) }); // non-carrying supersession
      copyTo(w, b, 'A');
      R(w, 'A').c.settle(R(w, 'A').admission.settled); // A's own sibling collected on the C twin
      sync(w);
      reload(w, R(w, 'A'));
      sync(w);
      observe(w);
      if (!noFloorRestore) expect(Object.fromEntries(w.violations)).toEqual({});
      else expect(w.violations.get('compaction')).toMatch(/A stamps differ/);
    }
  });

  it('D-c: a ready state — a write after pressing un-readies until flushed; a leave can complete the census; a join adds a not-ready member; zero conflicts for ready members', () => {
    const w = W();
    const a = committed(w, 'A', setOp(['x'], 1));
    copyTo(w, a, 'B', 'C');
    setConnected(w, 'C', false); // C is outside the census, holding a write citing A's dot
    author(w, 'C', setOp(['x'], 'c'));
    for (const id of ['A', 'B']) press(w, id);
    expect(w.declared.get('A')).toEqual({ ready: true, instance: 'g0' }); // A's own commit was answered
    author(w, 'B', setOp(['y'], 2)); // a write after pressing: B re-declares NOT ready at once
    expect(w.declared.get('B')?.ready).toBe(false);
    expect(consensusCheck(w)).toBeNull();
    flush(w, 'B'); // the relay's answer empties the outbox: B re-declares ready without re-pressing
    expect(w.declared.get('B')?.ready).toBe(true);
    setConnected(w, 'C', true); // a join: declared not ready
    expect(consensusCheck(w)).toBeNull();
    setConnected(w, 'C', false); // a leave: the rest is unanimous
    const g = consensusCheck(w) as Gen;
    expect(g.reason).toBe('consensus');
    expect([...(g.census as Set<string>)].sort()).toEqual(['A', 'B']);
    learn(w, R(w, 'A'));
    learn(w, R(w, 'B'));
    expect(w.n['conflicts'] ?? 0).toBe(0);
    expect(R(w, 'A').pressed || R(w, 'B').pressed).toBe(false); // a new generation starts with nobody pressed
    expect([...w.declared.values()].some((d) => d.ready)).toBe(false); // nobody declared ready
    okWorld(w);
  });

  it('R16-5: the census reads ONLY declarations — an honest member that wrote after pressing is not counted ready although the relay never saw its write; n39 (a dishonest ready with a tail) cuts anyway, its tail replays under D5′ and the conflict is COUNTED, everything else intact', () => {
    for (const dishonestReady of [false, true]) {
      const w = W({ dishonestReady });
      copyTo(w, committed(w, 'A', setOp(['x'], 1)), 'B', 'C');
      copyTo(w, committed(w, 'B', setOp(['x'], 2)), 'C'); // supersedes A's dot at the relay
      for (const id of ['A', 'B', 'C']) press(w, id);
      learn(w, R(w, 'C'));
      const tc = author(w, 'C', [setOp(['k'], 'c'), setOp(['y'], 'c')]) as TailEntry; // after pressing; never delivered
      const g = consensusCheck(w);
      if (!dishonestReady) {
        expect(g).toBeNull(); // C's declaration went false with its write
        okWorld(w);
        continue;
      }
      expect(g?.reason).toBe('consensus'); // the relay trusted the flag
      learn(w, R(w, 'C'));
      replayAll(w, 'C');
      expect(w.leaked.has(tc.intent.id)).toBe(true);
      expect(w.violations.get('consensus')).toMatch(/C was ready at g1 yet replays C:1/);
      w.violations.delete('consensus'); // n39: counted, not hidden — the rest of the world is intact
      expect(flush(w, 'C')).toEqual(['admitted']); // its pending write simply replays (covered: no cites)
      okWorld(w);
    }
  });

  it('D-c: a budget cut during a census resets every press; the next census needs fresh presses', () => {
    const w = W();
    for (const id of ['A', 'B']) press(w, id);
    setConnected(w, 'C', true);
    committed(w, 'A', delOp(['k']));
    enforceBudget(w, 0); // a droppable tombstone over budget 0: a reaper cut, not a consensus
    expect(w.gens[w.gens.length - 1].reason).toBe('reaper');
    expect([...w.replicas.values()].some((r) => r.pressed)).toBe(false);
    expect([...w.declared.values()].some((d) => d.ready)).toBe(false);
    okWorld(w);
  });

  it('D-e: a multi-op envelope (a set with its expansion clears, plus another path) replays as ONE unit; a conflict takes it whole; re-author re-stamps the whole raw list', () => {
    const w = W();
    committed(w, 'B', setOp(['b', 'c'], 1));
    copyTo(w, committed(w, 'C', delOp(['k'])), 'A');
    const t = author(w, 'A', [setOp(['b'], { c: 9 }), setOp(['k'], 'again')]) as TailEntry; // k cites C's (droppable) tombstone
    expect(t.env.ops.map((op) => [op.kind, op.path.join('.')])).toEqual([
      ['set', 'b'],
      ['set', 'k'],
    ]);
    cut(w, 'reaper', 'replay');
    learn(w, R(w, 'A'));
    replayAll(w, 'A');
    expect(R(w, 'A').unresolved.map((c) => c.entry.intent.id)).toEqual([t.intent.id]); // the whole envelope
    expect(relayValue(w, ['b'])).toEqual({ c: 1 }); // neither op landed
    resolve(w, R(w, 'A'), true);
    const again = lastTail(w, 'A');
    expect(again.env.ops.map((op) => op.path.join('.')).sort()).toEqual(['b', 'b.c', 'k']); // re-stamped: b's expansion clear of b.c
    expect(toRelay(w, again.env)).toBe('admitted');
    okWorld(w);
  });
});
