/**
 * PROOF HARNESS for the MV-register / dot-citation + epoch-precedence design (Fable consults 2026-07-06,
 * idea/fable-consults-2026-07-06.md). A PURE reference model + property proofs, validating the key
 * mathematical claims BEFORE the real register implementation lands (deferred). No opSync/opLog
 * dependency — these prove the ALGORITHM converges and the load-bearing assertions hold, so the next
 * agent builds against validated math instead of a plausible-looking design.
 *
 * What is proven here (things that need NO implementation, only math):
 *  - dot-citation register: the live-sibling SET is a pure function of the delivered op set → converges
 *    under ANY arrival order (incl. cites-before-ops, duplicates).
 *  - any fold over the live set (lww / rank / epoch) is order-independent → the materialized value converges.
 *  - HLC + value-prev alone CANNOT identify siblings (identical stamps, different cites → different truth).
 *  - the naive "rank only in the concurrent branch" single-winner register DIVERGES (Condorcet cycle).
 *  - static rank tier vs dynamic epoch: exactly what each does (refines Fable's "bricks forever").
 * Deferred to impl: wiring this into opSync's register, the seed-contract state ship, GC/pruning.
 */

type Dot = { readonly writer: string; readonly hlc: number };
type Op = {
  readonly writer: string;
  readonly hlc: number;
  readonly value: unknown;
  /** dots this op observed at the path when it wrote → it supersedes them (causal). */
  readonly cites: readonly Dot[];
  readonly rank?: number; // static tier (§1 pre-epoch)
  readonly epoch?: number; // Raft-style term (§1 corrected)
};

