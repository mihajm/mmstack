# Conflict precedence, agent governance, and the branch-first AI story

**Status:** design record from a critical review conversation (2026-07-06, after the opSync
local-pending-as-branch refactor + durable outbox + cross-tab lock shipped). Nothing here is built.
Captures decisions + traps so a next agent inherits the reasoning, not just the conclusions. Refines
the creed's "an agent is a user" (op-protocol-rfc.md §0) and extends branching-state.md.

## 0. Framing (why this note exists)

The review surfaced that the current design leans on HLC last-writer-wins for conflict resolution and
frames the AI story as "agent-as-live-peer". Both are defensible for the 90% but leave gaps the
priority consumers (Better / CMMN, medical over openEHR/FHIR) will hit. None of the gaps are corners
we wired ourselves into; all are additive expansions. This note names where each plugs in and the one
trap that turns an expansion into a causal-correctness bug.

## 1. Conflict precedence / governance (the real generalization of "AI is a user")

The need is NOT AI-specific: apps want deterministic precedence rules for a concurrent same-path
conflict — `admin overrides all`, `document creator wins`, `edit beats edit by role`, or a DYNAMIC
"chief" the users elect. LWW-by-clock is just the degenerate (everyone equal, recency decides).

**CRITICAL — rank should be a dynamic EPOCH (Raft-style term), not a static priority tier (Fable
2026-07-06; PROVEN + REFINED 2026-07-07 by the model in
`packages/primitives/src/lib/store/precedence-proofs.spec.ts`).** Fable's "a static tier BRICKS the
register forever / owner-only after the first override" framing is IMPRECISE — the proof shows the real
picture: under the dot-citation register a CAUSAL write (one that observed + superseded the value) ALWAYS
wins regardless of rank, so the field is NEVER permanently locked (it stays editable by writing on top).
Static rank's actual limitation is exactly two things, both proven: (1) DE-ESCALATION — a low-rank
"release" write LOSES to a CONCURRENT higher-rank op, so the higher value resurrects; and (2) no
authority-SETTLED read signal. Epoch fixes both — that is the real reason to prefer it, not "prevents
bricking." Sound model: writers stamp ops with the highest EPOCH they've observed; within an epoch,
`(hlc, writer)` breaks ties; a privileged writer OVERRIDES by writing at epoch+1; later normal writes
adopt the new epoch and compete normally again. So the MV-register precedence fold is `max by (epoch,
hlc, writer)`.

**EMISSION-RULE PRECISION (proven 2026-07-07 precedence-proofs.spec.ts; Fable-CONFIRMED 2026-07-07).**
"Highest epoch observed" MUST include the writer's OWN prior epoch: `epoch := max(cited-dot epochs, this
writer's own prior epoch AT THIS PATH)`, i.e. a writer's per-path epoch is monotone-non-decreasing. The
naive "adopt max CITED epoch" is INSUFFICIENT and provably breaks monotonic-reads — a writer writes at
epoch 3, then later writes citing only epoch-1 dots, and since a writer's newer op replaces its older in
the sibling map (best-by-hlc), the epoch-3 value vanishes and the exposed epoch drops 3→1 (property test
FAILS naive, PASSES corrected; the ill-formed counterexample is pinned as a permanent proof). Fable's
reasoning: exposed-epoch monotonicity at read IS per-writer epoch monotonicity, because best-by-hlc means
a writer's newer op REPLACES rather than coexists; the citation set alone can't guarantee it.
- **Epoch is scoped PER-PATH** (confirmed). Epoch is causal-supersession metadata for a register, so it
  belongs to the path's causal context, like the dots. Per-writer-GLOBAL would break disjoint-path
  independence: one authority bump on path X would inflate the writer's epochs store-wide → spuriously
  supersede concurrent writes on unrelated path Y → unbounded epoch inflation, no payoff. Corollary:
  per-path epoch MUST survive a tombstone→re-create of the path (see §4 delete semantics), or revival
  regresses.
