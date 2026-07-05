# Frontier roadmap (sequenced 2026-07-03)

## STATUS 2026-07-05 (night 3): mesh COMPLETE through WebRTC + review + devtools + undo
All Phase 3 rungs built AND adversarially reviewed (3 fresh-eyes agents, findings verified +
fixed): mesh-protocol relay, mesh client (ws+direct+P2P transports), presence, tripwire,
reconnect/rebase, epoch/ghost-member fixes. Plus: keyedArray merge, storeHistory undo/redo
(collaborative-safe), concurrency instrumentation seam + perfCustomTracks (devtools 1),
playground /mesh demo (10/10 browser). Deferred with precise scoping: store-leaf debugNames
(devtools 2, idea/store-leaf-debugnames.md — core-surgery risk not worth a night sprint).
Query-cache cross-tab = already shipped (cache.ts syncTabs). Everything green except pre-existing docs:test.

**UPDATE 2026-07-04: browser e2e SHIPPED.** The two deferred mesh follow-ups are done, plus a
persistedStore one. A real Node relay (createRelay + pathPrefixAcl over `ws`) runs as a Playwright
webServer; new playground routes /webrtc, /mesh-agent, /persisted-store; specs prove real
RTCPeerConnection P2P convergence (relay carries signal frames, never env — via a /stats endpoint),
the relay tripwire ejecting an out-of-scope agent, and persistedStore on real IndexedDB incl. the
v1→v2 migration heal. Full playground-e2e suite 60/60. WebRTC loopback flake fixed with mDNS launch
flags. Remaining mesh-adjacent: store-leaf debugNames (devtools 2) only. Next feature: dnd phase 3.

**worker + mesh compose (proven 2026-07-04).** app-builder can offload the graph to a worker AND mesh it,
via a main-thread bridge (worker-mesh-bridge.ts) with NO lib change — one device = one mesh origin (worker
is the device's local sequencer; mesh peer = the device). meshSync stays on main (worker is DI-free by design
+ WebRTC is window-only), matching "effects are edges". /worker-mesh demo + worker-mesh.spec (61/61 total)
prove a remote edit converges THROUGH the receiving device's worker (its worker-computed value updates).
Bridge = local mirror + meshSync(mirror) + two directional effects (each tracks only its source) + a
lastSynced guard to break the two-way echo. LIMITATION: sequential/turn-taking edits converge; true
concurrent-burst convergence wants the worker to preserve origin/writer on broadcasts (op-level provenance)
— the natural "graduate the bridge into @mmstack/worker" enhancement.

