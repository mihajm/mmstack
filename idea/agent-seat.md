# Agent seat — packaging the headless peer

**Status:** IMPLEMENTED 2026-07-16 (Fable), same day as ratification. Session core extracted
(`packages/mesh/client/src/lib/session.ts`), meshSync rewired (118 pre-existing tests pass
unchanged + faithfulness read done), `agentSeat` + `setAtPath` + `describeOp` shipped with 21
new specs (139 total green), README + docs/mesh/agents reworked. DEVIATIONS from the ratified
draft, for Miha's review: (1) D2 placement — shipped from the PRIMARY `@mmstack/mesh` entry,
not a secondary `/agent` entry: a secondary entry cannot relative-import the internal session
module (ng-packagr cross-entry rule) so it would have forced `meshSession` into the public
API, and `@angular/core` is in the import graph via primitives' signals regardless, so the
entry bought no isolation; reversible later by adding a re-exporting secondary entry. (2)
`resync` also fires on a FIRST welcome that arrives in snapshot mode (join past compaction),
not only on later continuity breaks — "base established at seq N", harmless and honest. (3)
One pre-existing bug found during transcription and fixed WITH a pinned spec: a schema eject
carried inside a delta welcome was overwritten by the welcome tail setting status back to
'live' (ejected client reported live on a closed transport). Original draft below, unchanged.

**Status (original):** DRAFT 2026-07-16 (Fable), for Miha's redline before any implementation. This is
sync-stories.md sequencing item 5 ("agent seat as a packaged opt-in") made concrete, grounded
in the demo-branch evidence (`apps/demo-server/src/agent/seat.ts`, 260 lines) and Miha's two
requirements from the kickoff conversation: (1) 1-N agents per room, roles are user-space;
(2) studio consumes the model side through Vercel's `ai` SDK (+ tanstack/ai in play) — we
integrate, we do not reimplement; (3) prompt-cache-aligned context: stable snapshot + diff
stream so studio can cache the prefix and send only deltas (see context checkpointing).
Targets post-phase-2 master (admission gate landed: canBump/verifyCitations, reasons
`epoch-bump`/`unknown-citation`).

## The problem, stated from the demo

The demo's agent needed a mesh peer with no Angular and no browser. `meshSync` couldn't be
used (injector, signals, Web Locks, IndexedDB outbox), so the seat re-implemented the session
protocol by hand: hello, tri-state welcome (snapshot hydrate / delta replay / fresh seed),
own-origin echo filtering, unacked resend ordering, eject/reject/frontier handling, teardown.
That is a SECOND implementation of the wire-contract client — the exact composition trap the
calibration record warns about. It already drifted once: phase 2 changed `flushUnacked`
ordering (fresh-origin-last) in `mesh-sync.ts` only; the demo seat still has the old sort.
Every future implementer (studio, the Temporal bridge, any CMMN engine seat) would fork it
again. The fix is structural, not documentation.

## Shape: one session core, two shells

Extract the protocol/session state machine out of `mesh-sync.ts` into a pure,
environment-free module (working name `meshSession`), and make BOTH clients thin shells over
it:

