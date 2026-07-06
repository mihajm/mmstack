import { applyWireOps, type SeqEnvelope } from '@mmstack/mesh-protocol';

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
 * Invariant 2: folding the journal (by seq) from `base` equals the relay's incrementally-folded
 * root. Audit determinism — the journal is a faithful, replayable record. `base` is `undefined`
 * for a fresh room, or the hydrated checkpoint root after a relay restart.
 */
export function journalFoldsFrom(
  base: unknown,
  journal: readonly SeqEnvelope[],
  relayRoot: unknown,
): Verdict {
  let root = base;
  for (const env of [...journal].sort((a, b) => a.seq - b.seq)) {
    root = applyWireOps(root, env.ops);
  }
  return deepEqual(root, relayRoot)
    ? ok
    : {
        ok: false,
        message: `journal fold ≠ relay root:\n  fold:  ${JSON.stringify(root)}\n  relay: ${JSON.stringify(relayRoot)}`,
      };
}

export function journalFolds(journal: readonly SeqEnvelope[], relayRoot: unknown): Verdict {
  return journalFoldsFrom(undefined, journal, relayRoot);
}

/**
 * `onCommit` fires in seq order: the journal, in ARRIVAL order (as `onCommit` pushed it, NOT
 * re-sorted), is already strictly ascending in seq. Holds since the local-pending-as-branch refactor
 * — `receive` no longer re-entrantly flushes a peer's pending writes back through the relay mid-
 * broadcast, so commits no longer nest and unwind out of order. This is what lets a persistence
 * adapter append on `onCommit` and trust arrival order == seq order (the {@link seqDense} /
 * {@link journalFoldsFrom} defensive sorts become belt-and-suspenders for honest single-relay runs).
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
 * Invariant 4: watermarks monotone per (epoch, origin). Within one epoch's seq space, each origin's
 * envelope `version`s appear strictly increasing in seq order — the room never accepts a regressed
 * or duplicated version from a writer (what `opSync`'s version dedup enforces per peer, asserted
 * here at the room level).
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
