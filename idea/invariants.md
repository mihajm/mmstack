# Invariants register — the rules the sync substrate must always uphold

**Purpose:** the single canonical list of what MUST stay true across the op-protocol / opSync / MV-register /
precedence design, with WHERE each is asserted and its STATUS. This is the long-term checklist — when an
invariant moves from DEFERRED to a real test, update its status here. If you are about to change the
register, the fold, the envelope, the relay policy, or the crash/boot path, this is the file to re-read first.

**Status legend:** `[PROVEN]` pure-model theorem, asserted today, impl-independent · `[ASSERTED]` shipped
unit/sim test · `[CHARACTERIZED]` a test that asserts the CURRENT (wrong) behavior and must FLIP when fixed ·
`[DEFERRED]` assert during/after the relevant impl · `[POLICY]` enforced at the relay, not the merge ·
`[RULE]` architectural discipline (human review) · `[CI]` automatable guard · `[DESIGN]` needs a stated
semantic CHOICE before it can be proven.

**Shape note (Fable review 2026-07-07):** Tiers 1–6 are all SAFETY (nothing bad happens). A pure-safety
system is allowed to correctly do nothing. Tier L (Liveness) and Tier 7 (crash/session) were the biggest
holes and are added below. Provenance: idea/op-protocol-rfc.md, idea/opsync-internals.md, idea/conflict-
precedence-and-agent-governance.md, idea/op-substrate-unification.md, idea/fable-consults-2026-07-06.md.

---

## Tier L — LIVENESS (was the biggest hole; now has a proven anchor)

**MODEL-PROVEN 2026-07-07** (`precedence-proofs.spec.ts`): in a CYCLIC mesh, op-id dedup delivers an op to
every peer exactly once and **forwarding terminates** (bounded, no infinite rebroadcast) — the L1/L2 core.
What stays deferred: the full fair-lossy + reconnect anti-entropy termination over the real transport, and
L3's frontier-membership (both need the transport/membership impl, not just the algorithm).


L1. `[DEFERRED]` **Delivery terminates.** Every op accepted at any replica is EVENTUALLY delivered to every
    connected replica: a fair-lossy channel + reconnect ⇒ anti-entropy terminates (the sets in Tier-1(1)
    actually equalize). Safety says "same set → same state"; nothing yet guarantees the sets converge.
L2. `[DEFERRED]` **Forwarding terminates (no infinite rebroadcast).** The P2P mesh has cycles; op-id dedup
    gives set-SAFETY, but "a peer stops re-forwarding an op it has already relayed" is a separate LIVENESS
    claim. Assert no unbounded rebroadcast storm.
