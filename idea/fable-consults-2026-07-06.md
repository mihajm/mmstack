# Fable consults — 2026-07-06 (verbatim archive)

Raw prompts + responses from the design consults with Fable during the sync-frontier session, kept for
future reference. The DECISIONS are folded into the specs (op-substrate-unification.md, opsync-internals.md,
conflict-precedence-and-agent-governance.md §1, roadmap.md NEXT block); this file preserves the reasoning.
Two earlier consults this session (opSync emission-timing "Reading A vs B"; durable-outbox API shape) are
captured in [[opsync-internals]]; the four below are the design-heavy finals, and each caught a real trap.

---

## 1. Owner-authority when opSync-ifying the worker (the surface-drop, step 1)

**Prompt:** step 1 = express the worker's owned-store sync as opSync-over-a-MessageChannel-transport,
retiring its bespoke version/gap/snapshot star-sequencer (the surface-drop, before the deeper "one opSync
fed by both transports" mux). The worker is OWNER-AUTHORITATIVE (single-writer per subtree; main routes
writes to the owner, reconciles on the owner's echo); opSync is peer-LWW-register. For step-1-alone
(worker MessageChannel only; mesh stays a separate opSync reader), does opSync-ifying PRESERVE owner-
authority cleanly (worker channel is single-writer so opSync's LWW never adjudicates) — or is there a trap?

**Fable:**
> Trap: the single-writer assumption is real for the channel but not for the *store* — and more
> fundamentally, opSync changes write semantics from "request routed to owner, reconciled on echo" to
> "fact applied optimistically, merged by LWW." Two concrete design points for the next agent: (1) owner
> veto/rejection has no seam in opSync — the owner can only *compensate* with a corrective op (which does
> win, since HLC receive-rules guarantee the owner's response op timestamps after the offending op), but
> main now transiently shows the invalid state AND mesh, as a separate opSync reader on the same store,
> will happily propagate that pre-veto op to peers before the correction lands — so if the bespoke
> protocol relied on rejection-before-visibility, step 1 must either accept eventual-correction semantics
> explicitly or keep a route-writes-to-owner shim in front of the owned subtree; (2) mesh peers writing
> into the worker-owned subtree arrive as merged facts (mesh opSync applies them to main's store, worker
> opSync replicates them onward), never passing through the owner's adjudication at all — so owner-
> authority across the *composition* silently degrades to LWW even though the worker channel itself is
> single-writer.
>
> Gap/snapshot equivalence is the safe part: opSync's seed()/resync contract subsumes the bespoke
> version/gap/snapshot machinery, no trap there.

---

## 2. Ranking / precedence convergence (does "rank only in the concurrent branch" converge?)

**Prompt:** design = opaque `rank` at emission, applied ONLY in resolveConcurrent (when `concurrentWith`
true), winner by (rank, hlc, writer); `beats()`/dominance stay hlc-based so a causally-later low-rank write
still beats the stale high-rank value. Worry: order-dependence, because "is it concurrent" is judged against
the arrival-order-dependent current register. Example: A(a,hlc1,rank HIGH), B(b,hlc2,rank LOW,prev=a → built
on A), C(c,hlc3,rank LOW,prev=x → concurrent). Order A,B,C → c; order A,C,B → b. Is it non-convergent, and if
so what's the right formulation?

**Fable:**
> ## Verdict: yes, it diverges, and the counterexample is sound
> Your trace is correct, and the root cause is deeper than "judged against the current register." Look at
> the pairwise dominance relation your two-branch design induces:
> - B beats A (causal succession, hlc)
> - C beats B (concurrent, same rank, hlc)
> - A beats C (concurrent, rank)
>
> That's a **Condorcet cycle**. Once the preference relation is non-transitive, a single-winner register
> that discards losers is a knockout tournament, and tournament winners under a cyclic relation depend on
> match order — no local fix (op buffering, smarter `concurrentWith`, re-checking on arrival) can repair
> it. The cycle exists in the relation itself, independent of arrival order mechanics.
>
> ## Is "rank breaks concurrency only" achievable with a single register?
> Not in its pure form. Convergence for a discard-losers register requires the winner to be `max` under a
> **total order computable from the envelope alone** — associative, commutative, idempotent. Any such total
> order either puts rank before hlc (rank overrides causally-later writes: caveat (a)) or after hlc (rank
> never matters). "Rank applies only when concurrent" requires *evaluating* concurrency, and true
> concurrency is a property of the causal partial order — which the envelope (hlc + prev-hint) can't carry
> faithfully. Your `prev ≠ current value` predicate is a lossy proxy (ABA/value-identity issues), but even a
> perfect predicate wouldn't help: the cycle above is real concurrency, correctly detected.
>
> ## The right formulation
> **Option A — rank inheritance (recommended for your substrate).** Global total order `(rank, hlc, writer)`,
> uniform in `beats()`. The trick: at emission, stamp `rank = max(writerRank, rank of the register value
> being overwritten)`. Causal successors carry rank forward the way HLC carries time forward. Causally-later
> low-rank write inherits HIGH → beats the stale high-rank value; concurrent writers never saw the value, so
> they don't inherit → rank genuinely breaks concurrency. Your example: B stamps HIGH (inherited from A),
> final = **b** in every order. Convergent. Note the semantic delta: the "intended" answer was c, but under
> inheritance B carries A's authority, so C (who never observed the admin's write) loses — arguably the
> *right* policy, and the **only** convergent single-register semantics that both respects causal succession
> and lets rank matter. One ratchet: rank on a path is monotone (admin can't "release" a field by writing
> low-rank); if release matters, add an epoch/generation field ordered `(epoch, rank, hlc, writer)`.
>
> **Option B — MV-register + causal metadata.** Keep per-op causal identity (dots + context), retain all
> causally-maximal siblings per path, resolve at read by `(rank, hlc, writer)`. The sibling set is a pure
> function of the delivered op *set*, so it converges, and gives exactly rank-breaks-true-concurrency-only
> (final = c). Cost: version vectors, sibling storage, GC.
>
> ## Bottom line
> "Rank only in the concurrent branch" over a bare LWW register is non-convergent by construction (cyclic
> dominance), not by implementation accident. Pick (A) rank in the global order **plus inheritance-on-
> overwrite**, or (B) pay for causal metadata + an MV-register. Given opSync's single-winner, envelope-only
> design, A is the natural fit.

*(Superseded on point A by consult #4: rank must be a dynamic EPOCH, not a static tier — inheritance is
subsumed once the MV-register + epoch land. See §4 below and conflict-precedence §1.)*

---

## 3. MV-register build mechanics (light vs version-vectors; uniform; blast radius)

**Prompt:** building the MV-register (Option B). opSync = single-winner per-path LWW register; envelope
carries HLC + a `prev` value-hint (not VVs); ops are set/delete; register resolves to ONE value in a plain
copy-on-write store; wire ships single ops. Q1: can convergence be LIGHT (retain siblings, fold at read by
(hlc,writer)) without version vectors, or are VVs mandatory? Q2: does ONE sibling-set serve ranking/preserve/
keyedArray via pluggable folds? Q3: can store + wire stay SINGLE-VALUE (MV internal to the register)?

**Fable:**
> ## Q1 — Light works, but the hint must become a dot-citation, not a value
> HLC alone is unsound for sibling identification, full stop. HLC gives causality⇒order, never order⇒
> causality: A writes at hlc 5, B sees it and writes at 7, partitioned C writes at 6. From stamps you cannot
> decide whether 6 is concurrent with 7 or superseded by it. And the prev-value hint can't rescue it, for
> exactly the ABA reason: identical values from distinct ops are indistinguishable. So: not fixable with what
> the envelope carries today. But full version vectors are NOT mandatory. The minimal sound mechanism is the
> **causal-context / dot-citation** pattern:
> - **Envelope change:** each set/delete carries `cites: Array<{writer, hlc}>` — the dots of the sibling(s)
>   the writer observed at that path when it wrote. Common case: one element (the current winner's dot). The
>   op's own dot is `(writer, hlc)`, which you already have. The prev value-hint is subsumed.
> - **Register state per path:** `siblings: Map<writer, {hlc, value}>` (a writer's newer op on a path always
>   causally dominates its own older one, so at most one live candidate per writer) plus `superseded: Map<
>   writer, hlc>` watermarks. An incoming op kills its own writer's older entry automatically, marks every
>   cited dot's watermark, and dies on arrival if its own hlc ≤ its writer's watermark. Live siblings =
>   entries above their watermark and uncited.
> The watermark compression is sound precisely because per-writer ops are totally ordered. This also makes
> the scheme delivery-order-robust: a cite arriving before the op it kills just parks in the watermark, no
> causal-delivery requirement. Cost is O(live siblings) per op, prunable below a stability frontier (relay
> ack / seed checkpoint). That's dotted-VV *semantics* at register-local dot-list *cost*. One landmine: dots
> require unique replica ids. If two tabs share a writer id through tabSync, dot uniqueness breaks — either
> replica-id per tab or serialize writes through the leader.
>
> ## Q2 — Yes, one retention semantic, three (four) folds
> Retention is uniform: keep the causally-maximal set. Everything else is a pure fold over `(value, dot)`
> siblings, convergent for any fold that is a deterministic function of the *set*:
> - **LWW (default):** fold = max by (hlc, writer). Existing semantics = the trivial fold, cleanest migration.
> - **Ranking:** payload carries rank; fold = max by (rank, hlc, writer). The ABA problem disappears because
>   supersession is now by dot, not stamp comparison.
> - **Preserve:** fold = `Conflicted{siblings}` when N>1; the user's resolution write cites all N dots.
> - **keyedArray:** fold = identity-merge of the N sibling arrays by key, with a deterministic per-key inner
>   rule (contributor's (hlc, writer)). Caveat: whole-array snapshots; converges, but element-granular paths
>   are the better long-term shape. Fine as the shipped rung.
>
> ## Q3 — Store and live wire stay single-value; seed does not
> - **Store:** MV lives entirely in the register layer. At apply: recompute fold → if it equals the
>   currently materialized value, skip the write, preserving copy-on-write reference identity even when the
>   sibling set churned. Synchronous reads unchanged.
> - **Live wire:** still one op per message; the only shape change is the `cites` field.
> - **Two honest leaks:** (1) `opSync.seed()` / fresh-room snapshot must ship register state (siblings +
>   watermarks) for conflicted paths, not just materialized values, or a joiner can't correctly supersede
>   later writes — a seed-contract version bump. (2) `preserve` leaks by design: `Conflicted` must surface
>   as a materialized marker value or a per-path side signal — the side-signal keeps the store type clean.
>
> **Net for tomorrow:** envelope +1 field (`cites`), register state per path (sibling + watermark maps),
> fold plug point with LWW as default, seed contract bump, replica-id-per-tab check. No version vectors, no
> wire multi-value, no store-type change except opt-in preserve surfacing.

---

## 4. The owner-veto fork — (i) eventual-correction vs (ii) route-to-owner shim

**Prompt:** opSync-ifying converts owner-authoritative writes into optimistic-fact + LWW (no owner-veto
seam). (i) accept eventual-correction (owner compensates; transient invalid state + pre-veto peer echo OK);
(ii) keep a thin route-writes-to-owner shim to preserve reject-before-visibility. Rule on: (A) surface area
— does the shim undercut the delete-the-sequencer win? (B) does Better/CMMN/medical need reject-before-
visibility? (C) is a pre-veto peer echo a real problem? (D) could owner-authority ride the rank fold — owner
writes at MAX rank so its op wins — making a clean deterministic (i), shim only for true before-visibility?

**Fable:**
> **Pick (i), via D — with one correction to the rank design. Do not build shim (ii) into the sync layer;
> its legitimate residue is an application-level command, which needs zero protocol support.**
>
> **A. Surface area — the shim is thin in LOC and expensive in truth.** The routing is small next to the
> version/gap/snapshot sequencer. But a *correct* request path needs delivery guarantees the fact path gets
> for free from opSync: what happens when the request is lost, duplicated, or the owner reconnects mid-flight?
> Retries, dedupe, ordering, replay-on-reconnect — that's the sequencer regrowing under a new name. Ops are
> idempotent facts and inherit all of that from opSync; requests are not and inherit none of it. The shim
> also bifurcates the write model. So (ii) undercuts the win not on day one but by month three.
>
> **B. Consumer — the medical concern is real but mis-aimed at the state layer.** The hazard in CMMN/openEHR
> isn't a transient pixel; it's downstream *action* on unconfirmed state. Writes that genuinely need reject-
> before-visibility (place order, complete task) are commands with preconditions, and CMMN already models
> them as commands — they belong at the workflow-engine layer as "call the owner, owner validates, owner
> writes the result," which any app can do today with no protocol machinery. Trying to recover command
> semantics by intercepting state sync is a layering error. For actual state, eventual-correction is the
> optimistic UI every offline-capable FHIR client already ships. This also fits the creed: "an agent is a
> user" means agents submit facts and the authority corrects them — same as humans.
>
> **C. Mesh — benign for convergence, and audit-positive.** Peers converge on the correction; a permanent
> log of "attempted X, owner corrected" is a *feature* in a traceable medical system, not contamination. The
> only real risk is peers firing irreversible effects on pre-correction state — but that's the same
> discipline optimistic UI always requires: gate effects on owner-settled reads (see D). Consumer discipline,
> not a protocol defect.
>
> **D. Right instinct, one bug: a static owner-tier rank bricks the register.** If the owner corrects at a
> constant MAX rank, every subsequent normal-rank write loses the fold forever — the subtree becomes owner-
> only after the first veto. Rank must be a dynamic *epoch* (a term, Raft-style), not a tier: writers stamp
> ops with the highest epoch they've observed; within an epoch, (hlc, writer) breaks ties; the owner
> overrides by writing at epoch+1, and later normal writes adopt the new epoch and compete normally again.
> With that fix, D is exactly right:
> - "Veto" becomes "owner's op deterministically wins the fold" — no corrective-op special case, it's just
>   the fold.
> - Policy binds epoch-bump rights to the owner's writer identity (opaque rank stays opaque; the rule is
>   local).
> - The winning op's epoch tells any reader whether the value is owner-settled — your sync-at-read
>   confirmation seam and the gate for effects (C) at zero extra machinery. If you want positive confirmation
>   of *accepted* writes (silence vs. not-yet-seen), the owner echo-acks at owner authorship within the epoch
>   — one op per accepted write, which the old sequencer effectively paid anyway.
>
> **The ruling:** the fork is false at the protocol level. (i) with epoch-rank is the sync layer, uniformly
> — delete the sequencer, no subtree shim. (ii) survives only as the degenerate pattern "RPC the owner; the
> owner's write *is* the state change," which costs nothing and lives in the consumer (Better's command
> layer), where reject-before-visibility semantics actually belong.

---

## 5. (2026-07-07) Confirming the rank-independent-supersession divergence — after property-proving the model

We built a pure reference model of the dot-citation register (`precedence-proofs.spec.ts`) and property-
proved: (a) the live set is a pure function of the delivered op set → converges under any arrival order;
(b) folds are order-independent; (c) HLC-alone can't identify siblings; (d) the naive "rank-only-in-the-
concurrent-branch" register Condorcet-diverges. One DIVERGENCE from consult #4 surfaced and was confirmed.

**Prompt:** our model shows a static MAX-rank tier does NOT permanently brick, because cite-supersession is
RANK-INDEPENDENT: a causal low-rank write (cites/supersedes the high-rank op) removes it from the live set →
wins regardless of rank. So the field stays editable; static rank's only real limits are (a) DE-ESCALATION
(a low-rank "release" loses to a CONCURRENT higher-rank op), and (b) no authority-settled read signal. Is
that refinement correct — cite-supersession SHOULD be rank-independent — or did you intend it RANK-GATED
(low-rank can't supersede high-rank), which reintroduces bricking and is a different semantic?

**Fable:**
> **Pick: rank-independent supersession. Your refinement is correct; retire my "bricks forever" claim as
> stated.**
> That claim is only true in a different model than the one we actually specced: either (a) rank-gated
> supersession, or (b) a fold over full history rather than the live set. In the dot-citation model,
> supersession is a statement about *causal knowledge* ("I saw this op and am replacing it"), and rank is a
> statement about *race resolution* ("when neither of us saw the other, higher rank wins"). Those are
> orthogonal lattice dimensions and should stay orthogonal. So yes: epoch's job is de-escalation +
> authority-settled reads, not anti-bricking.
> Why rank-gating is the wrong semantic, beyond bricking: it breaks the theorem you just proved. With
> gating, the live set is no longer the maximal antichain of the delivered causal order — you get causally-
> dominated-yet-live ops, and you're forced into a choice between transitive-closure watermarks (a low-rank
> op's cites must still count when a later high-rank op cites *it*, or the old high-rank op becomes a
> permanent ghost) or order-dependent ghost hazards. Rank-independent keeps "live set = pure function of the
> delivered set" clean.
> Three holes to have on the record with rank-independent supersession — none fatal, all should be named in
> the RFC:
> 1. **Rank is not authority.** Any peer that syncs first can cite-and-win; in a fully-online network every
>    write is causal and rank literally never fires. Rank only wins races. If you need "students can't
>    overwrite the teacher," that is admission control — enforce writer/rank at the relay policy layer (op
>    rejected at ingest), never in the merge function. A malicious peer forging citations of a high-rank dot
>    is the same layer's problem.
> 2. **High-rank effects are non-durable.** An admin "freeze" is un-frozen by the next causal edit from
>    anyone. If product semantics need sticky-until-cleared-by-equal-rank, that's a separate lock register or
>    an epoch bump, not gated supersession on the value register. Don't conflate the two lattices.
> 3. **Stale high-rank resurrection** — a superset of your (a): it's not only concurrent-in-time ops. A
>    partitioned high-rank device can surface an *old-HLC* op days later; it cites nothing recent, nothing
>    cites it, so it's a live sibling and wins the fold — value jumps backward. Epoch (authority-scoped,
>    where the bump itself IS the one rank-gated operation, which is fine because it's a scoped, explicit
>    act) kills prior-epoch ops regardless of citation and closes this too.
> So: confirm rank-independent, epoch for (de-escalation, settled reads, durable authority when actually
> wanted), authority enforcement at admission — and the mesh-protocol `policy.ts` seam is where hole 1 lands.