// deterministic PRNG — reproducible proofs, no Math.random
const mulberry32 = (seed: number) => () => {
  seed |= 0;
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
const shuffle = <T>(arr: readonly T[], seed: number): T[] => {
  const r = mulberry32(seed);
  const c = [...arr];
  for (let i = c.length - 1; i > 0; i--) {
    const j = Math.floor(r() * (i + 1));
    [c[i], c[j]] = [c[j], c[i]];
  }
  return c;
};

// ────────────────────────────────────────────────────────────────────────────
// The dot-citation register (Fable consult #3). Live siblings computed from
// per-writer max-hlc op + per-writer supersession watermark (highest cited hlc).
// ────────────────────────────────────────────────────────────────────────────
class DotRegister {
  readonly best = new Map<string, Op>(); // highest-hlc op per writer
  readonly water = new Map<string, number>(); // highest cited hlc per writer

  ingest(op: Op): void {
    for (const c of op.cites) {
      this.water.set(c.writer, Math.max(this.water.get(c.writer) ?? 0, c.hlc));
    }
    const cur = this.best.get(op.writer);
    if (!cur || op.hlc > cur.hlc) this.best.set(op.writer, op);
  }
  /** admission gate: reject a straggler at/below the GC frontier (prevents post-prune resurrection). */
  admit(op: Op, frontier = -1): boolean {
    if (op.hlc <= frontier) return false;
    this.ingest(op);
    return true;
  }
  live(): Op[] {
    const out: Op[] = [];
    for (const [w, op] of this.best) {
      if (op.hlc > (this.water.get(w) ?? 0)) out.push(op);
    }
    return out.sort((a, b) => (a.writer < b.writer ? -1 : a.writer > b.writer ? 1 : 0));
  }
  /** the seed contract: ship register STATE (siblings + watermarks), not just the materialized value. */
  seedState(): { best: Map<string, Op>; water: Map<string, number> } {
    return { best: new Map(this.best), water: new Map(this.water) };
  }
  static fromState(s: { best: Map<string, Op>; water: Map<string, number> }): DotRegister {
    const r = new DotRegister();
    for (const [k, v] of s.best) r.best.set(k, v);
    for (const [k, v] of s.water) r.water.set(k, v);
    return r;
  }
  /** GC: drop superseded siblings + watermarks at/below the frontier (state bounding). */
  prune(frontier: number): void {
    for (const [w, op] of [...this.best]) {
      if (op.hlc <= frontier && op.hlc <= (this.water.get(w) ?? 0)) this.best.delete(w);
    }
    for (const [w, h] of [...this.water]) {
      if (h <= frontier) this.water.delete(w); // the frontier globally subsumes anything below it
    }
  }
}
const liveFrom = (ops: readonly Op[], seed: number): Op[] => {
  const r = new DotRegister();
  for (const op of shuffle(ops, seed)) r.ingest(op);
  return r.live();
};

// comparators for the folds (all "max under a total order")
const byLWW = (a: Op, b: Op): number =>
  a.hlc !== b.hlc ? a.hlc - b.hlc : a.writer < b.writer ? -1 : 1;
const byRank = (a: Op, b: Op): number =>
  (a.rank ?? 0) !== (b.rank ?? 0) ? (a.rank ?? 0) - (b.rank ?? 0) : byLWW(a, b);
const byEpoch = (a: Op, b: Op): number =>
  (a.epoch ?? 0) !== (b.epoch ?? 0) ? (a.epoch ?? 0) - (b.epoch ?? 0) : byLWW(a, b);
const fold = (live: Op[], cmp: (a: Op, b: Op) => number): unknown =>
  live.length ? live.reduce((a, b) => (cmp(a, b) >= 0 ? a : b)).value : undefined;

// a generator: N writers each emit M ops with increasing hlc; each op cites a random subset of
// previously-emitted dots → a random causal DAG (mix of causal successions and concurrency).
function genOps(seed: number, writers: number, per: number): Op[] {
  const r = mulberry32(seed);
  const ops: Op[] = [];
  let clock = 0;
  const dots: Dot[] = [];
  for (let m = 0; m < per; m++) {
    for (let w = 0; w < writers; w++) {
      const hlc = ++clock + Math.floor(r() * 3);
      const cites = dots.filter(() => r() < 0.35);
      const op: Op = {
        writer: 'w' + w,
        hlc,
        value: `w${w}:${hlc}`,
        cites,
        rank: Math.floor(r() * 3),
        epoch: 1,
      };
      ops.push(op);
      dots.push({ writer: op.writer, hlc: op.hlc });
    }
  }
  return ops;
}

const sig = (ops: Op[]): string => JSON.stringify(ops.map((o) => [o.writer, o.hlc, o.value]));

describe('PROOF: dot-citation register converges (live set = pure function of the op SET)', () => {
  it('any arrival order of the same op set yields the identical live-sibling set (50 seeds × many orders)', () => {
    for (let seed = 1; seed <= 50; seed++) {
      const ops = genOps(seed * 17, 3, 5);
      const base = sig(liveFrom(ops, 1));
      for (let order = 2; order <= 24; order++) {
        expect(sig(liveFrom(ops, order + seed * 100))).toBe(base);
      }
    }
  });

  it('is delivery-order-robust: a cite arriving BEFORE the op it kills still converges', () => {
    // op B cites A; deliver B (the cite) before A ever arrives → A must be born-dead.
    const A: Op = { writer: 'a', hlc: 5, value: 'A', cites: [] };
    const B: Op = { writer: 'b', hlc: 7, value: 'B', cites: [{ writer: 'a', hlc: 5 }] };
    expect(sig(liveFrom([A, B], 1))).toBe(sig(liveFrom([B, A], 1)));
    // and A is superseded either way → only B live
    const live = liveFrom([B, A], 3);
    expect(live.map((o) => o.writer)).toEqual(['b']);
  });

  it('duplicate delivery is idempotent', () => {
    const ops = genOps(999, 3, 4);
    const once = sig(liveFrom(ops, 1));
    const twice = sig(liveFrom([...ops, ...ops], 1));
    expect(twice).toBe(once);
  });
});

describe('PROOF: any fold over the live set is order-independent → materialized value converges', () => {
  for (const [name, cmp] of [
    ['lww (hlc, writer)', byLWW],
    ['rank (rank, hlc, writer)', byRank],
    ['epoch (epoch, hlc, writer)', byEpoch],
  ] as const) {
    it(`${name}: same value under every arrival order`, () => {
      for (let seed = 1; seed <= 30; seed++) {
        const ops = genOps(seed * 31, 3, 5);
        const base = JSON.stringify(fold(liveFrom(ops, 1), cmp));
        for (let order = 2; order <= 12; order++) {
          expect(JSON.stringify(fold(liveFrom(ops, order + seed * 7), cmp))).toBe(base);
        }
      }
    });
  }
});

describe('PROOF (impossibility): HLC + prev-value CANNOT identify siblings; cites are load-bearing', () => {
  it('identical (writer, hlc, value) stamps + different cites → different TRUTH', () => {
    const A: Op = { writer: 'a', hlc: 5, value: 'A', cites: [] };
    // Scenario 1: B observed A and overwrote it (cites A) → B supersedes A → only B live.
    const bCausal: Op = { writer: 'b', hlc: 7, value: 'B', cites: [{ writer: 'a', hlc: 5 }] };
    // Scenario 2: identical B stamp, but B never saw A (concurrent) → both live.
    const bConcurrent: Op = { writer: 'b', hlc: 7, value: 'B', cites: [] };

    const causal = liveFrom([A, bCausal], 1).map((o) => o.writer);
    const concurrent = liveFrom([A, bConcurrent], 1).map((o) => o.writer);

    expect(causal).toEqual(['b']); // A superseded
    expect(concurrent).toEqual(['a', 'b']); // both live
    // The (writer, hlc) stamps are byte-identical across the two scenarios:
    expect([A.writer, A.hlc, bCausal.writer, bCausal.hlc]).toEqual([
      A.writer, A.hlc, bConcurrent.writer, bConcurrent.hlc,
    ]);
    // Yet the truth differs → no function of the stamps alone can be correct. QED.
    expect(causal).not.toEqual(concurrent);
  });
});

describe('PROOF (trap): naive "rank only in the concurrent branch" single-winner register DIVERGES', () => {
  // the tempting design: one winner; incoming that CITES the winner = succession (hlc wins);
  // else concurrent (rank wins). Fable showed this is a Condorcet cycle → arrival-order dependent.
  class NaiveRegister {
    private winner: Op | undefined;
    ingest(op: Op): void {
      const cur = this.winner;
      if (!cur) {
        this.winner = op;
        return;
      }
      const succeeds = op.cites.some((c) => c.writer === cur.writer && c.hlc === cur.hlc);
      this.winner = succeeds ? op : byRank(op, cur) >= 0 ? op : cur;
    }
    value(): unknown {
      return this.winner?.value;
    }
  }
  const run = (ops: Op[]): unknown => {
    const r = new NaiveRegister();
    for (const op of ops) r.ingest(op);
    return r.value();
  };

  it('the A≻C≻B≻A cycle: the SAME op set converges to different values by arrival order', () => {
    const A: Op = { writer: 'A', hlc: 1, value: 'a', cites: [], rank: 10 }; // high rank
    const B: Op = { writer: 'B', hlc: 2, value: 'b', cites: [{ writer: 'A', hlc: 1 }], rank: 1 }; // built on A
    const C: Op = { writer: 'C', hlc: 3, value: 'c', cites: [], rank: 1 }; // concurrent, low rank

    expect(run([A, B, C])).toBe('c'); // A→B(succession)→C(concurrent, hlc)
    expect(run([A, C, B])).toBe('b'); // A→A(C loses on rank)→B(succession)
    // divergence proven: same three ops, two orders, two answers.
    expect(run([A, B, C])).not.toBe(run([A, C, B]));
  });
});

describe('PROOF: static rank tier vs dynamic epoch — precise behavior (refines "bricks forever")', () => {
  const base: Dot = { writer: 'root', hlc: 0 };
  const A: Op = { writer: 'admin', hlc: 5, value: 'A', cites: [base], rank: 10, epoch: 1 };

  it('dot-citation: a CAUSAL low-rank write beats a high-rank value it superseded (NOT bricked)', () => {
    // a user observes A and overwrites → cites A → A superseded → user wins regardless of rank.
    const user: Op = { writer: 'u', hlc: 8, value: 'U', cites: [{ writer: 'admin', hlc: 5 }], rank: 1, epoch: 1 };
    const live = liveFrom([A, user], 1);
    expect(live.map((o) => o.writer)).toEqual(['u']); // A gone
    expect(fold(live, byRank)).toBe('U'); // low-rank causal write wins → the field IS editable
  });

  it('static rank CANNOT de-escalate: a low-rank "release" loses to a CONCURRENT higher-rank op', () => {
    // admin releases with a low rank (cites A), but a concurrent stale mid-rank op resurrects over it.
    const release: Op = { writer: 'admin', hlc: 10, value: 'RELEASED', cites: [{ writer: 'admin', hlc: 5 }], rank: 1, epoch: 1 };
    const stale: Op = { writer: 's', hlc: 6, value: 'STALE', cites: [base], rank: 5, epoch: 1 };
    const live = liveFrom([A, release, stale], 1);
    // release (rank 1) and stale (rank 5) are concurrent; static rank → stale wins. Release failed.
    expect(fold(live, byRank)).toBe('STALE');
  });

  it('dynamic epoch DE-ESCALATES cleanly: the release bumps epoch and wins the same conflict', () => {
    const release: Op = { writer: 'admin', hlc: 10, value: 'RELEASED', cites: [{ writer: 'admin', hlc: 5 }], rank: 1, epoch: 2 };
    const stale: Op = { writer: 's', hlc: 6, value: 'STALE', cites: [base], rank: 5, epoch: 1 };
    const live = liveFrom([A, release, stale], 1);
    expect(fold(live, byEpoch)).toBe('RELEASED'); // epoch 2 > epoch 1 → release wins
    // and a later normal write that adopts the new epoch competes normally (owner NOT permanently privileged)
    const normal: Op = { writer: 'u', hlc: 12, value: 'NORMAL', cites: [{ writer: 'admin', hlc: 10 }], rank: 0, epoch: 2 };
    expect(fold(liveFrom([A, release, stale, normal], 1), byEpoch)).toBe('NORMAL');
  });

  it('epoch: an owner "veto" is just the fold — writing at epoch+1 deterministically wins the conflict', () => {
    // user writes concurrently (epoch 1); owner vetoes by writing at epoch 2 → wins the fold, no special case.
    const userWrite: Op = { writer: 'u', hlc: 6, value: 'BAD', cites: [base], rank: 0, epoch: 1 };
    const veto: Op = { writer: 'admin', hlc: 7, value: 'CORRECTED', cites: [base], rank: 0, epoch: 2 };
    expect(fold(liveFrom([userWrite, veto], 1), byEpoch)).toBe('CORRECTED');
  });

  it('HOLE 3 (Fable 2026-07-07): a stale OLD-HLC uncited high-rank op resurrects and wins the rank fold → value jumps BACKWARD', () => {
    // the field moved on (current value, high hlc, low rank); a partitioned high-rank device resurfaces an
    // OLD op — cites nothing recent, nothing cites it → live sibling → wins by rank. Not just concurrent-in-time.
    const current: Op = { writer: 'u', hlc: 100, value: 'CURRENT', cites: [{ writer: 'admin', hlc: 5 }], rank: 0, epoch: 1 };
    const staleHighRank: Op = { writer: 'x', hlc: 6, value: 'OLD', cites: [base], rank: 10, epoch: 1 };
    expect(fold(liveFrom([A, current, staleHighRank], 1), byRank)).toBe('OLD'); // jumped backward — the hazard
  });

  it('epoch CLOSES hole 3: a bump above the stale op keeps the current value regardless of the stale rank', () => {
    const current: Op = { writer: 'u', hlc: 100, value: 'CURRENT', cites: [{ writer: 'admin', hlc: 5 }], rank: 0, epoch: 2 };
    const staleHighRank: Op = { writer: 'x', hlc: 6, value: 'OLD', cites: [base], rank: 10, epoch: 1 };
    expect(fold(liveFrom([A, current, staleHighRank], 1), byEpoch)).toBe('CURRENT'); // epoch 2 > epoch 1
  });
});

// ─── proofs of the completeness-review gaps that are pure-model (Fable review 2026-07-07) ───

describe('PROOF: seed contract — STATE seed converges; VALUE-only seed diverges (register #17)', () => {
  it('fold(seed(STATE), suffix) ≡ fold(∅, allOps) — shipping siblings+watermarks is sound', () => {
    for (let seed = 1; seed <= 30; seed++) {
      const all = genOps(seed * 13, 3, 5);
      const cut = Math.floor(all.length / 2);
      const r = new DotRegister();
      for (const op of shuffle(all.slice(0, cut), seed)) r.ingest(op);
      const joiner = DotRegister.fromState(r.seedState()); // seed = register STATE
      for (const op of shuffle(all.slice(cut), seed + 1)) joiner.ingest(op);
      expect(sig(joiner.live())).toBe(sig(liveFrom(all, seed + 2))); // == replaying everything
    }
  });

  it('VALUE-only seed (watermarks dropped) diverges: a late below-seed op resurrects on the joiner', () => {
    const A: Op = { writer: 'a', hlc: 5, value: 'A', cites: [] };
    const B: Op = { writer: 'b', hlc: 7, value: 'B', cites: [{ writer: 'a', hlc: 5 }] }; // supersedes A
    const peer = liveFrom([A, B], 1).map((o) => o.writer);
    expect(peer).toEqual(['b']); // established: A superseded

    // a relay that folds to a single VALUE ships the joiner just that value (no watermark for a):
    const joiner = new DotRegister();
    joiner.ingest({ writer: 'b', hlc: 7, value: 'B', cites: [] }); // the folded value, as a synthetic op
    joiner.ingest(A); // a late straggler of the already-superseded A
    const j = joiner.live().map((o) => o.writer).sort();
    expect(j).toEqual(['a', 'b']); // A RESURRECTED → diverges from the peer's ['b']. QED: ship STATE, not value.
    expect(j).not.toEqual(peer);
  });
});

describe('PROOF: GC/prune — fold-equivalence + below-frontier admission prevents resurrection (register #18)', () => {
  it('pruning superseded state at/below the frontier does NOT change the live set (fold-equivalence)', () => {
    for (let seed = 1; seed <= 30; seed++) {
      const all = genOps(seed * 19, 3, 5);
      const r = new DotRegister();
      for (const op of shuffle(all, seed)) r.ingest(op);
      const before = sig(r.live());
      r.prune(3);
      expect(sig(r.live())).toBe(before);
    }
  });

  it('admission REJECTS below-frontier stragglers → no post-prune resurrection (T1(7) via GC)', () => {
    const A: Op = { writer: 'a', hlc: 5, value: 'A', cites: [] };
    const B: Op = { writer: 'b', hlc: 20, value: 'B', cites: [{ writer: 'a', hlc: 5 }] };
    const r = new DotRegister();
    r.ingest(A);
    r.ingest(B);
    r.prune(10); // GC drops A's sibling AND its watermark (state bounding)

    const naive = DotRegister.fromState(r.seedState());
    naive.ingest(A); // no admission gate → below-frontier straggler resurrects
    expect(naive.live().map((o) => o.writer).sort()).toEqual(['a', 'b']); // the hazard

    const guarded = DotRegister.fromState(r.seedState());
    expect(guarded.admit(A, 10)).toBe(false); // admission rejects hlc 5 ≤ frontier 10
    expect(guarded.live().map((o) => o.writer)).toEqual(['b']); // no resurrection
  });
});

describe('PROOF: epoch monotone-at-read + concurrent-bump convergence (register #20)', () => {
  it('the exposed (winning) epoch never decreases as ops stream in — given adopt-highest emission', () => {
    // concurrent ops; the epoch fold is a max, so the winner epoch is non-decreasing.
    const stream: Op[] = [
      { writer: 'a', hlc: 1, value: 'a', cites: [], epoch: 1 },
      { writer: 'b', hlc: 2, value: 'b', cites: [], epoch: 3 },
      { writer: 'c', hlc: 3, value: 'c', cites: [], epoch: 2 }, // a lower epoch must NOT lower the read
    ];
    const r = new DotRegister();
    let prev = -Infinity;
    for (const op of stream) {
      r.ingest(op);
      const winner = r.live().reduce((x, y) => (byEpoch(x, y) >= 0 ? x : y));
      const e = winner.epoch ?? 0;
      expect(e >= prev).toBe(true);
      prev = e;
    }
  });

  it('two concurrent AUTHORIZED bumps to the same epoch N converge deterministically', () => {
    const b1: Op = { writer: 'admin1', hlc: 5, value: 'X', cites: [], epoch: 2 };
    const b2: Op = { writer: 'admin2', hlc: 6, value: 'Y', cites: [], epoch: 2 };
    expect(fold(liveFrom([b1, b2], 1), byEpoch)).toBe(fold(liveFrom([b1, b2], 2), byEpoch));
  });
});

describe('PROOF: bounded state + why replica-id uniqueness & deterministic validation are load-bearing', () => {
  it('register state is O(writers), not O(ops)', () => {
    const many = genOps(7, 3, 20); // 3 writers × 20 rounds = 60 ops
    const r = new DotRegister();
    for (const op of many) r.ingest(op);
    const writers = new Set(many.map((o) => o.writer)).size;
    expect(r.best.size).toBeLessThanOrEqual(writers);
    expect(r.water.size).toBeLessThanOrEqual(writers);
  });

  it('dot collision (two writers share an id) BREAKS convergence → replica-id must be unique (register #23/#24)', () => {
    const one: Op = { writer: 'shared', hlc: 5, value: 'ONE', cites: [] };
    const two: Op = { writer: 'shared', hlc: 5, value: 'TWO', cites: [] }; // distinct op, SAME dot
    const r1 = new DotRegister();
    r1.ingest(one);
    r1.ingest(two); // equal hlc → not replaced → keeps ONE
    const r2 = new DotRegister();
    r2.ingest(two);
    r2.ingest(one); // keeps TWO
    expect(r1.live()[0].value).not.toBe(r2.live()[0].value); // ONE vs TWO — divergence from a shared id
  });

  it('nondeterministic validation diverges → validation must be deterministic + total (register #16)', () => {
    const op: Op = { writer: 'a', hlc: 5, value: 'A', cites: [] };
    const accept = new DotRegister();
    accept.ingest(op);
    const reject = new DotRegister(); // same op, rejected here → different set
    expect(sig(accept.live())).not.toBe(sig(reject.live()));
  });
});

// ════════════════════════════════════════════════════════════════════════════
// Part 2 (2026-07-07, Fable readiness review): PATHS + DELETES + CLEARS + SUBTREE
// DOMINANCE (conflict-precedence §5/§6; invariants #19/#33). Part 1's model is
// SINGLE-PATH; the real createConvergingApply does stamp-based ancestor/descendant
// dominance. This extends the model to the TREE: per-path DotRegisters (Part 1
// mechanics UNCHANGED) + deepest-live-wins materialization. Subtree write = a
// same-envelope group `set A` + one CLEAR per observed live descendant register.
// CLEAR is a third op kind: observed-remove of a REGISTER (fold-winning clear
// ABSTAINS at materialization) vs DELETE = observed-remove of a KEY (grafts
// key-absent). The counterexamples that FORCED clear are pinned below.
// IDENTITY NOTE (ruling 2026-07-07, invariants #23): this model's `writer`
// plays the ORIGIN (replica) role — the real dot is (origin, hlc), because the
// shipped system shares writers across origins; the real fold appends origin
// as the final strictness tiebreak. All theorems transfer verbatim.
// ════════════════════════════════════════════════════════════════════════════

type Kind = 'set' | 'delete' | 'clear';
type PathOp = Op & { readonly path: readonly string[]; readonly kind: Kind };

const PSEP = ' ';
const pkey = (p: readonly string[]): string => p.join(PSEP);
const ABSENT = ' __absent__'; // graft marker, never lands in a tree

// default tree fold (§5): max by (epoch, kind-class, hlc, writer); set = delete > clear on kind-class.
// Still a total order computable from the op alone → Part 1's fold convergence theorem applies as-is.
const kindClass = (o: PathOp): number => (o.kind === 'clear' ? 0 : 1);
const byTree = (a: PathOp, b: PathOp): number =>
  (a.epoch ?? 0) !== (b.epoch ?? 0)
    ? (a.epoch ?? 0) - (b.epoch ?? 0)
    : kindClass(a) !== kindClass(b)
      ? kindClass(a) - kindClass(b)
      : byLWW(a, b);

// graft with the deterministic TYPE-CHANGE rule: a graft whose parent location is not a
// container is DROPPED (the register stays intact and resurfaces if the shape is restored).
const graft = (tree: unknown, path: readonly string[], v: unknown): unknown => {
  if (path.length === 0) return v === ABSENT ? undefined : v;
  if (typeof tree !== 'object' || tree === null || Array.isArray(tree)) return tree; // drop-graft
  const obj = tree as Record<string, unknown>;
  const head = path[0];
  if (path.length === 1) {
    if (v === ABSENT) {
      if (!(head in obj)) return obj;
      const copy = { ...obj };
      delete copy[head];
      return copy;
    }
    return { ...obj, [head]: v };
  }
  if (!(head in obj)) return obj; // no container to graft into → drop
  const child = graft(obj[head], path.slice(1), v);
  return child === obj[head] ? obj : { ...obj, [head]: child };
};

class TreeReplica {
  readonly regs = new Map<string, DotRegister>();
  ingest(op: PathOp): void {
    const k = pkey(op.path);
    let r = this.regs.get(k);
    if (!r) this.regs.set(k, (r = new DotRegister()));
    r.ingest(op);
  }
  ingestAll(ops: readonly PathOp[]): void {
    for (const op of ops) this.ingest(op);
  }
  liveAt(path: readonly string[]): PathOp[] {
    return (this.regs.get(pkey(path))?.live() ?? []) as PathOp[];
  }
  winnerAt(path: readonly string[]): PathOp | undefined {
    const live = this.liveAt(path);
    return live.length ? live.reduce((x, y) => (byTree(x, y) >= 0 ? x : y)) : undefined;
  }
  /** deepest-live-wins: apply winners shallow→deep; delete grafts key-absent; clear ABSTAINS. */
  materialize(base: unknown = {}): unknown {
    const entries: Array<{ path: string[]; key: string; w: PathOp }> = [];
    for (const key of this.regs.keys()) {
      const path = key === '' ? [] : key.split(PSEP);
      const w = this.winnerAt(path);
      if (w && w.kind !== 'clear') entries.push({ path, key, w });
    }
    entries.sort(
      (a, b) => a.path.length - b.path.length || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0),
    );
    let tree = base;
    for (const e of entries) tree = graft(tree, e.path, e.w.kind === 'delete' ? ABSENT : e.w.value);
    return tree;
  }
}
const matSig = (r: TreeReplica): string => JSON.stringify({ root: r.materialize() });

