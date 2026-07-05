# RFC: the mmstack op protocol — ops across time and space

**Status:** REDLINE COMPLETE 2026-07-03 — all notes resolved inline, `preserve` blessed
(opt-in built-in, never default). IMPLEMENTATION-READY. Phase 0 of `idea/roadmap.md` done;
next: L0 build (roadmap Phase 1/2 per the rollout ladder, §9).
**Scope:** ONE substrate serving branching state (time), tab-sync, the mesh relay, and P2P
(space). Consolidates the decided discussions in `idea/branching-state.md` and
`idea/mesh-sync.md` (trust model, packaging, agent-as-peer) into a normative spec.
**Non-goals:** text/character CRDTs (interop with Yjs/Automerge instead); server-side reactive
runtimes (a server is an _owner_, not a graph — see worker-graph.md).

## 0. Design creed (Miha, 2026-07-03 — holds for everything below)

Pillars: **branchable** (developer- and user-facing forks), **causally traceable**,
**synchronous at read**, and — most importantly — **"an agent is a user"** (agents act under
the same protocol, attribution, ACLs, and undo as humans; no privileged paths). Two ideals:

1. **Mathematically provable, functional core / imperative shell.** Proofs live in L0's pure
   functions (`applyOps`/`diffOps`/`invertBatch`/`merge3`/`syncApply` — the register map is a
   join-semilattice: max over a total order is associative/commutative/idempotent, so
   convergence is a theorem; property tests keep it one). Users see signals, never algebra.
2. **As linear as possible.** The graph is a DAG that branches and reconverges, may skip
   steps; loops and side-effects are the failure modes. Effects are EDGES (transports, DOM,
   persistence, sinks), never nodes — "derivation over synchronization". Structural loop
   kills already in place: echo-free apply (sync feedback), single-writer (cross-peer write
   cycles), tripwire (protocol loops), no writes-in-derivations (graph cycles).
   Everything compresses to `ui = fn(state)` and `state' = merge(state, ops)`, plus edges.

**Anticipated consumers (redlined 2026-07-03):** Better's workflow engine first — CMMN, not
BPMN: the declarative, data-condition-activated model. Mapping is near-1:1: case file =
attributed synced subtree (envelope journal = case audit), sentries = computeds, milestones =
derived state, discretionary items = human-or-agent peers under OpPolicy, planning = branches.
BPMN's imperative sequencing is the loop/side-effect model the creed rejects. But not Better
alone: app-builder (relay = save/collab/history), other Better applications long-term, and the
general Angular community (tab-sync, undo, optimistic UI are universally useful regardless of
the multiplayer bet). Corollary: **pluggable seams/strategies over baked-in policy — but never
over-abstracted past the easy-DX rule (§10)**; a seam earns its existence by a named consumer,
not by speculation.

## 1. Ground truth (already shipped, in `primitives/store/op-log.ts`)

- `StoreOp`: `set {path, next, prev?}` / `delete {path, prev}`. Absent `prev` on a set means
  "key added" (absent ≠ undefined), which is what makes `invertBatch` sound.
- `OpBatch { origin, version, ops }`: origin = per-log transport identity (echo filtering),
  version = per-log monotonic counter.
- `OpLog.apply`: atomic (one set, one notification wave), echo-free by baseline advance, and
  honest (pending local writes flush/emit BEFORE the applied baseline advances past them).
- Pure helpers: `applyOps` (replica-side fold), `diffOps`, `invertBatch` (undo; needs prevs).
- `forkStore` + `merge3(ancestor, mine, theirs)`; `tabSync` (MessageBus over BroadcastChannel);
  the worker protocol as the proven single-writer/replica precedent; `OpLogDriver` for
  injector-free operation.

The protocol below EXTENDS these; it does not replace them.

## 2. Layering (packaging decision, restated normatively)

- **L0 — primitives, beside op-log**: the envelope, HLC, converging apply, rebase, MergePolicy.
  No wire/room/auth concerns. Primitives never imports mesh-anything.
- **L1 — `@mmstack/mesh-protocol`** (zero-dep, plain tsc): rooms, join handshake wire messages,
  auth-claim shapes, `OpPolicy` + tripwire semantics, reference relay core (injected socket +
  storage interfaces; Durable Objects = reference deploy).
