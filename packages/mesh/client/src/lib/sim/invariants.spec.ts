import { createRegisterStore, MESH_PROTO_VERSION, type SeqEnvelope, type SyncOp } from '@mmstack/mesh-protocol';
import { commitOrdered, converged, deepEqual, journalFoldMatchesClients, relayRetainsJournal, seqDense } from './invariants';

const env = (seq: number, ops: SyncOp[]): SeqEnvelope => ({
  proto: MESH_PROTO_VERSION,
  origin: `o${seq}`,
  writer: `w${seq}`,
  version: 1,
  hlc: { p: seq, l: 0 },
  policyVersion: 0,
  ops,
  seq,
});
// uncited fixture ops are CONCURRENT writes; the default fold picks the max-stamp winner
const set = (path: (string | number)[], next: unknown): SyncOp => ({ kind: 'set', path, next, cites: [], epoch: 0 });

describe('deepEqual', () => {
  it('holds for equal primitives and nested structures', () => {
    expect(deepEqual(1, 1)).toBe(true);
    expect(deepEqual('a', 'a')).toBe(true);
    expect(deepEqual(null, null)).toBe(true);
    expect(deepEqual({ a: { b: [1, 2] } }, { a: { b: [1, 2] } })).toBe(true);
  });

  it('rejects value diffs, shape diffs, and missing/extra keys', () => {
    expect(deepEqual(1, 2)).toBe(false);
    expect(deepEqual(null, {})).toBe(false);
    expect(deepEqual([1, 2], [1, 2, 3])).toBe(false);
    expect(deepEqual([1, 2], { 0: 1, 1: 2 })).toBe(false); // array vs object
    expect(deepEqual({ a: 1 }, { a: 1, b: 2 })).toBe(false); // extra key
    expect(deepEqual({ a: 1, b: 2 }, { a: 1 })).toBe(false); // missing key
    expect(deepEqual({ a: { b: 1 } }, { a: { b: 2 } })).toBe(false); // nested diff
  });
});

describe('converged (invariant 1) — must reject divergence, not just pass', () => {
  it('ok for 0, 1, or identical roots', () => {
    expect(converged([]).ok).toBe(true);
    expect(converged([{ a: 1 }]).ok).toBe(true);
    expect(converged([{ a: 1 }, { a: 1 }, { a: 1 }]).ok).toBe(true);
  });

  it('fails when any peer diverges, and names the offender', () => {
    const v = converged([{ a: 1 }, { a: 1 }, { a: 2 }]);
    expect(v.ok).toBe(false);
    expect(v.message).toContain('peer 2');
  });

  it('a subtle nested divergence is still caught', () => {
    expect(converged([{ n: { x: 1 } }, { n: { x: 1 } }, { n: { x: 9 } }]).ok).toBe(false);
  });
});

describe('journalFoldMatchesClients (invariant 2a) — must reject a wrong client root', () => {
  it('ok when the client-side register fold of the journal matches every root', () => {
    const journal = [env(1, [set([], {})]), env(2, [set(['a'], 1)]), env(3, [set(['b'], 2)])];
    const v = journalFoldMatchesClients(undefined, journal, [{ a: 1, b: 2 }, { a: 1, b: 2 }]);
    expect(v.ok, v.message).toBe(true);
  });

  it('is order-independent: a scrambled journal folds to the same state', () => {
    const journal = [env(3, [set(['a'], 3)]), env(1, [set([], {})]), env(2, [set(['a'], 1)])];
    // the register resolves the concurrent a-writes by stamp, regardless of arrival order
    const v = journalFoldMatchesClients(undefined, journal, [{ a: 3 }]);
    expect(v.ok, v.message).toBe(true);
  });

  it('fails when a claimed client root is wrong, and names the peer', () => {
    const journal = [env(1, [set([], {})]), env(2, [set(['a'], 1)])];
    const v = journalFoldMatchesClients(undefined, journal, [{ a: 1 }, { a: 999 }]);
    expect(v.ok).toBe(false);
    expect(v.message).toContain('peer 1');
  });
});

describe('relayRetainsJournal (invariant 2b) — must reject tampered register state', () => {
  it('ok when the relay retained exactly the twin re-ingest of the journal', () => {
    const journal = [env(1, [set([], {})]), env(2, [set(['a'], 1)])];
    const twin = createRegisterStore();
    for (const e of journal) twin.ingest(e);
    const v = relayRetainsJournal(undefined, journal, twin.checkpoint());
    expect(v.ok, v.message).toBe(true);
  });

  it('fails when the relay state lost or altered a register', () => {
    const journal = [env(1, [set([], {})]), env(2, [set(['a'], 1)])];
    const twin = createRegisterStore();
    twin.ingest(journal[0]); // "forgot" the second envelope
    const v = relayRetainsJournal(undefined, journal, twin.checkpoint());
    expect(v.ok).toBe(false);
    expect(v.message).toContain('register state');
  });
});

describe('commitOrdered — must reject an out-of-seq arrival order', () => {
  it('ok for a strictly ascending journal (and trivially for 0/1 entries)', () => {
    expect(commitOrdered([]).ok).toBe(true);
    expect(commitOrdered([env(1, [])]).ok).toBe(true);
    expect(commitOrdered([env(1, []), env(2, []), env(3, [])]).ok).toBe(true);
  });

  it('fails on a reversed/scrambled arrival order (the old re-entrant-flush signature)', () => {
    const v = commitOrdered([env(1, []), env(3, []), env(2, [])]);
    expect(v.ok).toBe(false);
    expect(v.message).toContain('not seq-ordered');
  });

  it('fails on a duplicate/non-increasing seq', () => {
    expect(commitOrdered([env(1, []), env(2, []), env(2, [])]).ok).toBe(false);
  });
});

describe('seqDense (invariant 4) — must reject gaps and duplicates', () => {
  it('ok for a dense set in any order', () => {
    expect(seqDense([env(1, []), env(2, []), env(3, [])], 3).ok).toBe(true);
    expect(seqDense([env(3, []), env(1, []), env(2, [])], 3).ok).toBe(true); // unordered
  });

  it('fails on a gap', () => {
    expect(seqDense([env(1, []), env(2, []), env(4, [])], 4).ok).toBe(false); // 3 missing (len≠seq)
  });

  it('fails on a duplicate seq', () => {
    expect(seqDense([env(1, []), env(2, []), env(2, [])], 3).ok).toBe(false);
  });

  it('fails when journal length disagrees with room seq', () => {
    expect(seqDense([env(1, []), env(2, [])], 3).ok).toBe(false);
  });
});
