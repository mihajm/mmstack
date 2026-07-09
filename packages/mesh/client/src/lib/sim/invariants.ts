import {
  createRegisterStore,
  type RegisterCheckpoint,
  type SeqEnvelope,
} from '@mmstack/mesh-protocol';
import {
  createConvergingApply,
  type MergePolicyEntry,
  type OpEnvelope,
} from '@mmstack/primitives';

/** A checked invariant: `ok`, plus a human-readable reason when it fails. */
export type Verdict = { readonly ok: boolean; readonly message: string };

const ok: Verdict = { ok: true, message: '' };

export function deepEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) {
    return false;
  }
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const ka = Object.keys(a as object);
  const kb = Object.keys(b as object);
  if (ka.length !== kb.length) return false;
  for (const k of ka) {
    if (!Object.hasOwn(b as object, k)) return false;
    if (!deepEqual((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k])) {
      return false;
    }
  }
  return true;
}

/**
 * Invariant 1: every honest peer converges to the same root. Order-independence of the
 * converging apply is what makes this hold across any delivery schedule.
 */
export function converged(roots: readonly unknown[]): Verdict {
  if (roots.length < 2) return ok;
  const [first, ...rest] = roots;
  for (let i = 0; i < rest.length; i++) {
    if (!deepEqual(first, rest[i])) {
      return {
        ok: false,
        message: `peer 0 and peer ${i + 1} diverged:\n  0: ${JSON.stringify(first)}\n  ${i + 1}: ${JSON.stringify(rest[i])}`,
      };
    }
  }
  return ok;
}

/**
 * Invariant 2a (client half of the audit): folding the journal from the base register
 * checkpoint through a CLIENT-side register + fold reproduces every peer's materialized
 * root. The relay has no root of its own — the journal plus the register semantics are the
 * replayable record, and materialization is a pure function of the delivered op set.
 */
export function journalFoldMatchesClients(
  base: readonly RegisterCheckpoint[] | undefined,
  journal: readonly SeqEnvelope[],
  roots: readonly unknown[],
  policies?: readonly MergePolicyEntry[],
): Verdict {
  const conv = createConvergingApply({ policies });
  if (base) conv.load(base);
  for (const env of [...journal].sort((a, b) => a.seq - b.seq)) {
    conv.ingest(env as OpEnvelope);
  }
  const folded = conv.materialize();
  for (let i = 0; i < roots.length; i++) {
    if (!deepEqual(folded, roots[i])) {
      return {
        ok: false,
        message: `journal fold ≠ peer ${i} root:\n  fold: ${JSON.stringify(folded)}\n  peer: ${JSON.stringify(roots[i])}`,
      };
    }
  }
  return ok;
}

const canonRegisters = (regs: readonly RegisterCheckpoint[]) =>
  regs
    .filter((r) => r.siblings.length || Object.keys(r.water).length)
    .map((r) => ({
      path: r.path.map(String),
      siblings: [...r.siblings].sort((a, b) => (a.origin < b.origin ? -1 : 1)),
      water: Object.fromEntries(Object.entries(r.water).sort()),
    }))
    .sort((a, b) => (a.path.join('') < b.path.join('') ? -1 : 1));

/**
 * Invariant 2b (relay half of the audit): the relay's RETAINED register state equals
 * re-ingesting the same journal through the structural twin of the register rules. The relay
 * retains; it never folds — so its whole state must be reproducible from the record alone.
 * (Assumes the journal window was not compacted during the run.)
 */
export function relayRetainsJournal(
  base: readonly RegisterCheckpoint[] | undefined,
  journal: readonly SeqEnvelope[],
  relayRegisters: readonly RegisterCheckpoint[],
): Verdict {
  const twin = createRegisterStore();
  if (base) twin.load(base);
  for (const env of [...journal].sort((a, b) => a.seq - b.seq)) {
    twin.ingest(env);
  }
  const replayed = canonRegisters(twin.checkpoint());
  const retained = canonRegisters(relayRegisters);
  return deepEqual(replayed, retained)
    ? ok
    : {
        ok: false,
        message: `relay register state ≠ journal re-ingest:\n  replayed: ${JSON.stringify(replayed)}\n  retained: ${JSON.stringify(retained)}`,
      };
}

/**
 * `onCommit` fires in seq order: the journal, in ARRIVAL order (as `onCommit` pushed it, NOT
 * re-sorted), is already strictly ascending in seq. Holds since the local-pending-as-branch refactor
 * — `receive` no longer re-entrantly flushes a peer's pending writes back through the relay mid-
 * broadcast, so commits no longer nest and unwind out of order. This is what lets a persistence
 * adapter append on `onCommit` and trust arrival order == seq order (the {@link seqDense} /
 * {@link journalFoldMatchesClients} defensive sorts become belt-and-suspenders for honest
 * single-relay runs).
 */
export function commitOrdered(journal: readonly SeqEnvelope[]): Verdict {
  for (let i = 1; i < journal.length; i++) {
    if (journal[i].seq <= journal[i - 1].seq) {
      return {
        ok: false,
        message: `onCommit not seq-ordered at index ${i}: seq ${journal[i - 1].seq} then ${journal[i].seq}`,
      };
    }
  }
  return ok;
}

/**
 * Seq density: the committed seqs form a dense, unique `{1..N}` matching the room seq — no gaps,
 * no double-sequencing. Checks the SET, not arrival order (that is {@link commitOrdered}'s job).
 */
export function seqDense(journal: readonly SeqEnvelope[], seq: number): Verdict {
  const seqs = journal.map((e) => e.seq);
  if (journal.length !== seq) {
    return { ok: false, message: `journal length ${journal.length} ≠ room seq ${seq}; seqs=[${seqs}]` };
  }
  const sorted = [...seqs].sort((a, b) => a - b);
  for (let i = 0; i < sorted.length; i++) {
    if (sorted[i] !== i + 1) {
      return { ok: false, message: `seqs not dense {1..${seq}}: sorted=[${sorted}]` };
    }
  }
  return ok;
}

/**
 * Invariant 4: watermarks monotone per (instance, origin). Within one instance's seq space, each
 * origin's envelope `version`s appear strictly increasing in seq order — the room never accepts a
 * regressed or duplicated version from a writer (what `opSync`'s version dedup enforces per peer,
 * asserted here at the room level).
 */
export function versionsMonotone(journal: readonly SeqEnvelope[]): Verdict {
  const sorted = [...journal].sort((a, b) => a.seq - b.seq);
  const last = new Map<string, number>();
  for (const env of sorted) {
    const prev = last.get(env.origin);
    if (prev !== undefined && env.version <= prev) {
      return {
        ok: false,
        message: `origin ${env.origin} version regressed at seq ${env.seq}: ${prev} → ${env.version}`,
      };
    }
    last.set(env.origin, env.version);
  }
  return ok;
}