- **L2 — transports**: `tabSync(store, {id})` overload in primitives (uses only L0);
  `@mmstack/mesh` WS client (Angular; peers on primitives + mesh-protocol); WebRTC later.

## 3. The envelope (L0)

```ts
type Hlc = { readonly p: number; readonly l: number }; // physical epoch ms + logical counter

type OpEnvelope = {
  readonly proto: number; // envelope SCHEMA version (redline) — the worst-case migration seam
  readonly origin: string; // log/device instance (echo filtering) — as today
  readonly writer: string; // PRINCIPAL (auth subject; agent or human) — attribution/ACL/audit
  readonly version: number; // per-origin monotonic (gap detection → resync)
  readonly hlc: Hlc; // stamped at emit; total order = (hlc.p, hlc.l, writer, origin)
  readonly policyVersion: number; // room policy the writer validated against
  readonly ops: readonly StoreOp[]; // one atomic batch (one tick / one fork commit)
};
```

Decisions:

- **`proto` ≠ `policyVersion` (redline, confirmed distinct):** `policyVersion` versions the
  room's OpPolicy (a consumer artifact, changes per app deploy); `proto` versions the envelope
  wire/journal format itself (ours, changes ~never, exists for the breaking-change worst case —
  a persisted journal must be able to say which shape its records are). Handshake carries both.
- **Identity is provided, never minted (redline):** `writer` is supplied from above — an
  injected principal-provider seam at the client/relay edge; auth stays the app's/IdP's
  problem, we never build an oauth anything. `origin` splits the difference: auto-generated
  per log instance by default (as opLog does today — providing it manually is a
  uniqueness footgun), overridable for tests and persistence resume. Required-provided writer,
  generated-overridable origin.