- **Three emission subtleties (Fable):** (a) the authority +1 BUMP is also per-path: `max(observed-at-path)
  + 1`, else a bump on one path outranks concurrent writes elsewhere. (b) An UNauthorized writer merely
  CARRYING the observed high epoch forward (never bumping) is not just fine but REQUIRED — carrying
  preserves monotonicity without granting supersession power (it can only TIE the epoch it saw; hlc/dot
  breaks ties). (c) Emission reads own-prior from the writer's OWN EMISSION FRONTIER, not the merged/exposed
  view; and SYNTHESIZED ops (seed / hydration / snapshot replay) MUST honor the same own-prior-at-path floor,
  or seeding regresses exposed epochs exactly like the naive counterexample (ties the seed contract to this
  rule).

This UNIFIES three things into one mechanic: **owner-authority** (the worker owner "vetoes"
by writing at epoch+1 — see the worker plan in roadmap.md, the fork is false, no shim), **admin-override**,
and **dynamic-chief** — a privileged writer overrides WITHOUT permanently locking the field, and the
winning op's epoch tells a reader whether the value is authority-SETTLED (the sync-at-read confirmation +
effect-gating seam). Policy binds epoch-bump rights to a writer identity; the epoch stays an opaque
scalar, the who-may-bump rule is local. (The "inheritance" fix below was for a static rank in a
single-winner register; with the epoch + MV-register it is subsumed.)

**Cite-supersession is RANK-INDEPENDENT (proven + Fable-confirmed 2026-07-07).** Supersession is a
statement about CAUSAL knowledge ("I saw this op and am replacing it"); rank is a statement about RACE
resolution ("when neither of us saw the other, higher wins"). Orthogonal lattice dimensions — keep them
orthogonal. Rank-GATING (a low-rank write can't supersede a high-rank sibling) is WRONG: it breaks the
proven theorem (the live set stops being the maximal antichain of the delivered causal order → causally-
dominated-yet-live ghosts, forcing transitive-closure watermarks or order-dependent hazards). So epoch's
job is de-escalation + authority-settled reads, NOT anti-bricking. THREE holes to name in the RFC (none
fatal; all proven in precedence-proofs.spec.ts where modelable):
1. **Rank ≠ authority.** Any peer that syncs first can cite-and-win; in a fully-online net every write is
   causal so rank NEVER fires (rank only wins races). "Students can't overwrite the teacher" is ADMISSION
   CONTROL — enforce writer/rank at the RELAY policy layer (op rejected at ingest, `mesh-protocol
   policy.ts`), NEVER in the merge function. Forged citations of a high-rank dot are the same layer's job.
2. **High-rank effects are non-durable.** An admin "freeze" is un-frozen by the next causal edit from
   anyone. Sticky-until-cleared-by-equal-rank = a separate LOCK register or an epoch bump, NOT gated
   supersession on the value register. Don't conflate the two lattices.
3. **Stale high-rank resurrection.** A partitioned high-rank device can surface an OLD-hlc op days later;
   it cites nothing recent, nothing cites it → live sibling → wins the fold → value jumps BACKWARD (proven).
   Epoch closes it: an epoch bump kills prior-epoch ops REGARDLESS of citation — and that bump is the ONE
   legitimately rank-gated operation (fine, because it is a scoped, explicit authority act, not a
   per-value merge rule).

**The design = rank in the GLOBAL order + INHERITANCE ON OVERWRITE (Fable, 2026-07-06 — this CORRECTS
an earlier "rank only in the concurrent branch" design that was non-convergent; the trap is below).**
Add an opaque `rank` scalar to the envelope, stamped AT EMISSION. Rank goes into the GLOBAL total order,
one comparator: the register winner is `max` under `(rank, hlc, writer, origin)`, subtree dominance
included. The causal-safety trick that makes "rank first" correct is INHERITANCE: at emission, stamp
`rank = max(writerRank, rank of the register value being overwritten)`. Causal successors carry rank
forward exactly the way HLC carries time forward.
- A causally-later LOW-rank write that overwrote a HIGH-rank value INHERITS high → it beats the stale
  high-rank value it replaced. No causal violation: the nurse's correction, having SEEN the admin's
  value, inherits the admin's rank, so it sticks.
- CONCURRENT writers never saw the value → they don't inherit → rank genuinely breaks true concurrency.
- Convergent by construction: `max` over a total order computable from the envelope ALONE
  (associative/commutative/idempotent) — the join-semilattice property is intact.

**THE TRAP that forced this (do NOT revert to the "obvious" design):** the tempting design — "apply rank
ONLY when the two writes are concurrent (in `resolveConcurrent`), keep `beats()` hlc-based so a
causally-later write is never overridden" — DIVERGES. It induces a Condorcet CYCLE: A(hi), B(built on A,
lo → B≻A by succession), C(concurrent, lo → C≻B by hlc, but A≻C by rank) gives B≻A≻C≻B, non-transitive.
A single-winner register that discards losers is a knockout tournament, and a tournament under a cyclic
relation depends on match (arrival) order → the SAME op set converges to different values. No local fix
(buffering, a smarter `concurrentWith`, re-check on arrival) repairs it — the cycle is in the RELATION.
Root reason: "rank breaks concurrency only" requires EVALUATING concurrency, a property of the causal
partial order the envelope (hlc + `prev`-hint) can't carry faithfully (`prev ≠ current value` is a lossy
proxy with ABA/value-identity issues). Convergence needs a total order from the envelope alone — which
either puts rank before hlc (overrides causally-later) or after (rank never matters). Inheritance is the
escape: rank FIRST, but successors inherit it, so "before hlc" no longer means "overrides causally-later".