L3. `[DEFERRED]` **Frontier advances (pairs with #GC).** GC can only run if the stability frontier moves; a
    dead/permanently-partitioned replica must not pin it forever → a membership/retirement rule is required
    (see G3).

## Tier 1 — Convergence & precedence THEOREMS (proven, `packages/primitives/src/lib/store/precedence-proofs.spec.ts`)
Impl-independent; they stay true no matter how the register is built.

1. `[PROVEN]` **Dot-citation live set = a pure function of the delivered op SET** → converges under ANY
   arrival order, including cites-before-ops and duplicate delivery. *(the load-bearing convergence claim.)*
2. `[PROVEN]` **Any fold over the live set (lww / rank / epoch) is order-independent** → the materialized
   value converges. (Proven for the fold as a scalar `max` over `(epoch, hlc, writer)`; the epoch EMISSION /
   monotone-read side is NOT proven here — see E-tier.)
3. `[PROVEN]` **HLC + prev-value alone CANNOT identify siblings** (identical stamps + different cites →
   different truth) → `cites` (dot-citation) are mandatory; there is no lighter sound substitute.
4. `[PROVEN]` **The naive "rank only in the concurrent branch" single-winner register DIVERGES** (Condorcet
   cycle A≻C≻B≻A). The anti-pattern — never build a discard-losers register over a non-transitive relation.
   This counterexample is a PERMANENT regression oracle; it is never retired even after the MV-register lands.
5. `[PROVEN]` **Cite-supersession is RANK-INDEPENDENT** → a causal write always wins regardless of rank; a
   field is NEVER permanently bricked. Supersession = causal knowledge; rank = race resolution; keep the
   lattices orthogonal (rank-GATING breaks invariant 1).
6a. `[PROVEN]` **Static rank cannot de-escalate; a dynamic EPOCH can.** (the proven part)
6b. `[DESIGN]` **"Owner veto = the fold" is a modeling CHOICE** (owner writes at epoch+1 → wins the fold) —
    defensible, but it is a decision, not a theorem. State it as chosen semantics.
7. `[PROVEN]` **Stale-high-rank resurrection is real** (old-hlc uncited op wins the fold → value jumps back)
   and **an epoch bump closes it** (kills prior-epoch ops regardless of citation — the ONE legitimately
   rank-gated operation).

## Tier 2 — Substrate invariants ASSERTED in shipped tests (keep green)

8. `[ASSERTED]` opSync convergence + sim invariants `converged` / `journalFoldsFrom` / `seqDense` /
   `versionsMonotone` / **`commitOrdered`** — `packages/mesh/client/src/lib/sim/`.
9. `[ASSERTED]` **Local-pending-as-branch**: freeze-before-observe keeps the original stamp; `onCommit`
   seq-ordered; version derives from the watermark map — `op-sync.spec.ts`.
10. `[ASSERTED]` **Multiple opSync/opLog readers on ONE store compose ECHO-FREE** — `op-compose.spec.ts`.
11. `[ASSERTED]` **`lww` and `mergeThree` converge under 3+ concurrent same-path writes** — `op-sync.spec.ts`.
12. `[ASSERTED]` Durable outbox / `whenReady` gate / cross-tab lock (`outbox.spec`, `outbox-lock.spec`, e2e);
    tabSync+mesh compose (`tabsync-mesh.spec`). NB: `versionsMonotone` is LOCAL only — it does NOT establish
    monotonic-reads across boot/tab/worker (that is Tier 7, gap-unfilled).

## Tier 3 — CHARACTERIZED bugs (assert current-wrong; must FLIP when fixed)

13. `[FLIPPED → ASSERTED 2026-07-08]` **`preserve` + `keyedArray` now CONVERGE under 3+ concurrent
    same-path writes** — the MV-register landed; the two characterizations were inverted to assert
    convergence (`op-sync.spec.ts`), and the ancestor-dominance SWALLOW flipped to #33's categorical
    survival (`a newer parent set clears older descendant winners` → the concurrent child survives,
    `{a:{fresh:true,b:99}}`). The Tier-1(4) Condorcet oracle STAYS as a permanent guard (never retired).
    This entry belongs to Tier 2 now; kept here with its history for the flip record.

## Tier 4 — DEFERRED to impl (assert during/after the MV-register build)

**SHIPPED 2026-07-08 — status update (authoritative as of this date; the per-item `[DEFERRED]` tags
below predate the build).** The MV-register arc landed and was adversarially reviewed + fixed. Suites:
primitives 817, mesh-protocol 35, mesh 117, worker 59 (all green). Now `[ASSERTED]`:
- **#14** REAL `createConvergingApply` matches the model — impl-parity property + `zzz-adversarial.spec.ts`
  (incremental-deltas == materialize, every arrival order), `op-sync.spec.ts`.
- **#15** cites correctness + `prev` kept for inversion — `op-sync.spec.ts` (release-review + emission tests).
- **#16** deterministic TOTAL ingress validation — `validateEnvelope` (op-sync.ts + mesh-protocol
  `validate.ts` twin), table-driven + client/relay parity property (`op-sync.spec.ts`, `mesh-sync.spec.ts`),
  incl. `__proto__`/control-char rejection.
- **#17** seed/hydrate = register state + RELAY RETENTION-ONLY — `op-sync.spec.ts` checkpoint tests,
  `mesh-sync.spec.ts` twin-parity, `relay.spec.ts`. Orphan-grandchild seed==incremental fixed (graft vivify).
- **#18** GC (a) fold-equivalence + (b) below-frontier admission-reject — `op-sync.spec.ts` prune property,
  `zzz-adversarial.spec.ts`. **(c) frontier CORRECTNESS/membership still DEFERRED** (frontier is
  journal-volume-driven, not min-ack-over-live-members — the L3 liveness gap).