- `origin` ≠ `writer`: two tabs of one user share `writer`, differ in `origin`. Both required.
- **`writer` is an opaque, stable pseudonym; natural identity is FORBIDDEN in the envelope**
  (Miha, 2026-07-03). Display resolution goes through a separate MUTABLE identity directory
  (an L1/app seam, not journal data). GDPR erasure of a person = directory update ("Miha
  Mulec" → "unknown user 12489"); the journal never mutates and causality/audit stay fully
  intact (same-principal linkage survives, resolution doesn't). Pseudonymization by design +
  destroyable link. Presence (ephemeral channel) may carry display names — it persists nothing.
- **`prev` stays on the wire.** It buys compare-and-set validation, `merge3` ancestry, and
  invertibility (undo/audit) — worth the bytes. An explicit `stripPrev` transport option may
  exist for size-critical paths, clearly marked as losing invertibility.
- HLC update rules are the standard ones (max of local physical clock and observed, logical
  counter on ties). Encoding on the wire: the plain object; a sortable string form is an open
  question, not a blocker.
- The envelope is ALSO the persistence record: an event-sourced journal is `snapshot +
envelope[]`, compacted by re-snapshotting. Attribution is retained forever (audit is a
  feature; see agent-as-peer).

## 4. Ordering & convergence

Two topologies, one envelope:

**Sequenced (relay rung).** The relay assigns a room-scoped `seq` to each envelope; clients
apply strictly in seq order. No conflict ambiguity by construction; HLC still carried (parity,
audit, offline merge). This is the worker model with the owner generalized to a server.
(Redline resolution: `seq` overflow is a non-issue — 2^53 at 1,000 envelopes/sec ≈ 285,000
years. The linked-list instinct is kept though: `(origin, version)` pairs already form
per-writer chains (recomposition + gap detection today), and a cross-writer parent-ref — the
full git/Automerge causal DAG — stays in §12, to adopt only if unforgeable cross-writer
causality becomes a requirement. Order IS load-bearing here beyond integrity: apply order
defines converged state and anchors rebase.)

**Unsequenced (tabs, P2P).** No sequencer exists, so convergence comes from a **per-path
last-writer-wins register map**: apply keeps `path → winning (hlc, writer, origin)`; an incoming op
applies iff it beats the recorded winner in the total order. Two rules make this sound:

1. **Order-independence:** the winner of a path is the max over all observed ops — the same
   regardless of arrival order → all peers converge on the same state.
2. **Subtree dominance:** paths nest. A `set` at a path dominates the subtree beneath it:
   applying a parent set clears recorded child winners older than it; a child op older than
   the recorded winner at any of its prefixes is rejected. (The classic map-vs-register
   pitfall, handled explicitly.)
   Batches stay atomic for NOTIFICATION (one wave) but conflict-resolve per path — two concurrent
   batches may interleave winners path-by-path. The register map is bounded by touched paths and
   resets on snapshot compaction.

(Redline: dominance affirmed — same intuition as the store's own write-up/derive-down
discipline: a parent write invalidates the subtree beneath it, exactly like a parent `set`
invalidates child signals. The convergence rule is the reactive-graph rule, applied to time.)

L0 ships this as `createConvergingApply` + `opSync` (BUILT 2026-07-04); today's blind `apply`
remains for sequenced/trusted flows (worker, relay-ordered). Two amendments the implementation
forced, both spec-pinned:
- **The total order includes `origin`**: two origins can share a writer AND an HLC stamp
  (independent clocks, same ms, same default writer) — (hlc, writer) alone ties and diverges
  permanently. Only origin makes the order strict.
- **Lineage equality is STRUCTURAL, not referential**: a sequential edit is detected by
  comparing the op's `prev` to the registered winner's value — object identity never survives
  the wire, so a peer that built on the replicated copy of a value (e.g. resolving a
  `Conflicted`) must still count as sequential, or resolutions nest conflicts forever.

## 5. Rebase (the piece branching and mesh share)

Pending = local envelopes not yet acknowledged/sequenced. On a remote envelope arriving first:
`invertBatch(pending)` → apply remote → re-apply pending through **MergePolicy**. All three
steps already exist as pure functions; the rebase routine composes them. `branch.rebase()` is
the SAME routine with the branch's base watermark as the anchor — built once in L0.

**MergePolicy (per-path, L0 — redlined shape):** a merge strategy is a FUNCTION/INTERFACE
(`(ancestor, mine, theirs, ctx) => resolved | Conflicted<T>`), registered per path pattern
(exact or templated, `todos.*.title`). We ship built-in INSTANCES, users write their own —
mechanism in core, policy from the consumer (the AttributePolicy precedent):
- `lww` — the default everywhere; invisible (per §10).
- `merge3` — three-way with the op's `prev` as ancestor.
- `preserve` — **blessed 2026-07-03, a must for Better**: jj-style first-class conflict; the
  leaf becomes `Conflicted<T>` (both sides + ancestor), sync never blocks, resolution happens
  later as an ordinary attributed op (Better: conflicted leaf → CMMN sentry → reconciliation
  task). Strictly OPT-IN per path — never a default; see the §10 carve-out.

## 6. Join / hydration handshake (L1 messages, L0 semantics)

Ops require a shared base — value-mode tabSync's "first change wins" is NOT sound for op mode.
The exchange is TRI-STATE (redlined: a joiner may already hold hydrated state, e.g. from a
persisted journal): `hello {watermark?, proto, policyVersion}` →
- `up-to-date` — joiner's watermark is current; go live immediately, nothing transferred.
- `delta {envelopes[]}` — joiner is behind but resumable; ship only the missing envelopes.
- `snapshot {root, watermark}` — no usable base; full hydration. For large stores the
  snapshot may stream as CHUNKED envelopes explicitly flagged as hydration ops: they do NOT
  come alive per-chunk — buffered and applied atomically on completion, so no one ever renders
  half-hydrated state (and per §10, hydration is just `pending` to the outside).
Live envelopes buffer during the exchange and drain after (dedup by watermark; version gaps →
re-request).

- Tab flavor: first responder wins with small jitter; if no peer answers, you ARE the base.
  Structured clone makes tab snapshots ~free; transferables where large.
- Relay flavor: the relay answers authoritatively (its journal is the room's truth); delta is
  the common case for reconnecting clients. Compression is a relay concern, not protocol.
- `proto` or `policyVersion` mismatch at handshake = refuse to join (the silent-fork guard).

## 7. Trust: OpPolicy + tripwire (normative restatement of mesh-sync.md)

- `OpPolicy { canWrite?(ctx, path), validate?(op) }` — pure, deterministic, versioned; run
  symmetrically on EMIT and on APPLY. Honest peers therefore never emit invalid ops; any
  invalid op observed on the wire ⇒ eject that `writer` deterministically (ignore subsequent
  envelopes, surface an event). Never skip-op mid-log.
- `ctx` expresses non-human principals (agents are peers with narrower ACLs).
- The relay optionally enforces path-prefix write ACLs from auth claims + per-principal
  rate/size limits — no schema knowledge ever (dumb server holds).
- Schema-derived policies (studio: shapes → zod → path-keyed OpPolicy) compose from outside.
- **Confidentiality boundary = the room** (pinned 2026-07-05): policy is a write ACL, not a
  read ACL — every member sees the whole root; different audiences ⇒ different rooms. And the
  relay reads plaintext (it folds envelopes into snapshots), so true E2EE is incompatible with
  server-side compaction as designed; client-side compaction would be the redesign if a
  consumer ever needs it. See idea/evolution.md for the cross-layer versioning story.

## 8. Branching tie-in (see branching-state.md for isolation semantics)

A branch = base watermark + pending local ops + frame-bound lazy views. `fork()` allocates no
graph until read; `commit()` emits ONE envelope (forkStore already coalesces); `discard()`
drops; `rebase()` = §5. Effects bind to the frame they were created under; `branch.run()` is
sync-only sugar (house pattern: explicit handles across async, no zones).

## 9. Rollout ladder (maps to roadmap.md phases)

1. **L0 in primitives**: envelope type + HLC + register-map `syncApply` + rebase + MergePolicy,
   spec'd to the dnd bar (order-independence property tests: same envelope set, shuffled
   arrival, identical state).
2. **`tabSync(store, {id})` overload**: L0 + the tab-flavor handshake over the existing
   MessageBus. The protocol's first implementation, in its hardest consistency environment.
3. **Branching** (fork/commit/discard/rebase + views) — shares §5 verbatim.
4. **L1 `@mmstack/mesh-protocol`** + relay + presence (ephemeral channel, trivially LWW) + DO
   adapter recipe; agent-as-peer demo.
5. WebRTC transport, last.

## 10. The DX contract (cognitive load — normative, Miha 2026-07-03)

**A synced store is indistinguishable from a local store at the read site.** Concretely:

- Reads stay synchronous signals: no new nullability, no sync states in the data path.
- Async-ness surfaces ONLY through existing vocabulary: a syncing store registers with
  transition scopes like any resource (`pending`/`suspended`/`status`); zero new words.
- Every userland knob is SEMANTIC (merge policy, ownership, subtree subscription shapes),
  never TEMPORAL (no debounce/flush/timing tuning — coalescing and backpressure are internal;
  opLog's per-tick batching already is "waveless" continuous flow with natural windows).
- Provenance/freshness are opt-in metadata signals (`lastWriter`, staleness), legible on
  demand, invisible otherwise. Clinical-safety case (Better): a vital sign must be able to
  SHOW its freshness, but only where the author asks.
- Lifecycle is virtual-actor style (Orleans): rooms/subtrees activate when addressed,
  provider-level like scopes; components never manage connections.
- Failure surfaces as the states resources already have (reconnecting = pending, never
  exceptions from reads).
- One deliberate carve-out: a path explicitly opted into `preserve` (§5) may read as
  `Conflicted<T>` — the author asked for conflict visibility on that path, so the "no new
  states in the data path" rule yields there and only there.
  Test: if a component author ever reasons about sync timing, the abstraction failed; if they
  cannot find out what happened when they need to, it also failed.

## 11. Prior art (consulted / to consult)

- **Figma multiplayer**: rejected document CRDTs; server-ordered per-property LWW ≈ our §4
  register map; fractional indexing = the known answer for the keyed-array open question.
- **Linear sync engine**: the DX north star — app code writes plain mutations, sync invisible;
  bootstrap/partial-sync patterns.
- **Replicache/Zero**: rebase by re-running named mutations (semantic intents). Our L0 stays
  structural ops; an optional INTENT layer composes above (clinical workflows rebase better as
  intents — "administer dose" re-validates on replay). Design the seam, don't build it yet.
- **Orleans virtual actors**: activation-on-address lifecycle; single-threaded grain =
  single-writer per identity.
- **Horde (Elixir)**: ownership HANDOFF is the lesson — who answers `hello` when the previous
  answerer died; DOs solve it by platform, the tab rung needs a tiny leader story (§6).
- **Manhattan waveless (logistics)**: continuous flow beats batch reconciliation given natural
  batching windows + priority separation (durable ops vs ephemeral presence channels).
- **Electric SQL / PowerSync shapes**: partial replication = subtree subscription shapes; the
  FHIR-scale answer (sync a patient context/composition, never the EHR).
- **openEHR/Better fit**: the contribution/version model IS an attributed envelope journal
  (audit = persistence format, not a bolt-on); draft composition = branch (draft→sign =
  fork→commit); provenance-on-demand is a safety requirement, not a nicety.
- **Jujutsu (jj)** (Miha, 2026-07-03): conflicts as FIRST-CLASS DATA that never block —
  stored values (both sides + ancestor) that ride through rebases; resolution propagates;
  nothing is ever modal. Translates to a third MergePolicy outcome beyond LWW/merge3:
  **`preserve`** — the leaf becomes `Conflicted<T>`, sync keeps flowing, resolution happens
  later as an ordinary attributed op. Default stays LWW (invisible, per §10); `preserve` is
  opt-in per path where silent destruction is unacceptable. Better fit: a conflicted leaf is
  a CMMN sentry condition → reconciliation task → human-or-agent resolves → auditable op;
  conflict handling becomes WORKFLOW, not modal dev pain. (Also: jj calls its journal the
  "operation log" — convergent naming with opLog; its repo-wide undo = invertBatch
  generalized.) NOTE for §5 redline: bless `preserve` as the third MergePolicy outcome?
- Yjs/Automerge: interop targets only (awareness protocol worth studying for presence).
  Automerge's hybrid ordering (causal parent refs + timestamps for tie-break) is the model
  the §4 redline on parent pointers converges toward.

## 12. Open questions (small, non-blocking)

- **HLC wire encoding: DECIDED (delegated to Claude, 2026-07-03).** The plain `{p, l}` object
  on the wire (JSON/structured-clone native, nothing to parse), with a pure `compareHlc` in L0
  as the single ordering authority. No sortable-string encoding until a named consumer needs
  one as a storage key (§0 corollary) — `encodeHlc()` becomes a utility then. Clock skew: HLC
  absorbs it correctly by construction, but a dev-mode warning fires when an observed remote
  physical clock leads local by > 5 minutes (LWW fairness degrades even though convergence
  holds).
- **Keyed array identity: DIRECTION DECIDED (Miha redline), interface TBD at L0 build.** An
  item-identity seam the USER provides, since most domains can state identity generically
  ("id + version", "identifier + lastEditedTimestamp" — FHIR, TMForum ODA, etc.): a per-type
  registry, roughly `[type]` = opt OUT (value-object arrays travel whole — e.g. a TMForum
  Order's note array) and `[type, fn]` = opt IN (fn yields the item key). Unregistered types
  default to whole-array-set as today. Same registration family as MergePolicy/OpPolicy —
  a third policy surface (identity), mechanism in core, knowledge from the consumer.
- **Snapshot transfer: RESOLVED into §6** (tri-state hello: up-to-date / delta / snapshot,
  chunked hydration ops buffered and applied atomically — never partially alive).
- `stripPrev` transport option: offer at all, or keep prevs mandatory until a size complaint?
- **Cross-writer parent refs** (causal DAG à la git/Automerge, from the §4 seq redline):
  per-writer `(origin, version)` chains cover recomposition/gap detection today; adopt full
  parent refs only if unforgeable cross-writer causality becomes a requirement (audit-grade
  integrity at Better could be that requirement — revisit when their compliance needs land).
- **Erasure vs append-only: strategy RESOLVED (2026-07-03), one seam open.** Decomposition:
  (a) IDENTITY erasure — solved always-on by the opaque-`writer` + mutable-directory rule
  (§3); journal immutable, causality intact. (b) VALUE erasure — op payloads are personal
  data too (PHI by default at Better); clinical records mostly sit under GDPR Art. 17(3)
  retention carve-outs, and for the exceptional legally-required case, first-class
  snapshot-rewriting compaction redacts values incl. `prev`s. (c) Still open: the
  crypto-shredding SUBJECT INDEX (which envelopes touch which data subject) is schema
  knowledge → policy-layer seam (studio/Better compose it), not an envelope field.
