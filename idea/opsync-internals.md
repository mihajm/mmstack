# opSync internals — the sync "heart" (for the next agent)

**Status:** implementation reference, current as of 2026-07-06 (local-pending-as-branch refactor +
durable outbox + cross-tab lock all shipped, uncommitted). This is the WHY behind
`packages/primitives/src/lib/store/op-sync.ts` and its meshSync wiring — read it before touching
`receive`, emission timing, or the outbox. The terse status ledger lives in the memory
`sync-frontier-harness-next.md`; this is the narrative so you don't re-derive it.

## 1. What opSync is

Wires a copy-on-write signal (a `store` root) to the op protocol. `opLog` (op-log.ts) is the
diff-based emission core underneath: it observes the source per tick and emits minimal op batches.
opSync adds identity (origin/writer), HLC stamps, the converging-apply register map (`conv`), the
watermark, and the transport seam (`subscribe`/`receive`/`flush`/`hydrate`/`seed`/`snapshot`/`restore`).
It backs BOTH `tabSync` (unsequenced P2P over BroadcastChannel) and `meshSync` (relay). `opLog.apply`
is echo-free by baseline advance; that is what terminates sync loops.

## 2. The receive refactor (local-pending-as-branch) — the crux

**OLD (flush-then-apply), the bug:** `receive` did `clock.observe(remote) → log.flush() →
conv.ingest(remote) → log.apply`. Two defects: (a) `log.flush()` ran AFTER observe, so pending local
writes got re-stamped causally-AFTER the remote and ALWAYS won a same-path conflict — which in symmetric
P2P means BOTH peers conclude they won → DIVERGENCE, not a tiebreak; (b) the flush emitted synchronously
into the transport → re-entered the relay → the relay broadcasts BEFORE its onCommit → other peers'
receive re-entrantly flushed too → onCommit fired in scrambled (non-seq) order.

**NEW (freeze-before-observe + tick-deferred outbox):**
```
receive(env):
  dedup by (origin, version); gap hook
  receiving = true
  log.flush()          // freeze pending local NOW: stamped by a clock that has NOT yet observed
                       // this remote → keeps its ORIGINAL (causally-independent) stamp. Emission is
                       // suppressed (see outbox); this only registers + stamps + advances baseline.
  clock.observe(env.hlc)
  conv.ingest(env)     // dominance resolves local-vs-remote by honest stamps
  if (ops) log.apply(ops)  // VISIBLE ROLLBACK: a local write that LOST its path rolls back here
  receiving = false
```

**Fable's ruling (2026-07-06), distilled — this is the authority for the design:**
- Keep the register map as the base (order-independent, LWW-converging). "Rebase" degenerates to
  re-ingesting pending as local envelopes; invert-apply-reapply (`rebaseOps`) is NOT needed here.
- ORIGINAL stamp, never re-stamp. "Local auto-wins" is the symmetric-form divergence bug.
- The real invariant behind "stamp at write time" is: *stamped by a clock that has not yet observed
  the remote being ingested* (causal independence). `opLog` has no `set()`-time hook, so
  freeze-at-first-flush-INSIDE-receive-BEFORE-observe realizes it for the only window that matters
  (set → first receive). This is why observe MUST move after `log.flush()`.
- Both topologies (the receive-flush fix also fixes meshSync onCommit ordering).

## 3. Emission timing — the outbox + why tick-deferral is mandatory

The freeze registers the pending write and gives it a stamp, but must NOT emit to the transport
synchronously (that is the re-entrant cascade). So emission is DEFERRED:

- `emitLocal` stamps + registers (conv-local, recentLocal, watermark) and, if `receiving` OR the outbox
  is non-empty, pushes the envelope to `outbox` instead of notifying subscribers. Once a drain is owed,
  LATER writes queue too, so wire order == version order (else a receiver dedups the older frozen one).
  Fable's edge: drain emits the frozen stamp VERBATIM, never re-stamps; a write between freeze and drain
  gets its own stamp + separate batch, never merged into the frozen one.
- The outbox drains on a FUTURE Angular tick via a dedicated `effect` (drainTick signal). Public
  `flush()` and `destroy()` also drain (Fable's edge 3: don't lose frozen pending on teardown).

**Why a FUTURE tick and not "drain at end of receive":** the relay broadcasts (relay.ts:419) BEFORE it
calls onCommit (line 420). Anything that emits synchronously inside a receive — even an end-of-receive
drain — re-enters the relay and commits a nested envelope before the outer onCommit unwinds, so onCommit
stays scrambled. ONLY emission that lands on a later tick, fully outside the receive callstack, makes
onCommit fire in seq order. This is non-negotiable; do not "optimize" it back to synchronous.

**Why an Angular effect specifically:** BOTH sim harnesses (mesh/client/src/lib/sim) are fully
SYNCHRONOUS (no `await`); they only advance via `TestBed.tick()` (+ fake-timer drain). Microtask
deferral (`queueMicrotask`) NEVER flushes mid-run → dead. A macrotask (`setTimeout`) does not fire in
the baseline runner (no fake timers, no awaits). The one mechanism both runners advance is an Angular
effect firing on `TestBed.tick()`. Hence the drain rides an effect.