const dotsOf = (ops: readonly PathOp[]): Dot[] => ops.map((o) => ({ writer: o.writer, hlc: o.hlc }));
// max observed epoch at a path (the emitting replica has applied its own writes, so
// own-prior-at-path is included in "observed" — the #20 emission floor holds by construction here)
const epochAt = (rep: TreeReplica, path: readonly string[]): number =>
  Math.max(1, ...rep.liveAt(path).map((o) => o.epoch ?? 1));

/** §5 emission: subtree set/delete = the op at A + one CLEAR per observed live descendant register.
 *  Epochs are PER-PATH (#20a): each op carries max(observed-at-its-path) (+1 each if bumped). */
function subtreeGroup(
  rep: TreeReplica,
  kind: 'set' | 'delete',
  path: readonly string[],
  writer: string,
  hlc: number,
  value: unknown,
  bump = false,
): PathOp[] {
  const k = pkey(path);
  const ops: PathOp[] = [
    {
      writer,
      hlc,
      path,
      kind,
      value,
      cites: dotsOf(rep.liveAt(path)),
      epoch: epochAt(rep, path) + (bump ? 1 : 0),
    },
  ];
  const isDesc = (rk: string): boolean => (k === '' ? rk !== '' : rk.startsWith(k + PSEP));
  for (const rk of [...rep.regs.keys()].sort()) {
    if (!isDesc(rk)) continue;
    const dpath = rk.split(PSEP);
    const live = rep.liveAt(dpath);
    if (!live.length) continue;
    if (rep.winnerAt(dpath)?.kind === 'clear') continue; // already abstaining
    ops.push({
      writer,
      hlc,
      path: dpath,
      kind: 'clear',
      value: undefined,
      cites: dotsOf(live),
      epoch: epochAt(rep, dpath) + (bump ? 1 : 0),
    });
  }
  return ops;
}