---

## 6. (2026-07-07) Completeness review of the invariants register (idea/invariants.md)

**Prompt:** [gave Fable the compressed 24-invariant register by tier — T1 proven theorems, T2 asserted, T3
characterized, T4 deferred-impl, T5 relay policy, T6 architectural rules] Q: name MISSING invariants
(liveness? causal-consistency-at-read? deletes/tombstones? GC-can't-resurrect? relay-single-value-fold vs
client-MV divergence? bounded state? epoch monotonicity per path? anything else), and flag any WEAK or
mis-tiered one.

**Fable:**
> ## Missing
> 1. **Liveness — none listed anywhere.** T1(1) is pure safety (same set → same state); nothing guarantees
>    the sets ever equalize. Need: every op accepted at any replica is eventually delivered to every
>    connected replica (fair-lossy channel + reconnect ⇒ anti-entropy terminates), and forwarding terminates
>    (P2P mesh has cycles — op-id dedup gives set-safety, but no-infinite-rebroadcast is a separate liveness
>    claim). This is the register's biggest structural hole.
> 2. **GC no-resurrection — T4's "value-preserving" is the wrong property.** Value-preserving prune doesn't
>    preclude a lagging replica re-delivering a below-frontier op that gets admitted as live post-prune — the
>    exact failure T1(7) proved for ranks, reintroduced via GC. Need three parts: (a) any op above the
>    frontier folds identically pre/post-prune (fold-equivalence, not "value-preserving"); (b) below-frontier
>    deliveries are rejected at admission; (c) frontier correctness itself — min-ack over live replicas,
>    monotone, plus a membership/retirement rule (a dead replica otherwise pins the frontier forever and GC
>    never runs).
> 3. **Deletes/tombstones — absent entirely.** keyedArray merge shipped, but no invariant for remove
>    semantics: observed-remove (delete kills only cited siblings; concurrent insert survives — or the
>    opposite, but *stated*), tombstone lifecycle, and delete×epoch interaction. Concurrent insert-vs-delete
>    under 3+ writers is exactly the shape of your T3 divergence class.
> 4. **Seed-equivalence as an equation, and relay-fold ≡ client-fold.** T2's journal-fold-from-base covers
>    opSync; T4's "seed ships register STATE" states the *mechanism*, not the theorem. Need: `fold(seed(S),
>    suffix) = fold(∅, allOps)`, and — since the zero-dep relay seeds fresh rooms — either the relay is
>    semantics-free (opaque op/state store) or its fold is spec-identical to the client's. A relay that folds
>    MV state to a single value seeds joiners into permanent divergence from established peers.
> 5. **Client-side admission — T5 is mis-scoped for P2P.** Admission control and forged-citation rejection
>    live at the relay, but WebRTC peers bypass the relay. Either declare P2P rooms trust-full explicitly, or
>    add a T4 invariant: validation is deterministic, total, and part of the pure model (a malformed/forged
>    op is rejected identically at every replica — nondeterministic rejection is itself a divergence source).
>    Same hole applies to "only-authorized epoch bump": emission-side checking doesn't bind a malicious
>    direct peer.
> 6. **Crash-recovery / read-session guarantees.** Durable outbox and boot-gate are T2 *component* tests; the
>    end-to-end invariant is missing: a locally observed/acked op survives crash+rehydrate and boot
>    arbitration (worker+mesh+persist) never regresses exposed state — read-your-writes and monotonic-reads
>    across the boot race. Notably this is the exact scenario you've named as the branching-state driver.
> 7. **No dot reuse across crash/clone.** T4 has replica-id uniqueness, but the classic killer is
>    restore-from-backup / cloned persisted storage: two replicas resume the same id+counter and mint
>    colliding dots, which silently breaks T1(1)'s set semantics. Needs the mechanism-level statement
>    (persisted counter fencing or fresh replica-id on restore).
> 8. **HLC well-formedness.** T1(3) leans on HLC but no invariant governs it: per-replica HLC strictly
>    monotone (across crash too — pairs with #7), bounded drift from physical time, and *correctness never
>    depends on wall clock* (wall time is tie-break/liveness only).
> 9. **Bounded state.** Sibling set bounded by concurrent-writer count; causal context compresses to
>    O(replicas) not O(ops); outbox growth under prolonged offline is bounded or explicitly documented
>    unbounded. No boundedness claim exists in any tier.
> 10. **Epoch monotone-at-read + concurrent-bump convergence, per path.** T4 covers monotone *emission*;
>    missing the fold/read side: exposed epoch per path never decreases at a replica, epoch comparison is
>    per-path, and two concurrent *authorized* bumps to the same N converge deterministically (if "epoch" in
>    T1(2) already proves this, say so explicitly — right now it's ambiguous whether the fold or just the
>    scalar compare was proven).
> 11. **Effect exactly-once across replay.** commitOrdered/echo-free cover the live topology; nothing covers
>    crash-replay — rehydrating the journal must not re-fire onCommit for effects already executed
>    (at-least-once + idempotency key, or a durable effect watermark). Given "effects-are-edges" is creed,
>    this is a consumer-facing correctness hole.
> 12. **Migration determinism.** You have an uncommitted migration.spec.ts, but no register entry: ops
>    emitted under schema v(n) are migrated/rejected identically at every replica (migration is a
>    fold-compatible, deterministic transform), else mixed-version rooms diverge.
>
> ## Weak / mis-stated / mis-tiered
> - **T4 GC entry** — mis-stated, see #2. As written it permits resurrection.
> - **T5** — mis-scoped: forged-citation rejection is partly an *impl* invariant (client ingress, T4), not
>   purely relay policy, because of direct transports. Split it.
> - **T4 seed entry** — weak: mechanism, not property. Restate as the equivalence equation (#4).
> - **T1(6)** — mixes a theorem with a design assertion; "owner veto = the fold" is a modeling *choice*,
>   "static rank can't de-escalate" is the proven part. Split the sentence so the proof obligation is crisp.
> - **T3** — fine, but add the flip-contract: on MV-register landing these must move to T2, and T1(4)'s
>   Condorcet counterexample should be pinned as a permanent regression oracle, not retired.
> - **T2 "versionsMonotone"** — correct but only local; don't let it masquerade as monotonic-reads across
>   boot/tab/worker (that's gap #6).
> - Tiering otherwise sound; T1's proven set is genuinely strong. The register's shape problem is that every
>   entry is a safety property — add a liveness section (gaps #1, and the liveness halves of #2c and #8) or
>   the register proves a system that may correctly do nothing.

---

## 7. (2026-07-07) Epoch emission-rule precision — ATTEMPTED, Fable hit its usage limit (UNCONFIRMED)

Tightening the epoch-monotone proof surfaced a precision and an open question; the consult could not run
(Fable reached its Fable-5 usage limit). Recorded here so the next agent (or Fable with fresh context) can
pick it up. The finding is PROVEN BY MODEL (precedence-proofs.spec.ts) but Fable-unconfirmed.

**Prompt (asked, unanswered):** exposed-epoch-at-read is monotone ONLY IF a writer's epoch is monotone
across its OWN ops — "highest epoch observed" must include the writer's OWN prior epoch, not just cited-dot
epochs. Naive "adopt max cited epoch" regresses (write epoch 3, later write citing only epoch-1 dots → the
same-writer newer op replaces the older at epoch 1 → exposed drops 3→1; property test failed under naive,
passes under corrected). Q1: confirm `epoch := max(cited-dot epochs, writer's own prior epoch)`, per-writer
monotone? Q2: is epoch per-PATH or per-writer-global? Q3: other emission subtleties (per-path bump; an
unauthorized writer merely CARRYING a high observed epoch forward vs BUMPING)?

**Fable (2026-07-07, after credits refreshed — the consult re-ran and answered):**
> **Q1 — Confirmed.** The rule must be `epoch := max(cited-dot epochs, writer's own prior epoch)`. Because
> the per-writer sibling map keeps only best-by-HLC per writer, a writer's newer op *replaces* its older
> one rather than coexisting, so exposed-epoch monotonicity at read is exactly equivalent to per-writer
> epoch monotonicity — the citation set alone can't guarantee it (a writer may legitimately cite only stale
> dots). Your fix is the correct and minimal one.
> **Q2 — Per-path.** "Own prior epoch" means own prior *at that path*. Reason: epoch is causal-supersession
> metadata for a register, so it belongs to the path's causal context, same as the dots it rides with.
> Global scoping breaks commutativity/independence of disjoint paths — one authority bump on path X would
> inflate the writer's epochs store-wide, spuriously superseding concurrent writes on unrelated path Y and
> forcing every other writer everywhere to chase, i.e. unbounded epoch inflation with no semantic payoff.
> The monotonicity property you're proving is itself per-path, so per-path own-prior is both sufficient and
> minimal. (Corollary: per-path epoch must survive tombstone→re-create of the path, or you regress on
> revival.)
> **Q3 — Yes, three.** (a) The authority +1 bump must also be per-path: `max(observed-at-path) + 1`, else a
> bump on one path silently outranks concurrent writes elsewhere. (b) An unauthorized writer *carrying* the
> observed high epoch forward (never bumping) is not just fine but required — carrying preserves
> monotonicity without granting supersession power, since it can only tie the epoch it saw (HLC/dot
> tiebreak resolves ties as usual). (c) Emission must read own-prior from the writer's own emission
> frontier, not the merged/exposed view — and synthesized ops (seed/hydration/snapshot replay) must honor
> the same own-prior-at-path floor, or seeding regresses exposed epochs exactly the way your naive-rule
> counterexample does.