- **#19** delete/tombstone semantics — `precedence-proofs.spec.ts` Part 2 + impl in `op-sync.ts`.
- **#21** bounded state — `OpSync.prune` wired to the relay frontier broadcast (`op-sync.ts`,
  `relay.ts`, `mesh-sync.ts`); prune property in `op-sync.spec.ts`. CAVEAT: dead-origin `versions`/relay
  `room.wm` eviction still DEFERRED (needs a receive-side frontier gate — see idea note; small: one int/origin).
- **#23** dots = (origin, hlc) + per-tab origin — `origin-fencing.spec.ts`. **#24** no origin reuse across
  crash/clone — fresh-origin-per-boot; the clone-divergence characterization FLIPPED to convergence.
- **#33** cross-path (subtree) dominance via clear-group — impl + `precedence-proofs.spec.ts` Part 2 +
  `op-sync.spec.ts`.
Also now `[ASSERTED]`: **#22** HLC well-formedness (monotone-under-wall-rewind `hlc.spec.ts` +
cross-crash safe by fresh-origin #24 + convergence wall-clock-independent); a receive-side frontier
admission gate landed (W4) closing first-contact below-frontier straggler resurrection on the live path.
Still genuinely DEFERRED: **#18(c)** frontier membership (L3, min-ack over live members);
**#32** migration determinism (partial); dead-origin `versions`/`wm` eviction (tiny, W4 caveat).
The relay epoch/citation admission gate (the #25 relay half) SHIPPED `[ASSERTED 2026-07-16]` — see
Tier 5 for the enforcement record.
See Tier 7 for the crash/session characterizations.

**MODEL-PROVEN 2026-07-07** (`precedence-proofs.spec.ts`, 38 tests — Part 2 added same day, see #19/#33): the pure-model / algorithm halves of
several Tier-4/5 items are now theorems — only the real-impl wiring stays deferred. Proven: **#17** seed
`fold(seed(STATE), suffix) = fold(∅, allOps)` AND value-only-seed diverges (ship register state, not the
value); **#18** GC fold-equivalence + below-frontier admission-reject prevents resurrection (frontier
CORRECTNESS/membership still deferred); **#20** epoch monotone-at-read + concurrent-authorized-bumps
converge; **#21** state is O(writers) not O(ops); **#23/#24** a shared replica-id (dot collision) provably
breaks convergence; **#16** nondeterministic validation provably diverges (so validation must be
deterministic+total — the actual validator is still deferred). What's genuinely impl-only below: #14, #15,
#19 (needs a stated delete semantic), #22 cross-crash HLC, and the frontier-membership half of #18.

14. `[DEFERRED]` The REAL `createConvergingApply` (dot-citation register) matches the proven model — re-point
    the property tests at the impl, not the toy model.
15. `[DEFERRED]` **Envelope `cites` correctness** — an op cites exactly the sibling dot(s) it observed at that
    path when it wrote (emission-time). The `prev` value-hint is subsumed FOR SUPERSESSION ONLY (Opus catch +
    Fable ruling 2026-07-07): `prev` REMAINS the inversion basis for undo / rebase / boot-replay
    (`invertBatch`, op-log.ts:215 — its own jsdoc says a batch stripped of `prev`s is not invertible), so
    KEEP `prev`; it plays no role in convergence. NB (Fable 2026-07-07): the envelope
    grows TWO fields, not one — `epoch` rides the wire too (stamped at emission per #20; NOT derivable from
    cites). Net envelope: prev STAYS (inversion) + cites ADDED (supersession) + epoch ADDED (precedence). MIXED-VERSION DECISION: an op WITHOUT `cites` (pre-MV emitter) supersedes nothing → its siblings
    accumulate forever-live; the room's policyVersion gate MUST reject pre-cites emitters (fine at the
    experimental stage; a legacy stamp-supersession adapter is the fallback if ever needed — decide loudly,
    never silently mix).
16. `[DEFERRED]` **Deterministic, TOTAL validation as part of the pure model** — a malformed/forged op is
    rejected IDENTICALLY at every replica (nondeterministic rejection is itself a divergence source). This is
    the client-ingress half of authority (T5 is only the relay half; direct P2P peers bypass the relay).