// generator: a mixed workload over a small path universe — plain sets (sometimes citing nothing =
// partitioned/concurrent), subtree replaces + deletes (groups, sometimes epoch-bumped). Emitted
// against a sequential world replica; the TESTS deliver the flat op list in arbitrary orders.
const TREE_PATHS: string[][] = [
  [],
  ['a'],
  ['a', 'x'],
  ['a', 'y'],
  ['a', 'x', 'deep'],
  ['b'],
  ['b', 'z'],
];
function genTreeOps(seed: number, rounds: number): PathOp[] {
  const r = mulberry32(seed);
  const world = new TreeReplica();
  const out: PathOp[] = [];
  let clock = 0;
  for (let i = 0; i < rounds; i++) {
    const writer = 'w' + Math.floor(r() * 3);
    const hlc = ++clock;
    const path = TREE_PATHS[Math.floor(r() * TREE_PATHS.length)];
    const roll = r();
    let group: PathOp[];
    if (roll < 0.18) {
      group = subtreeGroup(world, 'set', path, writer, hlc, { v: `${writer}:${hlc}` }, r() < 0.3);
    } else if (roll < 0.28) {
      group = subtreeGroup(world, 'delete', path, writer, hlc, undefined, r() < 0.3);
    } else {
      const cites = r() < 0.7 ? dotsOf(world.liveAt(path)) : []; // 30%: never saw the path → concurrent
      group = [
        { writer, hlc, path, kind: 'set', value: `${writer}:${hlc}`, cites, epoch: epochAt(world, path) },
      ];
    }
    world.ingestAll(group);
    out.push(...group);
  }
  return out;
}

describe('PROOF §5(a): TREE materialization = pure function of the delivered op set', () => {
  it('any arrival order (groups split + interleaved) yields the identical tree (30 seeds × 10 orders)', () => {
    for (let seed = 1; seed <= 30; seed++) {
      const ops = genTreeOps(seed * 41, 25);
      const base = new TreeReplica();
      base.ingestAll(shuffle(ops, 1));
      const expected = matSig(base);
      for (let order = 2; order <= 10; order++) {
        const rep = new TreeReplica();
        rep.ingestAll(shuffle(ops, order + seed * 13));
        expect(matSig(rep)).toBe(expected);
      }
    }
  });

  it('duplicate delivery of whole groups is idempotent', () => {
    for (let seed = 1; seed <= 10; seed++) {
      const ops = genTreeOps(seed * 53, 20);
      const once = new TreeReplica();
      once.ingestAll(ops);
      const twice = new TreeReplica();
      twice.ingestAll(shuffle([...ops, ...ops], seed));
      expect(matSig(twice)).toBe(matSig(once));
    }
  });
});

describe('PROOF §5(b)+(d): subtree replace vs CONCURRENT descendant edit', () => {
  // world: settings seeded, theme edited (observed), theme edited AGAIN + subtree replaced (concurrent)
  const seed1: PathOp = {
    writer: 'w0', hlc: 1, path: ['settings'], kind: 'set',
    value: { theme: 'old', lang: 'en' }, cites: [], epoch: 1,
  };
  const editOld: PathOp = {
    writer: 'w1', hlc: 2, path: ['settings', 'theme'], kind: 'set',
    value: 'w1-old', cites: [], epoch: 1,
  };
  const observedView = (): TreeReplica => {
    const v = new TreeReplica();
    v.ingestAll([seed1, editOld]);
    return v;
  };
  // w1's SECOND edit — concurrent with the replace (the replace never observed it)
  const editNew: PathOp = {
    writer: 'w1', hlc: 7, path: ['settings', 'theme'], kind: 'set',
    value: 'w1-new', cites: [{ writer: 'w1', hlc: 2 }], epoch: 1,
  };
  // w3's LOW-hlc concurrent edit (hlc 4 < the replace's 6) — proves survival is CATEGORICAL, not an hlc race
  const editLow: PathOp = {
    writer: 'w3', hlc: 4, path: ['settings', 'theme'], kind: 'set',
    value: 'w3-low', cites: [{ writer: 'w1', hlc: 2 }], epoch: 1,
  };

  it('UN-BUMPED replace: the concurrent edit survives — "new settings, your theme" (both orders)', () => {
    const group = subtreeGroup(observedView(), 'set', ['settings'], 'w2', 6, { theme: 'new', extra: 1 });
    expect(group.some((o) => o.kind === 'clear')).toBe(true); // the observed theme register IS cleared
    const forward = new TreeReplica();
    forward.ingestAll([seed1, editOld, ...group, editNew]); // replace lands, edit arrives LATE (§5(d))
    const reverse = new TreeReplica();
    reverse.ingestAll([editNew, ...group, editOld, seed1]);
    expect(matSig(forward)).toBe(matSig(reverse));
    expect(forward.materialize()).toEqual({ settings: { theme: 'w1-new', extra: 1 } });
  });

  it('survival is CATEGORICAL (kind-class), not an hlc race: a LOWER-hlc concurrent edit also survives', () => {
    const group = subtreeGroup(observedView(), 'set', ['settings'], 'w2', 6, { theme: 'new', extra: 1 });
    const rep = new TreeReplica();
    rep.ingestAll([seed1, editOld, ...group, editLow]);
    expect(rep.materialize()).toEqual({ settings: { theme: 'w3-low', extra: 1 } });
  });

  it('EPOCH-BUMPED replace CLEARS the concurrent edit — the owner subtree veto, same mechanic', () => {
    const group = subtreeGroup(
      observedView(), 'set', ['settings'], 'w2', 6, { theme: 'new', extra: 1 }, true,
    );
    const rep = new TreeReplica();
    rep.ingestAll(shuffle([seed1, editOld, ...group, editNew], 3));
    expect(rep.materialize()).toEqual({ settings: { theme: 'new', extra: 1 } });
  });

  it('an UNCONTENDED replace keeps its own fields intact (clear abstains; nothing erased)', () => {
    const group = subtreeGroup(observedView(), 'set', ['settings'], 'w2', 6, { theme: 'new', extra: 1 });
    const rep = new TreeReplica();
    rep.ingestAll([seed1, editOld, ...group]);
    expect(rep.materialize()).toEqual({ settings: { theme: 'new', extra: 1 } });
  });
});