---

## 8. (2026-07-07) Opus's three seam questions — prev, flip-contract width, origin

**Prompt (Opus, relayed by Miha):** (1) `prev` is the inversion basis for `invertBatch` (op-log.ts:215)
— "prev subsumed" in the docs invites an implementer to drop it and silently break undo/rebase. (2) The
ancestor-dominance deletion flips MORE op-sync.spec tests than #13's flip-contract lists — the
subtree-swallow assertions will fail mid-re-point with no note. (3) `origin` is in the real
`compareStamp` order but absent from the model's fold — redundant on purpose, or accidental omission?

**Fable (verified against op-log.ts:215 and op-sync.ts:210 before ruling):**
> **(1) Confirmed — keep `prev`.** Subsumed for SUPERSESSION only; it remains the inversion basis for
> undo/rebase/boot-replay (the jsdoc itself says a batch stripped of prevs is not invertible). Envelope =
> prev STAYS (inversion) + cites ADDED (supersession) + epoch ADDED (precedence). It plays no role in
> convergence. (Docs corrected: invariants #15, conflict-precedence §1 Option B envelope bullet, roadmap net.)
>
> **(2) Confirmed — flip-contract widened.** The dominance-swallow behavior (op-sync.ts:281-286) flips
> to #33's categorical survival; every op-sync.spec assertion built on subtree-replace swallowing a
> concurrent descendant will fail during the #14 re-point BY DESIGN. Inventory them before the re-point
> and move them into #13 as named flips. (Docs corrected: invariants #13.)
>
> **(3) Origin is NOT redundant — it is the dot's identity; the model glossed it.** The shipped order's
> own comment (op-sync.ts:210) proves writers ARE shared across origins ("two origins can share a writer
> AND a stamp... only origin makes the order strict"), so `(writer, hlc)` dots would collide across a
> user's tabs — the #23 landmine, from the other side. Ruling: the dot is `(origin, hlc)`; sibling map,
> watermarks, and epoch own-prior are all per-ORIGIN; origin STAYS in the fold as the final strictness
> tiebreak — `(epoch, kind-class, hlc, writer, origin)`. This transfers every Part 2 theorem verbatim
> (the model's `writer` field plays the origin role; per-origin HLC monotonicity #22 is exactly what the
> compression argument needs) and it dissolves the #23 landmine into "already satisfied by origin
> uniqueness", promoting #24 (no origin reuse across crash/clone) to the load-bearing twin. Writer stays
> the principal that policy/ACLs bind to — do NOT make writer replica-scoped; that would force the relay's
> writer-mismatch guard and pathPrefixAcl through an external join for no gain. (Docs corrected:
> invariants #23/#33, conflict-precedence §1+§5, Part 2 spec header note.)