**Semantic delta (defensible — name it in docs):** the winner is "a value a high-rank writer TOUCHED
stays protected from writers who never saw it," NOT "the literal highest-rank concurrent op." In the
A/B/C example the literal answer is C; inheritance gives B (carrying A's authority). That is arguably the
RIGHT policy for admin-override/creator-wins, and it is the ONLY convergent single-register semantics
that respects causal succession AND lets rank matter.

**One ratchet to design around:** rank on a path is MONOTONE under inheritance — an admin cannot
"release" a field by writing it low-rank (a stale HIGH op would resurrect over the low one). If release
matters, add an epoch/generation field bumped on a rank-LOWERING write, ordered `(epoch, rank, hlc,
writer)`.

**Dynamic "chief":** rank-at-write-time vs rank-now. As-of-NOW breaks order-independence → the envelope
carries the author's rank AS OF EMISSION; role changes are NOT retroactive (the only order-independent
choice). Carry rank as an OPAQUE scalar, not a role string (privacy — same discipline as `writer`, §3).

**Option B — the MV-register (Fable-designed 2026-07-06, THE PATH WE'RE BUILDING; it is LIGHT, not
version vectors, and it makes ranking a trivial fold so inheritance/Option A is only the fallback if you
deliberately do NOT build this).** The insight: HLC alone is unsound for identifying siblings (HLC gives
causality⇒order, never order⇒causality; and the `prev` VALUE-hint can't rescue it — ABA: identical
values from distinct ops are indistinguishable). So carry causality EXPLICITLY, but scoped per-path, at
register-local cost — dotted-VV SEMANTICS without version vectors:
- **Envelope:** each set/delete gains `cites: Array<{writer, hlc}>` — the dot(s) of the sibling(s) the
  writer OBSERVED at that path when it wrote (common case: 1 = the current winner's dot). The op's own
  dot `(writer, hlc)` you already have. The `prev` value-hint is subsumed FOR SUPERSESSION ONLY — do NOT
  drop it: `prev` remains the inversion basis for undo/rebase/boot-replay (`invertBatch`, op-log.ts:215;
  Opus catch 2026-07-07). CORRECTION (ruling 2026-07-07, see §5 origin note + invariants #23): the dot is
  really `(origin, hlc)` — writers are shared across origins in the shipped system, so writer-keyed dots
  collide across tabs; the model's `writer` field plays the origin role.
- **Register per path:** `siblings: Map<writer, {hlc, value}>` (a writer's newer op dominates its own
  older → ≤1 live candidate per writer) + `superseded: Map<writer, hlc>` watermarks. An incoming op kills
  its own writer's older entry, marks every cited dot's watermark, and DIES on arrival if its own hlc ≤
  its writer's watermark. Live siblings = entries above their watermark, uncited. Watermark compression
  is sound because per-writer ops are totally ordered; it is also delivery-order-robust (a cite arriving
  before the op it kills just parks in the watermark — no causal-delivery requirement). Cost O(live
  siblings)/op, prunable below a stability frontier (the relay ack / seed checkpoint is the pruning seam).
- **Retention is UNIFORM; the policy is a pure FOLD over the `(value, dot)` sibling set** (converges for
  any fold that is a function of the SET, never arrival order): LWW default = max by `(hlc, writer)`
  (today's behavior = the trivial fold, clean migration); RANKING = max by `(rank, hlc, writer)` — the
  ABA/inheritance problem VANISHES because supersession is by dot, not stamp; PRESERVE = `Conflicted{N
  siblings}` when N>1 (a resolution write cites all N dots, collapsing the set); KEYEDARRAY = identity-
  merge the N sibling arrays by key with a deterministic per-key inner rule `(hlc, writer)`.
- **Store + live wire stay SINGLE-VALUE:** MV lives entirely in the register layer. At apply: recompute
  the fold; if it equals the currently-materialized value, SKIP the write (preserves copy-on-write
  reference identity even when siblings churned). Synchronous reads unchanged. The wire is still one op
  per message; the only shape change is `cites`.
- **Two honest leaks:** (1) `opSync.seed()` / fresh-room snapshot MUST ship register state (siblings +
  watermarks) for conflicted paths, not just materialized values, else a joiner can't correctly supersede
  later writes → a SEED-CONTRACT version bump. (2) `preserve` leaks by design: `Conflicted` surfaces as a
  materialized marker OR a per-path SIDE SIGNAL — pick one; the side-signal keeps the store type clean
  (Fable leans there).
- **LANDMINE — RESOLVED 2026-07-07 (see §5 origin ruling / invariants #23):** dots need unique replica
  ids; resolved by keying the dot on `(origin, hlc)` rather than writer (origin is per-replica unique by
  definition). What remains: per-TAB origin uniqueness under tabSync (cross-tab lock / leader
  serialization) and no origin reuse across crash/clone (#24).

**Net for tomorrow:** envelope +2 fields (`cites` AND `epoch` — epoch is stamped at emission per §1's
rule and is NOT derivable from cites; the "+1 field" phrasing in earlier notes undercounts), register
state per path (sibling + watermark maps, entries carry epoch), a fold plug-point with LWW as default,
a seed-contract bump, the replica-id-per-tab check, PLUS the relay compaction contract (§7). NO version
vectors, NO multi-value wire, NO store-type change except opt-in preserve surfacing. Convergence MUST be
property-tested (op-sync.spec already has the 3+-concurrent harness + the `preserve`/`keyedArray`
characterization tests that FLIP to converge when this lands).

**Cost of A (inheritance, the single-register fallback):** proto bump (rank field) + inheritance-stamp
at emission + `beats()` widened to `(rank, hlc, writer, origin)`. Only relevant if you're NOT building
the MV-register; since B is imminent and fixes ranking + preserve + keyedArray together, B is the fit.

**PROVEN 2026-07-07 — `packages/primitives/src/lib/store/precedence-proofs.spec.ts`** (pure reference
model, NO impl dependency, so the next agent builds against validated math). Mathematically established:
(1) the dot-citation register's live-sibling SET is a pure function of the delivered op set → converges
under ANY arrival order, incl. cites-before-ops and duplicates (50 seeds × 24 orders); (2) any fold over
the live set (lww / rank / epoch) is order-independent → the materialized value converges; (3)
IMPOSSIBILITY — identical `(writer, hlc)` stamps + different cites yield different truth, so HLC + prev-
value alone cannot identify siblings (cites are load-bearing); (4) the naive "rank only in the concurrent
branch" single-winner register DIVERGES (the A≻C≻B≻A Condorcet cycle, same op set → different value by
order); (5) static-tier vs epoch behavior exactly (the refinement above). DEFERRED to impl (needs the
real register first): wiring into opSync's `createConvergingApply`, the seed-contract state ship,
GC/pruning below the stability frontier, and the `preserve`/`keyedArray` characterization tests flipping
to converge (op-sync.spec).

## 2. Branch-first AI: "an agent is a user, confined to a branch you review"

The creed's "an agent is a user" is ~70% right and understates two asymmetries the "just a narrower
user" phrasing launders:

- **Velocity** — an agent emits ops orders of magnitude faster than a human. LWW + an unblinking agent
  = the agent dominates every scalar race and floods the journal. Rate-limiting (relay token bucket)
  caps throughput but is NOT conflict fairness. §1 precedence is the real lever.
- **Reversibility of intent** — a human write is a considered act; an agent write is a probabilistic
  sample that may be wrong. Same WRITE authority as a human, straight into the shared room, is the
  wrong default. Humans need OVERSIGHT primitives: propose, don't commit.

The stronger AI story is therefore **agent-on-a-branch, human-approves-the-rebase**, not
agent-as-live-peer. And the key finding: **this is composable TODAY** from shipped primitives —
`forkStore` + `Fork.ops()` + `policyStrategy`. Pattern:

1. Agent writes to a LOCAL fork (not mesh-synced).
2. `fork.ops()` is the reviewable proposed diff.
3. Approval = `commit()` into the base store that IS `meshSync`-synced → the approved ops emit.

Missing is only ergonomics: `branch.run()` sugar (deferred, branching-state.md), a documented pattern,
and optionally a "fork stays unsynced until commit" mesh helper. So the branch-first story is a
documented-pattern-away, not a future capability. **Positioning decision: lead the docs/README with the
branch, not the peer.** The branchable functional core is the differentiator; agent-as-peer is the demo.

CMMN/medical raises the stakes on both §1 and §2: you cannot have an agent silently win an LWW race on
a dosage field. Precedence (concurrent-only) + branch-review (propose/dispose) are the two answers, and
they compose — an agent proposes on a branch, a clinician disposes, and where they DO write concurrently
the rank rule (not the clock) decides.

**`fork.commit()` is an EMISSION path (Fable 2026-07-07).** Under the MV-register, ops committed from a
fork must (a) cite the dots the fork OBSERVED at fork/last-rebase time — not the base's current dots —
and (b) honor the epoch own-prior-at-path floor (#20's synthesized-op rule applies to commit exactly as
to seed/hydrate). This is not a burden, it is the free correct semantics: the agent never saw the human
edits that landed mid-flight, so its committed ops are TRUE CONCURRENT siblings and the fold (not
arrival order) decides — a human edit is never silently steamrolled by an approval click. Wire commit
through the same emission rule as live writes; do not special-case it.

## 3. Provenance vs privacy — extend the opaque-`writer` discipline to rank

`writer` is an opaque principal pseudonym; natural identity never enters the envelope, and identity is
an EXTERNAL join table. This is the right design and was blessed in review: an append-only log can't be
deleted from, but the identity MAPPING can be severed → GDPR right-to-erasure is clean (the journal
stays intact and anonymous), agents keep a mapping for accountability, humans can drop theirs. The
system enforces pseudonymity-by-construction; identity layers on top.

Two residuals to hold:

- **Rank must also be an opaque scalar, not a role string.** The moment §1 precedence needs a rank in
  the envelope, a role LABEL (`chief-cardiologist-ward-3`) is re-identifying PII inside the log you kept
  anonymizable. Carry an opaque priority NUMBER, joinable to role externally — the same discipline
  already applied to `writer`. Privacy-preserving AND order-independent.
- **Provenance-integrity is explicitly userland.** The auditable join ("who is writer X") lives in a
  table the log does NOT guarantee. State that; don't imply the log enforces provenance. It enforces
  anonymity; provenance-integrity is the app's.

## 4. Known tensions ledger (acknowledged in review, deferred — not bugs, boundaries)

- **Arrays travel whole-value.** `keyedArray` only shapes conflict RESOLUTION; the wire still ships the
  whole array → O(array) envelope per list edit. Fractional-index / RGA positional CRDT is the deferred
  upgrade. Dogfooding (next month) is the likely forcing function; do NOT let it surprise a list-heavy
  consumer.
- **LWW is the default → silent same-field loss by default.** `preserve` (Conflicted-as-data, jj-style)
  is the escape hatch and the medical-side choice, but defaults are destiny — most devs won't reach for
  it. The safe-by-default instinct applied to the cross-tab lock (loud-wait over silent-divergence) is
  the instinct MISSING from the conflict default. Revisit whether `preserve` or a warn should be more
  prominent for high-stakes paths.
- **Relay-root and client-root can legitimately disagree.** ~~The relay folds ops in SEQ order; clients
  converge in HLC order...~~ DISSOLVED 2026-07-07 by §7: under the MV-register the relay runs retention
  only and never materializes a value, so there is no relay-root to disagree with. Until the MV-register
  lands the corner still exists in the shipped system — the harness scenario remains worth having as a
  characterization until then.
- **`preserve` and `keyedArray` DIVERGE under 3+ concurrent writers to one path (found 2026-07-06,
  shipped bug — VERIFIED by property test).** The single-winner register merges a policy PAIRWISE, so
  convergence needs the merge associative/commutative. `lww` and `mergeThree` are (property-test
  confirmed). `preserve` is BINARY (a 3rd concurrent writer nests Conflicted-in-Conflicted
  order-dependently) and `keyedArray`'s pairwise item-merge is not associative (item order + theirs-only
  additions depend on which side is "mine" at each step) → both diverge by arrival order. Two concurrent
  writers are fine; 3+ is the hazard. This is the SAME class as the ranking Condorcet trap (§1) and has
  the SAME fix — the MV-register (Option B §1): retain all causally-maximal concurrent siblings per path,
  resolve at READ, which converges because the sibling set is a pure function of the delivered op set.
  So ranking + preserve + keyedArray all point at one architecture upgrade. SHORT-TERM: characterization
  tests lock the current divergence (op-sync.spec, "3+ CONCURRENT same-path writes", flips when the
  MV-register lands); docs should carry a "2 concurrent writers max for preserve/keyedArray on a hot
  path" caveat until then. The single-winner register is fundamentally limited to 2-way-associative
  policies.

## 5. Cross-path (subtree) dominance under the MV-register — a REDUCTION, not new machinery (Fable 2026-07-07)

**The gap this closes:** the proven model (`precedence-proofs.spec.ts`) is SINGLE-PATH — its `Op` has no
`path`, no dominance, no delete. The real `createConvergingApply` (op-sync.ts:275-314) does full
ancestor/descendant work: dominated-by-ancestor REJECTION walking the prefix chain, plus a descendant
sweep that DELETES beaten registers and REPLAYS surviving ones, all by stamp `beats`. Today's tree-LWW
is sound because everything reduces to ONE total stamp order — the value at a leaf is the max-stamp op
among {exact-path, all covering ancestors}, a pure function of the set. The MV-register BREAKS that
premise: supersession is by CITATION, not stamp, and nothing in the per-path proof says how citations
relate across the ancestor relation. This is the same class of "composition assumed safe" that produced
the Condorcet bug — so it gets a stated design + model obligation BEFORE impl, not an improvisation
mid-build.

**The design — subtree write = observed-remove of the subtree + set; dominance machinery is DELETED.**
(AMENDED under proof pressure, same day: the first draft emitted per-path DELETES for observed
descendant registers — WRONG, and the model shows why: a delete's tombstone, when it wins its register's
fold, grafts "key ABSENT" at materialization and erases the very key the fresh ancestor value
legitimately contains — a plain uncontended subtree replace would delete its own fields. The fix is a
THIRD op kind, `clear`: mechanically identical to delete (cites + sibling + fold competition), but a
winning clear ABSTAINS at materialization — the register contributes nothing and the ancestor value
shows. DELETE = observed-remove of a KEY; CLEAR = observed-remove of a REGISTER. A dot-matching hack —
"skip a tombstone whose winner dot equals the ancestor winner's dot" — fails under two concurrent
replaces: the loser's tombstone would erase the winner's key. Pin both counterexamples in the model.)

- **Emission.** A set at path A emits, in ONE envelope: `set A` citing A's live dots, PLUS one `clear D`
  per live descendant register D under A in the emitter's OWN register map (each citing that register's
  live dots; skip registers already fold-abstaining). "Own register map" = the emission frontier, same
  discipline as §1's epoch rule. EPOCHS IN THE GROUP are per-path (#20a): each clear carries
  `max(observed-at-D, own-prior-at-D)` — plus 1 each if this is a BUMPED (authoritative) replace; the
  authority bumps every path it clears, explicitly, one epoch per register. Un-bumped, clears CARRY.
- **Ingest.** Every op lands in its own per-path register, unconditionally. NO dominated-rejection, NO
  descendant sweep, NO replay sort — that code is deleted, not ported. Cross-path never enters the
  register mechanics; cites stay path-local (within one envelope a writer emits at most one op per path,
  so `(writer, hlc)` dots stay unambiguous per register).
- **Default fold gains a KIND-CLASS tier:** max by `(epoch, kind-class, hlc, writer, origin)` with set =
  delete > clear on kind-class. Still a total order computable from the op alone → convergence untouched.
  This makes the semantic delta CATEGORICAL: at equal epoch a concurrent descendant SET always beats a
  clear (survival is not an hlc race); a BUMPED clear beats a lower-epoch set (epoch stays outermost,
  #20). Delete-vs-set stays the standard same-class LWW race. ORIGIN RULING (2026-07-07, invariants #23):
  origin STAYS in the order as the final strictness tiebreak and the DOT is `(origin, hlc)` — the shipped
  system shares writers across origins (op-sync.ts:210's own comment), so writer-keyed dots would collide
  across a user's tabs; sibling map + watermarks + epoch own-prior are all per-ORIGIN, and the Part 2
  model's `writer` field plays the origin role. Writer stays the principal for policy/ACL binding and the
  human-meaningful fold preference; it is NOT the replica identity.
- **Materialization = deepest-live-wins.** Tree value = start from the base, apply register folds
  shallow→deep (deterministic path order), grafting each register's fold value at its path; a winning
  DELETE grafts "key absent"; a winning CLEAR grafts NOTHING (abstains). TYPE-CHANGE RULE
  (deterministic, chosen): if the already-materialized parent location is not a container, the graft is
  DROPPED at materialization (the register stays intact — it resurfaces if a later ancestor value
  restores the container shape). Any deterministic choice converges; this one is the least surprising.

**Why it converges:** each per-path register is convergent by the proven theorems, UNCHANGED — the
reduction adds zero new register mechanics. Materialization is a pure function of the register states,
which are pure functions of the delivered op set → the TREE is a pure function of the delivered set.
Envelope atomicity is NOT required for convergence (each op of the delete-group is independently
convergent); atomicity only shapes the transient (a set-at-A landing before its deletes shows old
descendant values grafted onto the new subtree for a moment). Envelopes are already the atomic wire
unit, so in practice there is no transient either.

**The semantic delta — name it in docs, it CHANGES today's behavior:** a concurrent descendant edit
SURVIVES an un-bumped ancestor replace — categorically: its dot was never observed → never cited → live,
and on kind-class a set beats a clear at equal epoch — where today the stamp order can silently swallow
it. Replace-`settings` vs concurrent edit-`settings.theme` now merges to "new settings, your theme" —
the merge humans actually want, and the same observed-remove philosophy as §6. The old swallow-
everything behavior remains available where it is MEANT: an epoch-BUMPED subtree replace clears
concurrent descendant edits too, because its per-path clears carry bumped epochs and the concurrent
lower-epoch set loses the descendant register's fold to the clear (§1 fold, epoch outermost). So:
un-bumped replace = polite merge; bumped replace = authoritative clear — exactly the worker owner's
veto-over-subtree, from the same one mechanic, no shim.

**Cost:** envelope grows by O(live descendant registers under A at emission) clear ops — bounded by the
live-register count (pruned below the stability frontier; extends #21's boundedness story, does not
break it). Wire vocabulary grows by ONE kind (`clear`) next to set/delete.

**Model obligations — ALL PROVEN same day (`precedence-proofs.spec.ts` Part 2, 13 tests):**
(a) tree materialization = pure function of the delivered op set under any arrival order, including
replace-groups delivered split and duplicated (30 seeds × 10 orders); (b) concurrent subtree-replace vs
descendant-edit → descendant survives un-bumped (CATEGORICALLY — a lower-hlc edit survives too), cleared
when bumped; (c) two concurrent subtree replaces converge (fold decides at A; both clear-groups compose
— and the DELETE-based first draft provably erases the winner's keys, PINNED as a permanent oracle,
along with the uncontended self-erasure that forced clear in the first place); (d) a LATE descendant op
arriving after an applied ancestor replace converges identically to every other order; (e) type-change
graft determinism (edit under a deleted parent drops, revives on container re-create). The Part 2 model
IS the spec for the impl — build `createConvergingApply` against it, then re-point the property tests
per invariants #14.

## 6. Delete semantics — STATED (resolves the §4 ledger entry + invariants #19's choice)

Deletes are in the op vocabulary TODAY (`kind: 'delete'` throughout op-sync.ts), so the MV-register
meets them on day one — this choice cannot ride behind the impl. Chosen semantics:

- **A delete is an ordinary op: cites + a TOMBSTONE value in the sibling map.** Observed-remove applies
  to SUPERSESSION: a delete kills exactly the dots it cites; a concurrent (uncited) set stays live.
- **Among live siblings the fold treats the tombstone as a value** — LWW default: max `(epoch, hlc,
  writer)` may pick the tombstone (register-level delete-vs-set stays the standard register race, the
  moral equivalent of today's `winner.kind === 'delete'` handling). True add-wins/element-granular
  removal is keyedArray/RGA territory and stays explicitly DEFERRED (§4 arrays bullet) — do not smuggle
  it into the register.
- **A subtree DELETE is a group like a subtree replace (§5):** `delete A` (tombstone at A — the key goes
  absent) + `clear D` per observed live descendant register. A concurrent descendant edit stays live in
  its register but its graft lands under a deleted parent → DROPPED at materialization by the
  type-change rule; it RESURFACES if the path is re-created as a container. Name that in docs — it is
  observed-remove doing exactly what it says, but it will surprise someone.
- **The register (watermarks + epochs) PERSISTS after a tombstone wins.** A re-create write cites the
  tombstone dot and adopts `max(cited epochs, own-prior-at-path)` → the per-path epoch floor survives
  tombstone→re-create, discharging §1's corollary by construction.
- **Tombstone lifecycle = the ordinary GC story:** a register whose below-frontier live set is a lone
  tombstone is droppable at prune (the relay's delete-folding analogue, §7). Post-prune epoch reset is
  the documented #20 GC nuance, safe under #18(b) admission-reject.
- **Model obligation:** add deletes to the proofs model; prove concurrent set-vs-delete-vs-set under 3+
  writers converges (the exact divergence class of the §4 preserve/keyedArray bug), and
  tombstone→re-create preserves the epoch floor.

## 7. The relay under the MV-register — retention yes, fold NEVER (sharpens invariants #17)

The decisive argument, stronger than "risky": **the fold is CLIENT-CONFIGURED POLICY** (lww / rank /
preserve / keyedArray, per app). The relay cannot know the app's fold, so a value-folding relay is wrong
BY CONSTRUCTION — not a divergence hazard but a category error. Meanwhile RETENTION is uniform and
policy-free (§1 Option B: keep the causally-maximal set — proven fold-independent). Therefore:

- **The relay runs RETENTION ONLY.** Its compaction maintains per-path register state (siblings +
  watermarks + epochs) by the same pure ingest rules the client runs — shipped as a compile-asserted
  structural twin in mesh-protocol, the exact pattern already used for the L0 wire types. It NEVER
  materializes a value.
- **Snapshot / welcome-DELTA / seed = a register-state checkpoint**, not a value tree. Joiners hydrate
  register state and fold locally with their own policy. This IS the seed-contract bump — one format,
  client seed() and relay snapshot aligned (#17's equation becomes assertable end-to-end).
- **Delete folding** in relay compaction becomes: drop registers whose below-frontier live set is a lone
  tombstone (§6 lifecycle) — semantics-free, no fold involved.
- **Dividend:** the §4 "relay-root vs client-root can legitimately disagree" ledger tension DISSOLVES —
  the relay no longer has a root value to disagree with; the previously-unproven corner ceases to exist
  rather than needing a proof. (Different clients with different FOLDS still read different values from
  identical register state — that is per-app policy divergence, deliberate and documented, not a sync
  bug. Peers in one room should share a fold config; the schemaVersion/policyVersion gate is the natural
  place to pin it.)
- **Work-list consequence:** the relay compaction + welcome path is part of the SAME change as the
  primitives register (roadmap net updated). Landing the client register against a value-folding relay
  seeds every late joiner into permanent divergence (#17) — the one sequencing mistake this section
  exists to prevent.

Relates to [[op-protocol-rfc]] §0 creed, [[branching-state]], [[mesh-sync]] (trust model),
[[opsync-internals]] (the heart these decisions sit on), [[invariants]] (#15, #17, #19, #20, #33).