describe('PROOF §5 (pinned counterexamples): why the group must emit CLEAR, not DELETE', () => {
  const seed1: PathOp = {
    writer: 'w0', hlc: 1, path: ['settings'], kind: 'set',
    value: { theme: 'old' }, cites: [], epoch: 1,
  };
  const editOld: PathOp = {
    writer: 'w1', hlc: 2, path: ['settings', 'theme'], kind: 'set',
    value: 'w1-old', cites: [], epoch: 1,
  };
  const deleteGroup = (writer: string, hlc: number, value: unknown): PathOp[] => [
    // the WRONG first-draft emission: per-path DELETES of observed descendant registers
    { writer, hlc, path: ['settings'], kind: 'set', value, cites: [{ writer: 'w0', hlc: 1 }], epoch: 1 },
    { writer, hlc, path: ['settings', 'theme'], kind: 'delete', value: undefined, cites: [{ writer: 'w1', hlc: 2 }], epoch: 1 },
  ];

  it('DELETE-draft erases the replace\'s OWN fresh key even uncontended (the flaw that forced clear)', () => {
    const rep = new TreeReplica();
    rep.ingestAll([seed1, editOld, ...deleteGroup('w2', 6, { theme: 'new' })]);
    // the winning tombstone at ['settings','theme'] grafts "key absent" ON TOP of the fresh value:
    expect(rep.materialize()).toEqual({ settings: {} }); // theme GONE — the replace deleted its own field
  });

  it('DELETE-draft under TWO concurrent replaces erases the fold-winner\'s key (dot-matching cannot fix it)', () => {
    const rep = new TreeReplica();
    rep.ingestAll([
      seed1, editOld,
      ...deleteGroup('w2', 6, { theme: 'from-w2' }),
      ...deleteGroup('w3', 8, { theme: 'from-w3' }), // w3 wins ['settings'] by hlc
    ]);
    const mat = rep.materialize() as { settings: Record<string, unknown> };
    expect(mat.settings['theme']).toBeUndefined(); // w3 won, yet its theme is erased by a loser's tombstone
  });

  it('CLEAR-group handles the same two-concurrent-replaces case correctly', () => {
    const view = new TreeReplica();
    view.ingestAll([seed1, editOld]);
    const g2 = subtreeGroup(view, 'set', ['settings'], 'w2', 6, { theme: 'from-w2' });
    const g3 = subtreeGroup(view, 'set', ['settings'], 'w3', 8, { theme: 'from-w3' });
    for (let order = 1; order <= 6; order++) {
      const rep = new TreeReplica();
      rep.ingestAll(shuffle([seed1, editOld, ...g2, ...g3], order));
      expect(rep.materialize()).toEqual({ settings: { theme: 'from-w3' } }); // the fold winner, intact
    }
  });
});

describe('PROOF §6: deletes — register semantics, subtree delete, epoch floor across revival', () => {
  it('3 concurrent set/delete/set to one path converge under every order (the Tier-3 divergence class)', () => {
    const s1: PathOp = { writer: 'a', hlc: 5, path: ['k'], kind: 'set', value: 'A', cites: [], epoch: 1 };
    const del: PathOp = { writer: 'b', hlc: 6, path: ['k'], kind: 'delete', value: undefined, cites: [], epoch: 1 };
    const s2: PathOp = { writer: 'c', hlc: 7, path: ['k'], kind: 'set', value: 'C', cites: [], epoch: 1 };
    const first = new TreeReplica();
    first.ingestAll([s1, del, s2]);
    for (let order = 2; order <= 6; order++) {
      const rep = new TreeReplica();
      rep.ingestAll(shuffle([s1, del, s2], order));
      expect(matSig(rep)).toBe(matSig(first));
    }
    expect(first.materialize({ k: 'base' })).toEqual({ k: 'C' }); // same-class LWW race: hlc 7 wins
  });

  it('subtree DELETE: concurrent edit under the deleted parent DROPS at materialization, REVIVES on re-create', () => {
    const world = new TreeReplica();
    const seedA: PathOp = { writer: 'w0', hlc: 1, path: ['a'], kind: 'set', value: { x: 1 }, cites: [], epoch: 1 };
    world.ingest(seedA);
    const group = subtreeGroup(world, 'delete', ['a'], 'w1', 5, undefined);
    const editUnder: PathOp = {
      writer: 'w2', hlc: 6, path: ['a', 'x'], kind: 'set', value: 'survivor', cites: [], epoch: 1,
    };
    const rep = new TreeReplica();
    rep.ingestAll([seedA, ...group, editUnder]);
    expect(rep.materialize()).toEqual({}); // 'a' deleted; the edit's graft has no container → dropped
    // re-create 'a' as a container (citing the tombstone) → the live edit RESURFACES:
    const recreate: PathOp = {
      writer: 'w3', hlc: 9, path: ['a'], kind: 'set', value: {}, cites: [{ writer: 'w1', hlc: 5 }], epoch: 1,
    };
    rep.ingest(recreate);
    expect(rep.materialize()).toEqual({ a: { x: 'survivor' } });
  });

  it('type-change graft determinism: an edit under a SCALAR parent drops the same way in every order', () => {
    const scalar: PathOp = { writer: 'w0', hlc: 5, path: ['a'], kind: 'set', value: 42, cites: [], epoch: 1 };
    const under: PathOp = { writer: 'w1', hlc: 6, path: ['a', 'x'], kind: 'set', value: 'lost', cites: [], epoch: 1 };
    const fwd = new TreeReplica();
    fwd.ingestAll([scalar, under]);
    const rev = new TreeReplica();
    rev.ingestAll([under, scalar]);
    expect(matSig(fwd)).toBe(matSig(rev));
    expect(fwd.materialize()).toEqual({ a: 42 });
  });

  it('the per-path epoch floor SURVIVES tombstone → re-create (discharges the §1 corollary)', () => {
    const rep = new TreeReplica();
    const authoritative: PathOp = {
      writer: 'owner', hlc: 5, path: ['k'], kind: 'set', value: 'SETTLED', cites: [], epoch: 3,
    };
    rep.ingest(authoritative);
    // the delete CITES the epoch-3 op → emission adopts max(cited, own-prior) = 3:
    const del: PathOp = {
      writer: 'u', hlc: 8, path: ['k'], kind: 'delete', value: undefined,
      cites: [{ writer: 'owner', hlc: 5 }], epoch: epochAt(rep, ['k']),
    };
    rep.ingest(del);
    expect(rep.winnerAt(['k'])?.epoch).toBe(3); // the tombstone carries the floor
    // re-create cites the tombstone → adopts 3 → a stale prior-epoch straggler can NEVER outrank it:
    const recreate: PathOp = {
      writer: 'v', hlc: 10, path: ['k'], kind: 'set', value: 'REBORN',
      cites: [{ writer: 'u', hlc: 8 }], epoch: epochAt(rep, ['k']),
    };
    rep.ingest(recreate);
    expect(rep.winnerAt(['k'])?.epoch).toBe(3); // floor preserved across revival
    const stale: PathOp = { writer: 's', hlc: 2, path: ['k'], kind: 'set', value: 'OLD', cites: [], epoch: 2 };
    rep.ingest(stale);
    expect(rep.winnerAt(['k'])?.value).toBe('REBORN'); // epoch 3 > 2 — no resurrection
  });
});