**Evolution story DESIGNED 2026-07-05 (idea/evolution.md).** The cross-layer versioning gap
(per-layer version fields don't compose into rolling upgrades) got a design after the seams
review: schemaVersion as the third axis, migrate-THROUGH-the-log (a migration is an envelope;
never migrate state out of band and replay old ops on top), epoch bump kills cross-shape
deltas, 'outdated' reject surface (folds into a syncHealth signal — the production
degraded-state story), deploy-job migrator principal. Proof tool = deterministic simulation
harness over the injected seams (virtual clock + partition/reorder scheduler + convergence
invariants) — build the harness FIRST, migration scenarios become its TDD. Also pinned in RFC
§7: room = confidentiality boundary (write ACL not read ACL; relay reads plaintext, E2EE
incompatible with server-side compaction). Relay persistence seam (onCommit + hydrate) shipped
same day.

Cross-cutting order for the open frontiers. Rationale: (1) the op envelope precedes anything
on a wire (retrofit-critical, see mesh-sync.md trust model); (2) rebase machinery is built ONCE
and shared by branching + mesh — branching goes first because it exercises rebase in a single
runtime where bugs are cheap; (3) design-dense work front-loads before the 2026-07-07 billing
switch, mechanical work after; (4) every phase ends shippable — no dark tunnels.

## Phase 0 — pre-7/7: the op protocol RFC ✅ DRAFTED 2026-07-03
`idea/op-protocol-rfc.md` — envelope (origin≠writer, HLC, policyVersion, prevs stay on wire),
two-topology convergence (relay seq; unsequenced per-path LWW register map + subtree dominance),
shared rebase (invert → apply remote → re-apply via MergePolicy), join handshake, OpPolicy +
tripwire, L0-in-primitives layering, rollout ladder, DX contract (§10: synced store
indistinguishable from local at the read site; semantic knobs only, never temporal) + prior
art (§11: Figma per-property LWW, Linear invisible-sync bar, Orleans activation, Replicache
intents as optional layer, Horde handoff, waveless, Electric shapes, openEHR contribution fit).
Awaiting Miha's redline; open questions are §12 (all small). The concurrency presentation
keeps the rest of the weekend.

## Phase 1 — instrumentation wave (post-7/7, designed, bounded sessions)
- devtools seam impl in primitives + telemetry consumer + perf-custom-tracks preset
  (idea/concurrency-devtools.md)
- resource refetch instrumentation (telemetry RFC §8.2 last 1%)
- debugName path-propagation on store leaves (standalone DevTools win)
- telemetry docs pages + RELEASE (ready now; Miha's trigger)

## Phase 2 — branching state (client-only; de-risks the shared core)
fork/commit/discard + frame-bound lazy views + branch.run (sync-only), then rebase +
merge-policy surface. Follow-ups that make the release headline: optimistic mutations as
branches, undo/redo from inverse ops. Home: primitives/store extension.

## Phase 3 — mesh, rung by rung
1. ✅ BUILT 2026-07-04 (overnight session): L0 in primitives (hlc.ts + op-sync.ts — envelope,
   HLC clock, createConvergingApply register map w/ subtree dominance, rebaseOps, MergePolicy
   with lww/mergeThree/preserve, opSync with snapshot/hydrate) + the `tabSync(store, { id })`
   overload with the hello exchange (buffer-while-joining, first-responder jitter, timeout →
   base, pre-hydration local writes rebased on top). 33 new specs incl. the shuffled-arrival
   order-independence property suite; 562 primitives tests green. Two protocol amendments
   forced by tests, folded into RFC §4: total order includes ORIGIN; lineage equality is
   STRUCTURAL. Remaining in this rung: query-cache cross-tab invalidation wiring (separate,
   uses plain tabSync), keyed-array identity seam (§12, interface TBD).
2. ✅ BUILT 2026-07-04 (night 2): @mmstack/mesh-protocol (packages/mesh/protocol, zero-dep,
   tsdown build) — canonical wire types (structural twins of L0, compile-asserted), tri-state
   welcome with DELTA + presence roster, OpPolicy/checkEnvelope/pathPrefixAcl, reference relay
   core (seq, journal + snapshot compaction incl. delete folding, tripwire eject + blacklist,
   writer-mismatch guard, ops/rate limits w/ injected clock, presence fan-out). 10 fake-socket
   specs. Fresh-room contract: relay answers up-to-date at seq 0, CLIENT seeds a root-set
   (opSync.seed() added to L0) so room roots are complete forever.
3. ✅ BUILT 2026-07-04 (night 2): @mmstack/mesh (packages/mesh/client, Angular) — meshSync():
   transport seam (webSocketTransport + directTransport for in-process relays/tests),
   reconnect w/ expo backoff, delta resume + unacked-rebase, emit-side policy honesty,
   presence signals (roster/live/gone), transition-scope registration, eject surface. 7
   full-loop specs (2 clients + relay in memory): seed→snapshot→live merge, delete folding,
   reconnect+offline-write rebase, tripwire eject, presence, per-path preserve. keyedArray
   identity merge landed in L0 (8 specs) — wire format untouched (§12 v0 resolution).
4. ✅ playground multiplayer page BUILT 2026-07-05 (apps/playground /mesh: 2 clients + in-page
   relay, keyedArray todo merge, collaborative undo, presence, disconnect/reconnect+rebase;
   10/10 real-browser checks). agent-as-peer demo still pending (design ready).
5. ✅ WebRTC transport BUILT 2026-07-05: relay signal-routing + member broadcasts;
   webRtcMesh (P2P converging via per-path register map, pairwise catch-up), rtcPeerConnector
   with perfect-negotiation, injectable connector seam (fake-channel specs). Browser e2e of
   actual RTCPeerConnection deferred to a real page (logic proven over linked fake channels). — transport SEAM is proven (MeshTransport); WebRTC needs
   signaling messages (offer/answer/ice via relay), deliberately deferred rather than rushed.
Studio-side (other repo): schema-derived OpPolicy, collab editing against rungs 3-4.

## Phase 4 — unlocked afterparty
- server as subtree owner (un-parks once relay exists — worker-graph.md)
- §12 signal-graph instrumentation (once telemetry has real-world mileage)
- persistence eval (relay storage interface will have sharpened the signalDB/dexie question)

## Milestone rhythm
telemetry release → instrumentation/devtools → undo+optimistic → multi-tab → multiplayer.