- **Session core (pure):** owns hello/welcome/env/eject/reject/frontier handling, the
  `unacked` map + resend ordering, `ownOrigins` echo filtering, seq tracking, schemaVersion
  outdated-flip, seed-vs-hydrate decision, teardown. Talks through ports: a `MeshTransport`
  (existing seam), an `opSync` instance, plain callbacks for status/health/remote-batch
  events, injectable timers (which incidentally makes the session core directly drivable by
  the deterministic sim harness — evolution.md's proof tool — a side benefit worth having).
- **`meshSync` (Angular shell):** DI, signals/computeds, transition-scope registration,
  reconnect backoff, durable outbox + cross-tab Web Lock, persistence restore. Public surface
  unchanged — this is a refactor invisible to existing consumers.
- **`agentSeat` (headless shell):** explicit `StoreContext`, microtask op-log driver, no
  locks, no outbox (see [DESIGN] below), optional reconnect. Runs in Node, workers, edge.

**Rigor class.** The extraction touches the proven surface (envelope handling, echo/unacked
discipline, seed contract) but proves no new math — it is transcription risk, not design
risk. Obligations: the full existing mesh client suite (mesh-network, outbox, migration,
sync-health, zzz-adversarial) passes UNCHANGED against the refactored `meshSync`; the seat
shell adds its own session-level specs against the same in-memory relay; and a model↔code
faithfulness read of core-vs-old-meshSync before merge (green tells us nothing failed, not
that the transcription is complete). No invariant tags move.

## Seat API (v1 sketch)

```ts
// @mmstack/mesh/agent (secondary entry, no Angular in its import graph)
const seat = agentSeat(initialDoc, {
  room, writer,                       // same principal vocabulary as meshSync
  transport,                          // webSocketTransport(...) or directTransport(relay, ...)
  policies, policyVersion, schemaVersion, policy, ctx,   // identical option semantics
  context?,                           // explicit StoreContext (default: fresh)
  reconnect?,                         // see [DESIGN] D3
});

seat.doc          // WritableSignalStore<T> — live converging replica
seat.status()     // 'connecting' | 'live' | 'ejected' | 'closed' (+ 'reconnecting' if D3 lands)
seat.snapshot()   // JSON-serializable current doc — the context-assembly read
seat.write(fn)    // plain local write, flushed as one envelope
seat.setAtPath(path, value)  // path-addressed write (promoted from demo-shared, see tool boundary)
seat.changes(cb)  // remote batches, writer-attributed AND seq-stamped: { seq, writer, ops }
seat.stableSnapshot()  // { seq, doc } | null — cache-grade base, see context checkpointing
seat.fork()       // SyncedFork: isolated branch; commit lands as concurrent write vs captured frontier
seat.presence(data)
seat.close()
```

Everything here existed in the demo seat or `meshSync`; nothing is invented. `fork()` reuses
the same fork/frontier machinery `meshSync.fork()` has (captureFrontier + commitScope +
rebase/discard) — that seam is the productized "agent proposes, human disposes" pillar and
the headline of the docs page.

## 1-N agents (requirement 1)

One call = one seat = one writer identity = one origin = one replica. N agents (hint-giver,
adversarial reviewer, scribe...) are N `agentSeat` calls — no manager API, no roles surface.
This is deliberate:

- Identity/attribution is per-envelope `writer`, stamped by the seat's own opSync; the audit
  story ("which agent proposed what") falls out with zero new mechanism.
- Roles are governance, and governance already has a home: per-writer `OpPolicy` at the relay
  (pathPrefixAcl scoping the hint agent to `hints/*`, canBump denying agents epoch raises,
  the phase-2 admission gate applying to agent writers exactly as to humans) plus
  presence `{ kind: 'agent', role: ... }` as user-space data.
- Rail check: no new seam. A "multi-agent coordinator" would be design-decision surface with
  no named consumer; studio composing N seats IS the consumer pattern.

Costs accepted, named as non-goals: N seats in one process hold N replicas of the doc (fine
at studio's N of 2-5; a shared-replica multi-writer seat would need per-WRITE writer
attribution, which changes envelope semantics — rejected), and N seats open N transport
connections (a muxed transport is a later optimization if a real deployment feels it).

## The AI-SDK boundary (requirement 2) — our parts of the story

Division of labor, hard line: model calls, provider selection, key handling, streaming, the
tool-call loop — that is `ai` / tanstack/ai / provider SDKs, and we build NONE of it (the
demo's `AgentBrain`/anthropic.ts dies with the demo; it was scaffolding). Our side is the
STATE PLANE shaped so it drops into any tool-calling loop as plain functions:

- `seat.snapshot()` — the document as JSON for context assembly.
- `seat.setAtPath(path, value)` / `fork.setAtPath(...)` — path-addressed writes, because a
  model's tool output speaks dot-paths and primitives, not signal trees (the demo proved this
  exact shape: `{ path: "plan.endDate", value: "2026-10-11" }`).
- `describeOp(op, writer)` — generic op narration ("mira set plan.endDate to 2026-10-11"),
  default implementation of the demo's doc-specific `narrateOp`, overridable. Narrated
  batches are the natural "recent activity" context block.
- `seat.fork()` — the proposal primitive the approve/dismiss loop hangs off.

All of these are JSON-in/JSON-out and provider-free, so wrapping one as an `ai` SDK `tool()`
(or tanstack/ai equivalent, or a raw Anthropic tool) is a zod schema plus a one-line handler.
The integration deliverable is a docs recipe showing exactly that wiring — seat +
`generateText`/`streamText` + propose/comment/pass tools — against the `ai` package.

**[DESIGN] D1 — adapter entry point, not in v1 (recommendation).** A `@mmstack/mesh/ai`
entry exporting prebuilt ai-sdk tool definitions is tempting, but it would pin a peer dep and
freeze a tool vocabulary before studio has used it in anger. Rail: a seam earns its place by
a named consumer's actual shape. Recommendation: v1 ships the JSON-shaped seat + the recipe;
the adapter entry is cut only if studio's wiring shows real boilerplate worth owning. Counter
to consider at redline: shipping it day one makes the docs story punchier.

## Context checkpointing — cache-aligned reads (requirement 3, added 2026-07-16)

Studio wants prompt-cache discipline: load doc + messages + tool calls into the provider
cache once, send only diffs per turn, and re-checkpoint on its own heuristics (message
velocity, context size). The provider-cache mechanics are studio's (ai-sdk carries
cache_control); our part is making the decomposition PROVABLE, and the substrate already has
the exact concept — this is opSync's snapshot + delta-welcome principle applied to the
prompt.