describe('PROOF (liveness L1/L2): op-id dedup delivers to all AND bounds forwarding in a CYCLIC mesh', () => {
  it('no infinite rebroadcast despite the cycle; every peer receives exactly once, forwarding terminates', () => {
    const peers = ['p0', 'p1', 'p2', 'p3']; // a ring: each floods to its neighbor, p3 → p0 (a cycle)
    const seen = new Map(peers.map((p) => [p, new Set<string>()]));
    const nextOf = (p: string) => peers[(peers.indexOf(p) + 1) % peers.length];
    let forwards = 0;
    const queue: Array<[string, string]> = [['p0', 'X']]; // p0 originates op X
    let steps = 0;
    while (queue.length > 0 && steps++ < 10_000) {
      const item = queue.shift();
      if (!item) break;
      const [p, id] = item;
      const set = seen.get(p) ?? new Set<string>();
      if (set.has(id)) continue; // dedup: already relayed → do NOT re-forward (this is what cuts the cycle)
      set.add(id);
      seen.set(p, set);
      forwards++;
      queue.push([nextOf(p), id]); // forward exactly once
    }
    expect([...seen.values()].every((s) => s.has('X'))).toBe(true); // delivered to ALL (L1 in this model)
    expect(forwards).toBe(peers.length); // exactly one forward per peer → bounded, terminates (L2)
  });
});

// ════════════════════════════════════════════════════════════════════════════
// Part 3 (2026-07-08): ORDERED KEYED CONTAINERS (element-granular lists with
// fractional positions). ZERO new register rules: an element is an ordinary
// subtree at [C, k]; its position is an ordinary register at the reserved
// segment [C, k, '~pos']; insert / move / edit / element-delete / list-rewrite
// / rebalance are ALL Part 2 emissions (plain sets, subtreeGroup groups, epoch
// bumps). The ONLY new machinery is ordered materialization:
//   list at C = element keys k whose [C, k] subtree materializes present,
//   sorted by (pos value, pos-winner dot as (writer, hlc), key).
// Presence and the EFFECTIVE pos both come from the existing deepest-live-wins
// tree materialization (a deeper live pos register overrides the pos field
// inside an ancestor set value; a cleared or absent pos register falls back to
// it). The pos-winner DOT for tie-breaking is the deepest set-kind winner
// along the chain [C,k,'~pos'] then [C,k] then [C] that actually supplies the
// pos; the impl MUST mirror this exact chain or two replicas could break pos
// ties differently.
// Pos is modeled as a NUMBER; the impl will use fractional-index strings. The
// obligations here are about order determinism, not encoding.
// ════════════════════════════════════════════════════════════════════════════

const POS = '~pos'; // reserved path segment: the element's position register
const LIST: readonly string[] = ['list']; // the container path C used throughout Part 3

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);
const byDot = (a: Dot, b: Dot): number =>
  a.writer < b.writer ? -1 : a.writer > b.writer ? 1 : a.hlc - b.hlc;

/** the dot of the op that SUPPLIES element k's pos: deepest set-kind winner along
 *  [C,k,POS] > [C,k] > [C]. The deepest level only counts when its graft actually
 *  lands (the materialized element is a container); shallower levels supply the pos
 *  through their own set value, so their dot stands in. Pure function of registers. */
function posDot(rep: TreeReplica, C: readonly string[], k: string, container: Record<string, unknown>): Dot {
  const deep = rep.winnerAt([...C, k, POS]);
  if (deep && deep.kind === 'set' && isObj(container[k])) return { writer: deep.writer, hlc: deep.hlc };
  const el = rep.winnerAt([...C, k]);
  if (el && el.kind === 'set') return { writer: el.writer, hlc: el.hlc };
  const c = rep.winnerAt(C);
  if (c && c.kind === 'set') return { writer: c.writer, hlc: c.hlc };
  return { writer: '', hlc: 0 };
}

type ListEntry = { key: string; pos: number; by: Dot; value: unknown };

/** ordered materialization: keys present in the materialized container at C, sorted by
 *  (pos, pos-winner dot, key). Total and deterministic: pos + dot come from register
 *  winners (pure functions of the op set) and key breaks the final tie. */
function orderedMaterialize(rep: TreeReplica, C: readonly string[]): ListEntry[] {
  let node: unknown = rep.materialize();
  for (const seg of C) node = isObj(node) ? node[seg] : undefined;
  if (!isObj(node)) return [];
  const container = node;
  const entries: ListEntry[] = [];
  for (const key of Object.keys(container)) {
    const el = container[key];
    const raw = isObj(el) ? el[POS] : undefined;
    entries.push({
      key,
      pos: typeof raw === 'number' ? raw : 0, // absent pos: deterministic fallback, dot+key still order it
      by: posDot(rep, C, key, container),
      value: el,
    });
  }
  entries.sort((a, b) => {
    if (a.pos !== b.pos) return a.pos - b.pos;
    const d = byDot(a.by, b.by);
    if (d !== 0) return d;
    return a.key < b.key ? -1 : 1;
  });
  return entries;
}

const listSig = (rep: TreeReplica): string =>
  JSON.stringify(orderedMaterialize(rep, LIST).map((e) => [e.key, e.value]));
const listKeys = (rep: TreeReplica): string[] => orderedMaterialize(rep, LIST).map((e) => e.key);

/** genesis container + seed elements, emitted sequentially by w0 (hlc 1..n). */
function baseListOps(elements: ReadonlyArray<readonly [string, number, string]>): PathOp[] {
  const world = new TreeReplica();
  const out: PathOp[] = [];
  let hlc = 0;
  const genesis = subtreeGroup(world, 'set', LIST, 'w0', ++hlc, {});
  world.ingestAll(genesis);
  out.push(...genesis);
  for (const [k, pos, title] of elements) {
    const group = subtreeGroup(world, 'set', [...LIST, k], 'w0', ++hlc, { [POS]: pos, title });
    world.ingestAll(group);
    out.push(...group);
  }
  return out;
}
const viewOf = (ops: readonly PathOp[]): TreeReplica => {
  const v = new TreeReplica();
  v.ingestAll(ops);
  return v;
};
const deliver = (ops: readonly PathOp[], seed: number): TreeReplica => {
  const r = new TreeReplica();
  r.ingestAll(shuffle(ops, seed));
  return r;
};
/** assert the ordered list converges across several arrival orders; return one replica. */
function convergedList(ops: readonly PathOp[], orders = 6): TreeReplica {
  const base = deliver(ops, 1);
  const expected = listSig(base);
  for (let o = 2; o <= orders; o++) expect(listSig(deliver(ops, o * 7 + 3))).toBe(expected);
  return base;
}

/** rebalance emission: an epoch-BUMPED sweep rewriting ONLY the [C, k, POS] registers,
 *  one bumped set per present element, all in one envelope (one writer, one hlc). */
function rebalanceGroup(view: TreeReplica, writer: string, hlc: number, step = 100): PathOp[] {
  const out: PathOp[] = [];
  let p = 0;
  for (const e of orderedMaterialize(view, LIST)) {
    out.push(...subtreeGroup(view, 'set', [...LIST, e.key, POS], writer, hlc, (p += step), true));
  }
  return out;
}

// generator: a mixed keyed-container workload emitted against a sequential world replica
// (so cites/epochs are well-formed); the TESTS deliver the flat op list in arbitrary orders.
const LIST_KEYS_POOL = ['k0', 'k1', 'k2', 'k3', 'k4', 'k5'];
function genListOps(seed: number, rounds: number): PathOp[] {
  const r = mulberry32(seed);
  const world = new TreeReplica();
  const out: PathOp[] = [];
  let clock = 0;
  const genesis = subtreeGroup(world, 'set', LIST, 'w0', ++clock, {});
  world.ingestAll(genesis);
  out.push(...genesis);
  const posPick = (): number => {
    const cur = orderedMaterialize(world, LIST);
    if (cur.length && r() < 0.25) return cur[Math.floor(r() * cur.length)].pos; // deliberate pos tie
    return Math.floor(r() * 1000) / 8;
  };
  for (let i = 0; i < rounds; i++) {
    const writer = 'w' + Math.floor(r() * 3);
    const hlc = ++clock;
    const live = listKeys(world);
    const roll = r();
    let group: PathOp[];
    if (roll < 0.3 || live.length === 0) {
      // insert (or re-insert over a tombstoned/observed key; subtreeGroup handles both)
      const k = LIST_KEYS_POOL[Math.floor(r() * LIST_KEYS_POOL.length)];
      group = subtreeGroup(world, 'set', [...LIST, k], writer, hlc, {
        [POS]: posPick(),
        title: `${writer}:${hlc}`,
      });
    } else if (roll < 0.5) {
      // move
      const k = live[Math.floor(r() * live.length)];
      group = subtreeGroup(world, 'set', [...LIST, k, POS], writer, hlc, posPick());
    } else if (roll < 0.68) {
      // data edit
      const k = live[Math.floor(r() * live.length)];
      group = subtreeGroup(world, 'set', [...LIST, k, 'title'], writer, hlc, `edit:${writer}:${hlc}`);
    } else if (roll < 0.82) {
      // element delete
      const k = live[Math.floor(r() * live.length)];
      group = subtreeGroup(world, 'delete', [...LIST, k], writer, hlc, undefined);
    } else if (roll < 0.92) {
      // whole-list rewrite: keep a subset (fresh pos), add one fresh element
      const value: Record<string, unknown> = {};
      let p = 0;
      for (const k of live) {
        if (r() < 0.7) value[k] = { [POS]: (p += 10), title: `rw:${writer}:${hlc}:${k}` };
      }
      const fresh = LIST_KEYS_POOL[Math.floor(r() * LIST_KEYS_POOL.length)];
      value[fresh] = { [POS]: p + 10, title: `rw-new:${writer}:${hlc}` };
      group = subtreeGroup(world, 'set', LIST, writer, hlc, value);
    } else {
      group = rebalanceGroup(world, writer, hlc);
    }
    world.ingestAll(group);
    out.push(...group);
  }
  return out;
}