17. `[DEFERRED]` **Seed / hydrate equivalence, as an EQUATION** — `fold(seed(S), suffix) = fold(∅, allOps)`.
    And the RELAY-FOLD ≡ CLIENT-FOLD corollary: the zero-dep relay seeds fresh rooms, so either it is
    SEMANTICS-FREE (opaque op/state store) OR its fold is spec-identical to the client's. A relay that folds
    MV register-state down to a single value seeds joiners into PERMANENT divergence from established peers.
    (This subsumes and sharpens the old ledger "relay-root vs client-root" corner.) EPOCH COROLLARY
    (Fable 2026-07-07): synthesized ops on seed/hydrate/replay MUST honor the per-path own-prior-epoch floor
    (#20), or seeding regresses exposed epochs exactly like the naive-emission counterexample.
    SHARPENED (Fable 2026-07-07, design: conflict-precedence §7): the fold is CLIENT-CONFIGURED POLICY, so a
    value-folding relay is wrong BY CONSTRUCTION (it cannot know the app's fold), not merely risky. The relay
    runs RETENTION ONLY (uniform, policy-free, proven fold-independent) via a compile-asserted structural twin
    of the register-ingest rules; snapshot/welcome/seed ship REGISTER STATE, never values; relay delete-folding
    becomes "drop lone-tombstone registers below the frontier". Dividend: the "relay-root vs client-root"
    unproven corner DISSOLVES (no relay root exists). The relay compaction path is part of the SAME change as
    the client register — landing one without the other is the #17 divergence.
18. `[DEFERRED]` **GC / prune correctness (three parts, "value-preserving" was the WRONG property):** (a)
    FOLD-EQUIVALENCE — any op above the frontier folds identically pre/post-prune; (b) below-frontier
    deliveries are REJECTED at admission (else a lagging replica re-delivers a pruned op that becomes live
    post-prune — Tier-1(7) resurrection via GC); (c) FRONTIER CORRECTNESS — min-ack over LIVE replicas,
    monotone, plus a membership/retirement rule (L3).
19. `[DEFERRED]` **Deletes / tombstones — semantic STATED 2026-07-07 (conflict-precedence §6); proof + impl
    remain.** Chosen: a delete is an ordinary op (cites + TOMBSTONE sibling); observed-remove applies to
    SUPERSESSION (kills exactly the cited dots; a concurrent uncited set stays live); among live siblings the
    fold treats the tombstone as a value (LWW may pick it — the standard register race); add-wins/element-
    granular removal stays deferred to keyedArray/RGA, NOT smuggled into the register. The register
    (watermarks + epochs) persists after a tombstone wins → re-create cites the tombstone dot and adopts
    `max(cited, own-prior)` → the epoch floor survives revival BY CONSTRUCTION (discharges the corollary).
    Lifecycle: lone-tombstone registers below the frontier are droppable at prune (#18/#20 GC nuance).
    MODEL-PROVEN same day (`precedence-proofs.spec.ts` Part 2): 3+-writer set-vs-delete-vs-set converges;
    tombstone→re-create preserves the epoch floor (a stale prior-epoch straggler cannot outrank the reborn
    value); edit-under-deleted-parent drops at materialization and REVIVES on container re-create. NB
    deletes are in the op vocabulary TODAY — this could never actually defer past the MV-register build;
    it is now pre-decided AND model-proven, so the implementer transcribes, not invents.
20. `[PROVEN]` (model) `[ASSERTED]` (rule, Fable-confirmed) **Epoch monotone-at-read + concurrent-bump
    convergence.** PROVEN 2026-07-07: exposed epoch = max epoch of all delivered ops (∴ monotone) under the
    corrected emission rule + concurrent authorized bumps converge. EMISSION RULE (Fable-CONFIRMED
    2026-07-07): `epoch := max(cited-dot epochs, writer's OWN prior epoch AT THIS PATH)` — per-writer,
    per-PATH, monotone; the naive "adopt max CITED epoch" provably regresses (pinned counterexample). Epoch
    is scoped PER-PATH (global would inflate epochs store-wide across disjoint paths). Subtleties: the +1
    bump is per-path (`max(observed-at-path)+1`); an unauthorized writer CARRYING a high epoch forward (not
    bumping) is required + safe; emission reads own-prior from the writer's own frontier, and synthesized
    (seed/hydrate/replay) ops must honor the own-prior-at-path floor. See conflict-precedence §1.
    FOLD-LEVEL KILL (clarified 2026-07-07): "an epoch bump kills prior-epoch ops" means the FOLD always
    prefers max-epoch — prior-epoch siblings STAY in the live set (so state stays O(writers), #21) and
    `preserve` must surface only the MAX-EPOCH siblings in `Conflicted{N}`. RULE: any CUSTOM fold keeps
    epoch as the OUTERMOST comparison key, else #7 stale-resurrection reopens through the plug-point.
    GC NUANCE (pairs with #18): exposed-epoch monotonicity is guaranteed within a register's retention
    window; a FULL below-frontier prune legitimately resets the path's epoch (safe — #18(b)
    admission-reject closes resurrection), so settled-read consumers must not treat epoch as monotone
    across a GC horizon.
21. `[ASSERTED 2026-07-08]` **Bounded state.** Live sibling set bounded by concurrent-writer count (proven,
    precedence-proofs #21); register state reclaimed by `OpSync.prune` driven from the relay frontier
    (W1) with a receive-side frontier admission gate closing resurrection (W4); `recentLocal` capped at 64,
    durable outbox documented. CAVEAT (tiny, deferred): dead-origin `versions`/relay `wm` entries (O(origins)
    integers) are not evicted — `versions` doubles as the emit counter and the frontier is hlc-keyed, so
    eviction trades gap-detection risk for negligible memory; not worth it (see W4).
22. `[ASSERTED 2026-07-08]` **HLC well-formedness.** Per-replica `next()` is strictly monotone even when wall
    time stalls or rewinds (`hlc.spec.ts` "strictly monotonic even when wall time stalls or rewinds"), so a
    replica's newer op always sorts after its older (best-by-hlc never drops a newer write). Cross-crash is
    safe by CONSTRUCTION via fresh-origin-per-boot (#24, `origin-fencing.spec.ts`): a restart mints a new
    origin, so there is no same-origin hlc comparison across the crash; a resent pre-crash envelope carries
    its original (monotone) hlc. Correctness NEVER depends on the wall clock: convergence is a pure function
    of the delivered op set (precedence-proofs Tier-1); hlc is only a deterministic LWW tiebreak on the
    values present, and dev-mode warns on large observed skew.
23. `[DEFERRED]` **Replica-id uniqueness for dots — RESOLVED to dots = `(origin, hlc)` (Opus question +
    Fable ruling 2026-07-07).** The shipped order's own comment (op-sync.ts:210) proves writers ARE shared
    across origins today ("two origins can share a writer AND a stamp... only origin makes the order
    strict"), so `(writer, hlc)` dots would collide across a user's tabs. Ruling: the dot is
    `(origin, hlc)` — origin is per-replica unique BY DEFINITION and HLC is per-replica monotone (#22), so
    the per-origin watermark compression and the #20 epoch-monotonicity proof transfer verbatim (the
    model's `writer` field plays the ORIGIN role; see the Part 2 spec header note). Sibling map keys by
    ORIGIN; same-writer-different-origin ops correctly coexist as concurrent siblings; epoch own-prior is
    per-origin (the replica's own emission frontier, as #20 already says). The fold ends
    `(epoch, kind-class, hlc, writer, origin)` — origin STAYS in the order as the strictness tiebreak,
    writer stays the principal that policy/ACLs bind to (relay writer-mismatch guard unchanged). What
    remains deferred here: per-TAB origin uniqueness under tabSync (the cross-tab lock / leader
    serialization already engages this) — and #24 (no origin reuse across crash/clone) is now the
    load-bearing twin.
24. `[DEFERRED]` **No dot reuse across crash / clone.** The classic killer: restore-from-backup or cloned
    persisted storage resumes the SAME id+counter and mints colliding dots → silently breaks Tier-1(1) set
    semantics. Needs persisted-counter FENCING or a fresh replica-id on restore.
33. `[DEFERRED]` **Cross-path (subtree) dominance — design STATED 2026-07-07 (conflict-precedence §5);
    model proof + impl remain.** (Appended with a global id; found by the Fable readiness review — the
    proven model is SINGLE-PATH while the real `createConvergingApply` (op-sync.ts:275-314) does stamp-based
    ancestor-rejection + descendant kill/replay, and NOTHING related the citation model to the ancestor
    relation.) Chosen design: subtree write = same-envelope group `set A` + one `CLEAR D` per OBSERVED
    live descendant register (CLEAR is a THIRD op kind — observed-remove of a REGISTER, fold-winning
    clear ABSTAINS at materialization; a DELETE-based group provably erases the ancestor's own fresh
    keys — pinned counterexample); ingest is per-path only — the dominance/sweep machinery is DELETED,
    not ported; default fold = max `(epoch, kind-class, hlc, writer, origin)` with set = delete > clear
    (origin stays in the order — the strictness tiebreak; dots are per-ORIGIN, #23 ruling);
    materialization = deepest-live-wins with a deterministic drop-graft type-change rule; group epochs
    are per-path (#20a). SEMANTIC DELTA (document loudly): a concurrent descendant edit CATEGORICALLY
    SURVIVES an un-bumped ancestor replace; an epoch-BUMPED replace clears it (the worker owner's
    subtree veto, same mechanic). MODEL-PROVEN same day (`precedence-proofs.spec.ts` Part 2, all five
    §5 obligations): tree materialization = pure function of the delivered op set (30 seeds × 10 orders,
    split/duplicated replace-groups); categorical survival (incl. a LOWER-hlc concurrent edit); bumped
    veto; two concurrent replaces; late descendant op; graft determinism. Both counterexamples that
    FORCED the clear op kind are pinned as permanent oracles (delete-draft erases its own fresh key even
    UNCONTENDED; under two concurrent replaces a loser's tombstone erases the winner's key, so
    dot-matching cannot rescue delete). Remaining for impl: wire `clear` into the real envelope +
    createConvergingApply, per the flip-contract discipline of #14.

## Tier 5 — POLICY layer (admission at the relay — the network half of authority)

25. `[POLICY]` `[ASSERTED 2026-07-16]` **Rank is NOT authority.** In a fully-online network every write is
    causal, so rank never fires — it only wins races. WHO may write high-rank / WHO may bump an epoch is
    ADMISSION CONTROL at `packages/mesh/protocol/src/lib/policy.ts` (op rejected at ingest), plus rejecting
    forged citations of a high-rank dot. NB: WebRTC/direct peers BYPASS the relay — this is only the relay
    half; the client-ingress half is #16, and P2P rooms must either be declared trust-full or enforce #16 at
    every replica.
    ENFORCED 2026-07-16 (W6 options 1+2; option 3 signed-dots RULED OUT by the studio governance ratification
    2026-07-16 — E2EE-against-own-relay contradicts the audit architecture). Mechanics, all pre-sequencing so
    a rejected envelope enters no one's delivered op set (Tier-1 untouchable by construction):
    - `OpPolicy.canBump(ctx, path, epoch)` gates epoch RAISES against `RegisterStore.maxEpoch(path)` — max
      over ALL retained siblings (a superseded bump still counts within the retention window), NO independent
      cache, so a full below-frontier prune resets the floor exactly per #20's GC nuance. An op at/below the
      observed max is a CARRY and is ALWAYS admitted without consulting authority (any writer must carry an
      observed bump forward or bumped paths stop merging — the convergence-critical rule).
    - `OpPolicy.verifyCitations` (opt-in) rejects a cite with no retained trace at the op's path
      (`RegisterStore.covers`: origin's sibling OR supersession watermark at/above the dot; the ≥ rule admits
      an origin's older dots so racing a same-origin newer write stays honest). Cites at/below the compaction
      frontier are EXEMPT: unverifiable there AND provably inert (anything such a cite could kill is already
      settled below the frontier). Self-cite of the envelope's own dot tolerated, mirroring ingest.
    - Both violations route through `onViolation` with STABLE reason strings `'epoch-bump'` /
      `'unknown-citation'` (+ `path`, `detail` = offending epoch vs observed / the cited dot) — studio's
      admission-audit vocabulary. Tripwire semantics, whole-envelope, never an op mid-log. Both checks run
      AFTER the stale-schema silent drop (an outdated straggler stays dropped, not banned).
    - Client half of the lift: `meshSync.flushUnacked` sends restored-tail origins BEFORE the fresh mint (a
      fresh-origin seed's clear-group cites tail dots, never the reverse), so a citation-verifying room
      admits an offline-first boot.
    PRECONDITIONS (jsdoc'd): `verifyCitations` only for rooms where every op transits the relay AND the relay
    is durable (hydrated across restarts) — a room that loses retained state forgets dots honest writers
    still cite. KNOWN NARROW RACE (accepted, loud-not-divergent): a full below-frontier prune of a bumped
    path can misclassify an in-flight honest carry as a bump (eject) if the write raced the frontier
    broadcast to exactly that GC'd path.
    Tests: `packages/mesh/protocol/src/lib/relay.spec.ts` (epoch-bump + citation-existence describes +
    maxEpoch/covers unit reads; every guard neuter-verified once, incl. the carry boundary and the
    schema-drop placement), `packages/mesh/client/src/lib/outbox.spec.ts` (tail-before-seed order, neuter-verified).

## Tier 6 — Architectural RULES (discipline; #27 is automatable)

26. `[RULE]` **A client is one origin.** State placement (worker/disk/tabs) is PRIVATE wiring; the mesh sees
    one peer per device. Composition seams are GENERIC GATES (`whenReady` = a plain promise), never typed
    integrations; a seam earns its place only by a named consumer.
27. `[RULE]` `[ASSERTED 2026-07-08]` **`@mmstack/mesh` must not import `@mmstack/worker`** (and vice versa)
    — the hard invariant from op-substrate-unification.md. Enforced: `@nx/enforce-module-boundaries`
    `notDependOnLibsWithTags` rules (scope:mesh ↔ scope:worker) in `eslint.config.mjs`, verified to fire.
28. `[RULE]` **Worker = CPU of the graph, nothing else.** Every edge (mesh, fetch, transports, DI/injectors,
    WebRTC) lives on the MAIN thread; a change wanting to inject or fetch INSIDE the worker is the smell that
    an edge is on the wrong thread.
29. `[RULE]` `[ASSERTED 2026-07-08]` **Owner-authority rides the epoch** — the worker host exposes
    `override(store, fn)`, which stamps the owner's write at a bumped epoch so it wins the fold wherever
    it meets a concurrent write (worker + mesh both run opSync now, no sync-layer shim). Tested in
    `create-worker-host.spec.ts` (owner override beats a far-future-hlc concurrent write). The
    reject-before-visibility need remains an application COMMAND in Better's consumer layer, not protocol.

## Tier 7 — CRASH / SESSION / CONSUMER correctness (end-to-end; the boot-arbitration driver)

30. `[ASSERTED (invariant) + CHARACTERIZED (epoch floor) 2026-07-08]` **Read-your-writes + monotonic-reads
    across the boot race.** `tier7-boot.spec.ts`: read-your-writes across crash+restore HOLDS (an unacked
    offline write survives a fresh-instance restore + resends; a superseded-then-restored value never
    regresses). The epoch-floor-across-crash case is pinned as a CHARACTERIZATION with an in-file flip
    contract — and the fresh-origin-per-boot fencing (#24) dissolves the hazard by construction (a fresh
    origin has no emission history, so per-origin epoch monotonicity is vacuous). NB the W2 hydrate fix
    (rebase from the unbounded outbox, not the cap-64 ring) closed the >64-offline-writes regression.
31. `[ASSERTED 2026-07-08]` **Effect exactly-once across replay.** `tier7-boot.spec.ts`: `relay.hydrate`
    reloads the journal directly, never through `onCommit`, so a persistence/effect adapter subscribed to
    `onCommit` fires exactly once per committed seq across a relay restart (no double-append of the
    reloaded tail). Holds.
32. `[DEFERRED]` **Migration determinism.** Ops emitted under schema v(n) are migrated/rejected IDENTICALLY at
    every replica (a migration is a fold-compatible, deterministic transform), else mixed-version rooms
    diverge. Partly in the uncommitted `migration.spec.ts`; not in this register until landed.

---

## How to keep this alive
- When a Tier L / 4 / 5 / 7 item ships, change its tag to `[ASSERTED]` and add the test path.
- When #13 flips, move it to Tier 2; keep the Tier-1(4) Condorcet oracle forever.
- When #27's lint guard lands, mark it `[ASSERTED]`.
- Any change to the register / fold / envelope / relay policy / boot path → re-read Tiers L, 1, 3, 5, 7
  first; a change that would violate a Tier 1 theorem is wrong BY CONSTRUCTION, not by test failure.
- Do NOT let the register drift back to pure-safety: a new feature that adds a safety rule should ask "what
  is its liveness / crash / bounded-state obligation?" too.