**The stability rule.** In a relay room, `seq` is a total order every peer agrees on;
history at or below a seq never changes. So a prompt decomposes as:

- **Stable prefix** = the folded doc as of seq N. Provably a pure function of (room, N) —
  byte-identical on re-derivation, which is what "safe to cache" means — PROVIDED no own
  unacked writes are baked in (an optimistic local write is not yet in the total order).
  Since own echoes arrive back sequenced (the seat sees their seq before the echo filter),
  quiescence is observable and prompt: `stableSnapshot()` returns `{ seq, doc }` when the
  unacked set is empty, `null` while a write is in flight.
- **Append-only suffix** = `changes` batches with seq > N, narrated via `describeOp`. The
  relay fans out in seq order, so the suffix at seq M literally extends the suffix at seq N
  for M > N — the prefix+suffix prompt is stable-prefix by construction, no diffing logic
  needed anywhere.

Re-checkpointing is then trivial consumer code: take a fresh `stableSnapshot()`, drop
suffix entries ≤ its seq, rebuild the cached prefix. When to do it is pure studio policy.

**The one edge we must surface honestly:** a reconnect that resumes via delta welcome
preserves seq continuity (suffix-append still holds); a reconnect that comes back as a
SNAPSHOT welcome (relay compacted past our seq) breaks it — ops were skipped, the suffix can
no longer be extended. The change stream must say so: a `{ kind: 'resync', seq }` event (or
equivalent) obligating the consumer to re-checkpoint. Silently resuming the callback after a
snapshot resume would hand studio a cache that lies about history — that is the only way
this feature can go wrong, so it is the only part with a MUST.

Scope note: this is relay-topology only (P2P webRtcMesh has no total order, hence no
stability frontier). Cost check: seq-stamping `changes` and exposing `{seq, doc}` when
unacked is empty is bookkeeping the session core already does — Miha's "decently easy" read
is correct; nothing new is proven, the seq-immutability property is the relay's existing
contract.

**[DESIGN] D6 — surface size.** Recommendation: ship only the primitives above
(seq-stamped `changes`, `stableSnapshot()`, the resync event) and put the base+suffix
bookkeeping in the docs recipe (~20 lines). The tempting alternative — a `contextView()`
helper owning the buffer and a `rollForward()` — is real convenience but encodes studio's
re-cache policy shape before studio has run it; same posture as D1, revisit together after
first integration.

## What stays OUT (and where it lives instead)

The demo's loop — quiescence timers, chat inbox under `agent/*`, proposal document shape,
dismissed-rationale memory, min-interval throttles — is app policy. Baking it in freezes one
demo's opinions; it becomes the docs recipe's second half. Same for role prompts and
standing instructions (studio's domain). The relay needs nothing: agents are ordinary
writers, phase-2 admission included.

## Remaining [DESIGN] choices for redline

- **D2 — naming + placement.** `agentSeat` in `@mmstack/mesh/agent` (mirrors the
  `@mmstack/worker/host` secondary-entry precedent) vs `headlessSync`/`meshSeat` in
  `@mmstack/mesh/headless`. "Seat" is the creed's own word (a seat at the table, an agent is
  a user) and is my pick; "headless" describes the runtime, undersells the story — but the
  generic name keeps non-agent uses (Temporal bridge, device writers, tests) from feeling
  mislabeled. Could also export `agentSeat` as an alias of the generic one.
- **D3 — reconnect in seat v1.** The demo seat skipped it (in-process direct transport
  cannot drop). A remote studio seat over ws wants backoff+delta-resume, and the logic is
  environment-free timer code the core already has to host for meshSync. Recommendation: yes
  in v1 — it is shared-core code, not seat-specific code, so the marginal surface is one
  option.
- **D4 — durability posture.** No outbox in v1: an agent's writes are derivable (it can
  re-propose), and the browser outbox is IndexedDB+Web-Locks shaped. If a future consumer
  needs durable agent writes (the CMMN engine seat might), the port in the session core is
  where a Node persistence adapter plugs — named here so it is a decision, not an accident.
- **D5 — snapshot read shape.** `snapshot()` returns the folded doc only. Conflicted-path
  side-state (preserve resolver) is visible the same way the UI sees it; no register dump in
  v1. Flag if the reviewer-agent story wants conflict introspection sooner.

## Sequencing

Rides on post-phase-2 master, one commit/deploy with it (Miha's call at kickoff). Order
inside the change: (1) extract session core under `mesh/client/src/lib/`, meshSync rewired,
full suite green + faithfulness read; (2) seat shell + secondary entry + seat specs against
in-memory relay; (3) `setAtPath`/`describeOp` helpers; (4) docs page (seat + fork/proposal +
ai-sdk recipe, no-AI-tells). Studio integration validates D1 afterwards.