describe('PROOF LIST(1): ordered materialization = pure function of the delivered op set', () => {
  it('full ordered list (keys AND values) identical across arrival orders, groups split + duplicated (25 seeds x 8 orders)', () => {
    for (let seed = 1; seed <= 25; seed++) {
      const ops = genListOps(seed * 47, 22);
      const expected = listSig(deliver(ops, 1));
      for (let order = 2; order <= 7; order++) {
        // plain shuffles split every group (set-at-A and its clears land interleaved with everything)
        expect(listSig(deliver(ops, order + seed * 11))).toBe(expected);
      }
      // order 8: duplicated delivery on top of a shuffle (half the stream re-delivered)
      const dup = [...ops, ...ops.slice(0, Math.floor(ops.length / 2))];
      expect(listSig(deliver(dup, seed * 29))).toBe(expected);
    }
  });

  it('vacuity guard: the workload exercises every operation class and non-degenerate lists', () => {
    // convergence over a degenerate stream proves nothing; pin that the generator emits all
    // six operation classes, that groups actually carry clears, and that lists stay populated.
    let inserts = 0, moves = 0, edits = 0, deletes = 0, rewrites = 0, rebalances = 0, clears = 0;
    let populated = 0;
    for (let seed = 1; seed <= 25; seed++) {
      const ops = genListOps(seed * 47, 22);
      const posSets = new Map<string, number>(); // (writer,hlc) → POS-set count; 2+ = a rebalance sweep
      for (const op of ops) {
        const depth = op.path.length;
        const last = op.path[depth - 1];
        if (op.kind === 'clear') clears++;
        else if (op.kind === 'delete' && depth === 2) deletes++;
        else if (op.kind === 'set' && depth === 2) inserts++;
        else if (op.kind === 'set' && depth === 3 && last === POS) {
          moves++;
          const k = op.writer + ':' + op.hlc;
          posSets.set(k, (posSets.get(k) ?? 0) + 1);
        } else if (op.kind === 'set' && depth === 3 && last === 'title') edits++;
        else if (op.kind === 'set' && depth === 1 && op.hlc > 1) rewrites++;
      }
      rebalances += [...posSets.values()].filter((n) => n >= 2).length;
      if (listKeys(deliver(ops, 1)).length >= 2) populated++;
    }
    for (const n of [inserts, moves, edits, deletes, rewrites, rebalances, clears]) {
      expect(n).toBeGreaterThan(0);
    }
    expect(populated).toBeGreaterThanOrEqual(13); // most seeds end with a real (2+ element) list
  });
});

describe('PROOF LIST(2): concurrent inserts of DIFFERENT keys into the same gap', () => {
  it('both survive; equal pos broken by the pos-winner dot; no duplicate keys; both orders agree', () => {
    const base = baseListOps([['a', 1, 'A'], ['b', 2, 'B']]);
    const view = viewOf(base);
    const insX = subtreeGroup(view, 'set', [...LIST, 'x'], 'w1', 10, { [POS]: 1.5, title: 'X' });
    const insY = subtreeGroup(view, 'set', [...LIST, 'y'], 'w2', 11, { [POS]: 1.5, title: 'Y' });
    // a fresh insert observed nothing at its path: a single op, no cites, no clears
    expect(insX).toHaveLength(1);
    expect(insX[0].cites).toEqual([]);

    const rep = convergedList([...base, ...insX, ...insY]);
    const entries = orderedMaterialize(rep, LIST);
    // both elements present exactly once; the 1.5 tie breaks by dot (w1 < w2)
    expect(entries.map((e) => e.key)).toEqual(['a', 'x', 'y', 'b']);
    expect(new Set(entries.map((e) => e.key)).size).toBe(entries.length);
    expect(entries[1].value).toEqual({ [POS]: 1.5, title: 'X' });
    expect(entries[2].value).toEqual({ [POS]: 1.5, title: 'Y' });
  });
});

describe('PROOF LIST(3): concurrent insert of the SAME key by two writers', () => {
  it('converges to ONE element resolved by the ordinary register fold at [C,k]; both orders agree', () => {
    const base = baseListOps([['a', 1, 'A'], ['b', 2, 'B']]);
    const view = viewOf(base);
    const ins1 = subtreeGroup(view, 'set', [...LIST, 'x'], 'w1', 10, { [POS]: 1.5, title: 'from-w1' });
    const ins2 = subtreeGroup(view, 'set', [...LIST, 'x'], 'w2', 11, { [POS]: 1.6, title: 'from-w2' });

    const rep = convergedList([...base, ...ins1, ...ins2]);
    expect(listKeys(rep)).toEqual(['a', 'x', 'b']); // one 'x', no duplicate
    // both inserts stay LIVE siblings (neither cited the other); the FOLD picks the value
    expect(rep.liveAt([...LIST, 'x'])).toHaveLength(2);
    const x = orderedMaterialize(rep, LIST).find((e) => e.key === 'x');
    expect(x?.value).toEqual({ [POS]: 1.6, title: 'from-w2' }); // byTree: hlc 11 wins
  });
});

describe('PROOF LIST(4): move vs move (same element)', () => {
  it('one winner by the register race at [C,k,POS]; the list re-orders accordingly; both orders agree', () => {
    const base = baseListOps([['a', 1, 'A'], ['b', 2, 'B']]);
    const view = viewOf(base);
    const move1 = subtreeGroup(view, 'set', [...LIST, 'a', POS], 'w1', 10, 0.5);
    const move2 = subtreeGroup(view, 'set', [...LIST, 'a', POS], 'w2', 11, 5);

    const rep = convergedList([...base, ...move1, ...move2]);
    const a = orderedMaterialize(rep, LIST).find((e) => e.key === 'a');
    expect(a?.pos).toBe(5); // the fold winner (hlc 11); the deep register overrides the insert's pos field
    expect(listKeys(rep)).toEqual(['b', 'a']);
  });
});

describe('PROOF LIST(5): move vs data edit (same element, disjoint paths)', () => {
  it('both survive: the element carries the new pos AND the new data; both orders agree', () => {
    const base = baseListOps([['a', 1, 'A'], ['b', 2, 'B']]);
    const view = viewOf(base);
    const move = subtreeGroup(view, 'set', [...LIST, 'a', POS], 'w1', 10, 5);
    const edit = subtreeGroup(view, 'set', [...LIST, 'a', 'title'], 'w2', 11, 'edited');

    const rep = convergedList([...base, ...move, ...edit]);
    const a = orderedMaterialize(rep, LIST).find((e) => e.key === 'a');
    expect(a?.value).toEqual({ [POS]: 5, title: 'edited' }); // deep registers graft over the insert value
    expect(listKeys(rep)).toEqual(['b', 'a']);
  });
});