**canDefer = !opt.driver (topology gate, NOT a semantic fork):** deferral arms only on the injector path
(tabSync/meshSync — the topologies that re-enter a relay). The custom-`driver` path (worker mirror, pure
sim, op-compose multi-reader) has no such re-entrancy and emits synchronously. The STAMPING fix
(freeze-before-observe) is identical either way — deferral is purely about transport timing. The gate
was FORCED by a real bug: op-compose's `manualDriver` has a single `run` slot, so a second `opt.driver()`
call for the drain reaction clobbered opLog's. Do not create a second reaction from `opt.driver`.

## 4. Structural fix — emit version derives from the watermark map

Dropped the separate `let version` counter; the emit version is now `(versions.get(origin) ?? 0) + 1`,
i.e. `versions.get(origin)` IS the counter. This fixed a latent post-reboot regression Fable caught: a
hydrate/restore that raises our own watermark must also advance the next mint, else the next write
re-mints a version the room already acked → the relay dedups it → SILENT LOSS. Deriving from the map
makes that structural: raising the watermark raises the counter, always.

## 5. restore() + durable outbox (reboot survival)

`restore(envs, highWater?)` re-injects an origin's persisted local envelopes on boot WITHOUT minting new
versions: per env → `log.apply` (echo-free) → `conv.ingest local` → recentLocal → observe hlc → notify
(so the transport resends the unacked tail). Then watermark = max(env.versions, highWater). ORDER matters
(apply, ingest-local, observe-before-any-mint, notify last) and it must run on a FRESH instance BEFORE
any receive/hydrate (Fable: restoring onto already-ingested remote winners would wrongly override them).

meshSync `outbox?: {key, store: AsyncStore, debounceMs?, crossTab?}` persists `{origin, version, envs=
unacked}` debounced (immediate on boot + close). It DEFERS opSync construction + connect until the async
load resolves, so it adopts the persisted STABLE origin (origin immutability keeps echo-suppression + ack
tracking sound — a changed origin would resend forever + never ack). `highWater` covers the edge where a
version was acked pre-reboot but dropped from the debounced outbox (persist the counter high-water, not
just the tail). The relay acks duplicate resends by re-sequencing + re-broadcasting (no dedup — verified
in relay.ts), so a resent tail clears.

## 6. Cross-tab single-writer lock (crossTab: 'queue' | 'off', default queue)

Two tabs sharing one outbox key would restore the same origin and collide on mints → silent divergence +
loss (peers drop one of two same-version envelopes; each tab acks-but-never-applies the other). So
'queue' (default, opt-OUT because the failure is silent) holds an exclusive Web Lock on
`@mmstack/mesh:outbox:${key}` for the tab lifetime, acquired INSIDE the deferred boot, released on
teardown; an AbortController cancels a still-queued request if we tear down before grant (so it can't
resurrect and steal the lock later). A second tab WAITS (status stays 'connecting', the reactive
pending/ready surface). No `navigator.locks` → dev-warn + degrade to no-lock. 'off' = app coordinates
(cleanest DIY today: leader passes outbox, followers omit it → live-ephemeral for free). Reserved future
'ephemeral' (non-leaders live with a throwaway origin) = non-breaking union widening; undefined stays
'queue'.

## 7. The two behavioral flips (regression signals) + a test gotcha

- op-sync.spec CHARACTERIZATION flipped: `run(1,100)→'remote'`, `run(100,1)→'local'` (honest physical
  clocks decide the same-path conflict, no self-favouring re-stamp).
- NEW sim invariant `commitOrdered(journal)` (mesh sim/invariants.ts): onCommit now fires in seq order,
  held across 100+ seeds (+ a rejection meta-test). The re-entrant flush is gone. `seqDense` /
  `journalFoldsFrom` keep their defensive `.sort` as belt-and-suspenders.
- TEST GOTCHA (not a bug): a FRESH-room concurrent seed race — two fresh peers seeding a brand-new room +
  a restored env stamped at test-time Date.now losing the writer tiebreak to a peer's whole-root seed — is
  the DOCUMENTED relay hazard (relay.ts docstring "rooms created by a single client first are
  unaffected"), reproducible essentially only under zero-latency in-process transport. A reboot reconnects
  to an EXISTING durable room, so it never hits this. Write integration tests with realistic topology
  (establish room, THEN joiner), not concurrent fresh seeds.

## 8. Where this sits / what's next

The conflict-precedence + branch-first-AI + provenance decisions that came out of the same review are in
[[conflict-precedence-and-agent-governance]]. Relates to [[op-protocol-rfc]] (normative spec),
[[branching-state]] (boot arbitration = restore's consumer), [[evolution]] §8 (the sim harness that
characterizes these). NEXT candidates: 'ephemeral' crossTab mode (consumer-gated); a relay-root vs
client-root divergence sim invariant; the precedence/rank work (§1 of the governance note).
