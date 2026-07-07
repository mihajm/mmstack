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
  private readonly best = new Map<string, Op>(); // highest-hlc op per writer
  private readonly water = new Map<string, number>(); // highest cited hlc per writer

  ingest(op: Op): void {
    for (const c of op.cites) {
      this.water.set(c.writer, Math.max(this.water.get(c.writer) ?? 0, c.hlc));
    }
    const cur = this.best.get(op.writer);
    if (!cur || op.hlc > cur.hlc) this.best.set(op.writer, op);
  }
  live(): Op[] {
    const out: Op[] = [];
    for (const [w, op] of this.best) {
      if (op.hlc > (this.water.get(w) ?? 0)) out.push(op);
    }
    return out.sort((a, b) => (a.writer < b.writer ? -1 : a.writer > b.writer ? 1 : 0));
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