describe('PROOF LIST(6): move vs element delete', () => {
  // world: a (with a real POS register from a prior move), b
  const setup = (): { base: PathOp[]; view: TreeReplica } => {
    const base = baseListOps([['a', 1, 'A'], ['b', 2, 'B']]);
    const world = viewOf(base);
    const move0 = subtreeGroup(world, 'set', [...LIST, 'a', POS], 'w0', 4, 1.2);
    world.ingestAll(move0);
    return { base: [...base, ...move0], view: world };
  };

  it('delete WINS the [C,k] race: the surviving orphan pos register drops from the list, and REVIVES on re-create', () => {
    const { base, view } = setup();
    const move = subtreeGroup(view, 'set', [...LIST, 'a', POS], 'w1', 10, 5); // cites move0's dot
    const del = subtreeGroup(view, 'delete', [...LIST, 'a'], 'w2', 11, undefined); // delete + clear at POS
    expect(del.some((o) => o.kind === 'clear' && pkey(o.path) === pkey([...LIST, 'a', POS]))).toBe(true);

    const rep = convergedList([...base, ...move, ...del]);
    expect(listKeys(rep)).toEqual(['b']); // delete won [C,'a'] (it cited the insert) → element absent
    // the concurrent move was never cited by the clear → live, and set beats clear on kind-class,
    // so the ORPHAN pos register keeps the move as its winner while contributing nothing:
    expect(rep.winnerAt([...LIST, 'a', POS])?.value).toBe(5);

    // re-create by a replica that saw the delete but NOT the orphan move: cites the tombstone only
    const recreate: PathOp = {
      writer: 'w3', hlc: 20, path: [...LIST, 'a'], kind: 'set',
      value: { [POS]: 7, title: 're' }, cites: [{ writer: 'w2', hlc: 11 }], epoch: 1,
    };
    const revived = convergedList([...base, ...move, ...del, recreate]);
    const a = orderedMaterialize(revived, LIST).find((e) => e.key === 'a');
    expect(a?.value).toEqual({ [POS]: 5, title: 're' }); // the orphan pos register RESURFACED over pos 7
    expect(listKeys(revived)).toEqual(['b', 'a']); // ordered by the revived pos 5 > b's 2
  });

  it('delete LOSES the [C,k] race to a concurrent re-insert (ordinary same-class LWW); both orders agree', () => {
    const { base, view } = setup();
    const del = subtreeGroup(view, 'delete', [...LIST, 'a'], 'w2', 11, undefined);
    const reins = subtreeGroup(view, 'set', [...LIST, 'a'], 'w3', 12, { [POS]: 4, title: 'race' });

    const rep = convergedList([...base, ...del, ...reins]);
    const a = orderedMaterialize(rep, LIST).find((e) => e.key === 'a');
    expect(a?.value).toEqual({ [POS]: 4, title: 'race' }); // set (hlc 12) beats tombstone (hlc 11)
    expect(listKeys(rep)).toEqual(['b', 'a']); // pos comes from the re-insert value (POS reg is all clears)
  });
});

describe('PROOF LIST(7): un-bumped whole-list rewrite vs concurrent element edit', () => {
  it('the edit survives GRAFTED into the rewritten list at a deterministic position (categorical survival)', () => {
    const base = baseListOps([['a', 1, 'A'], ['b', 2, 'B']]);
    const view = viewOf(base);
    const edit = subtreeGroup(view, 'set', [...LIST, 'a', 'title'], 'w1', 10, 'edited');
    // rewrite keeps a (new pos), drops b, adds c; un-bumped → its clears do NOT kill concurrent edits
    const rewrite = subtreeGroup(view, 'set', LIST, 'w2', 11, {
      a: { [POS]: 10, title: 'A2' },
      c: { [POS]: 20, title: 'C' },
    });

    const rep = convergedList([...base, ...edit, ...rewrite]);
    const entries = orderedMaterialize(rep, LIST);
    expect(entries.map((e) => e.key)).toEqual(['a', 'c']); // b gone (cleared + absent from the new value)
    // a appears EDITED at the position the rewrite gave it: new list, your edit
    expect(entries[0].value).toEqual({ [POS]: 10, title: 'edited' });
    expect(entries[1].value).toEqual({ [POS]: 20, title: 'C' });
  });
});

describe('PROOF LIST(8): rebalance = epoch-bumped POS-ONLY sweep', () => {
  const base = baseListOps([['a', 1, 'A'], ['b', 2, 'B']]);
  const view = viewOf(base);
  const reb = rebalanceGroup(view, 'admin', 11); // a → 100, b → 200, all epoch-bumped
  it('rewrites ONLY the [C,k,POS] registers (the pos-only shape is load-bearing for obligation 8b)', () => {
    expect(reb.length).toBe(2);
    expect(reb.every((o) => o.kind === 'set' && o.path[o.path.length - 1] === POS)).toBe(true);
    expect(reb.every((o) => (o.epoch ?? 0) === 2)).toBe(true); // observed floor 1, bumped to 2
  });

  it('KILLS a concurrent move even at higher hlc (epoch outermost); both orders agree', () => {
    const move = subtreeGroup(view, 'set', [...LIST, 'a', POS], 'w1', 12, 999); // hlc 12 > 11, epoch 1
    const rep = convergedList([...base, ...reb, ...move]);
    const a = orderedMaterialize(rep, LIST).find((e) => e.key === 'a');
    expect(a?.pos).toBe(100); // the bumped pos won the fold; the move is dead
    expect(listKeys(rep)).toEqual(['a', 'b']);
  });

  it('LEAVES a concurrent data edit untouched (different paths); both orders agree', () => {
    const edit = subtreeGroup(view, 'set', [...LIST, 'b', 'title'], 'w3', 13, 'kept');
    const rep = convergedList([...base, ...reb, ...edit]);
    const b = orderedMaterialize(rep, LIST).find((e) => e.key === 'b');
    expect(b?.value).toEqual({ [POS]: 200, title: 'kept' }); // rebalanced pos AND the edit, both present
  });
});

describe('CHARACTERIZATION LIST(9): concurrent RUNS into the same gap INTERLEAVE (accepted anomaly)', () => {
  // Fractional indexing's known interleaving anomaly: two writers each insert a run of
  // elements into the same gap; both independently compute the same midpoint sequence, so
  // the merged order alternates p1,q1,p2,q2,... instead of keeping either run contiguous.
  // ACCEPTED for object lists (elements are independent records; adjacency is not meaning),
  // and it is exactly why collaborative TEXT stays OUT OF SCOPE for this container: text
  // needs run integrity (RGA/sequence CRDT territory), which this design does not claim.
  it('the interleaved order is nonetheless deterministic and identical across arrival orders', () => {
    const base = baseListOps([['a', 1, 'A'], ['b', 2, 'B']]);
    const view = viewOf(base);
    const run = (writer: string, prefix: string, hlc0: number): PathOp[] => {
      // sequential midpoints into the gap (1, 2): 1.5, then 1.75, then 1.875
      const out: PathOp[] = [];
      let lo = 1;
      const hi = 2;
      for (let i = 1; i <= 3; i++) {
        lo = (lo + hi) / 2;
        out.push(
          ...subtreeGroup(view, 'set', [...LIST, `${prefix}${i}`], writer, hlc0 + i, {
            [POS]: lo, title: `${prefix}${i}`,
          }),
        );
      }
      return out;
    };
    const rep = convergedList([...base, ...run('w1', 'p', 10), ...run('w2', 'q', 20)], 8);
    // the runs are INTERLEAVED (equal midpoints, per-element dot tiebreak), not contiguous:
    expect(listKeys(rep)).toEqual(['a', 'p1', 'q1', 'p2', 'q2', 'p3', 'q3', 'b']);
  });
});

describe('PROOF LIST(10): duplicate delivery of whole insert/delete/rebalance groups is idempotent', () => {
  it('once vs duplicated-and-shuffled groups materialize the identical ordered list', () => {
    const base = baseListOps([['a', 1, 'A'], ['b', 2, 'B']]);
    const world = viewOf(base);
    const edit = subtreeGroup(world, 'set', [...LIST, 'a', 'title'], 'w1', 10, 'edited');
    world.ingestAll(edit);
    const reinsert = subtreeGroup(world, 'set', [...LIST, 'a'], 'w2', 11, { [POS]: 3, title: 'A2' });
    world.ingestAll(reinsert); // observed the edit → this group carries a clear (multi-op insert group)
    expect(reinsert.some((o) => o.kind === 'clear')).toBe(true);
    const del = subtreeGroup(world, 'delete', [...LIST, 'b'], 'w1', 12, undefined);
    world.ingestAll(del);
    const reb = rebalanceGroup(world, 'admin', 13);
    world.ingestAll(reb);

    const all = [...base, ...edit, ...reinsert, ...del, ...reb];
    const once = deliver(all, 1);
    for (let order = 1; order <= 5; order++) {
      const dup = deliver([...all, ...reinsert, ...del, ...reb, ...del], order * 13 + 1);
      expect(listSig(dup)).toBe(listSig(once));
    }
    // and the final state is the intended one: a alone, re-inserted value, rebalanced pos
    const a = orderedMaterialize(once, LIST);
    expect(a.map((e) => [e.key, e.value])).toEqual([['a', { [POS]: 100, title: 'A2' }]]);
  });
});
