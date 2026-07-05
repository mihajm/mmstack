# Mesh sync: collaborative / multiplayer store architectures

**Status: PROMOTED to next design frontier (discussion with Miha, 2026-07-03).** The pitch is
"your store, shared across boundaries", not "WebRTC": streamResource covers server-authoritative
live data; mesh covers multi-writer convergence, and its relay rung doubles as studio/app-builder's
save/collab/history layer (smart-client dumb-server selects FOR this protocol — the server can't
be a merge authority when it doesn't understand the schema). Sequencing: presence + tab-sync first
(client-only), server-ordered relay second, WebRTC last mile. Originally captured 2026-07-02.

## Trust model (2026-07-03 — the retrofit-critical part)

Three structural decisions MUST land in v1 because the op log is also the persistence format
(changing them later = migrating stored history, not refactoring):
1. **Op envelope carries attribution** (clientId/auth subject), sequence position, and a
   policy-version field — even before anything reads them. No attribution = no audit, no
   ejection, no per-writer ACL, ever.
2. **Deterministic rejection = tripwire.** Honest clients validate before EMITTING, so any
   invalid op on the wire means a buggy/malicious peer → deterministically eject that writer
   (skip-op mid-log forks stores; never do that). Contract exists in v1 even while the default
   policy is allow-all.
3. **Policy version in the room handshake** — mixed validator versions are the silent-fork
   scenario; refuse-to-join on mismatch.

Validation itself is mechanism-not-policy, same shape as telemetry's AttributePolicy:
- mmstack ships an `OpPolicy` seam ({ canWrite?(ctx, path), validate?(op) }), pure and
  deterministic, run symmetrically on emit AND apply. Validate-on-apply means honest clients
  refuse garbage, so a malicious peer corrupts only its own view while the relay stays dumb.
  `prev` on ops gives schema-free compare-and-set integrity for free.
- The reference relay gets two optional dumb hooks: path-prefix write ACL from auth claims
  (S3-key-policy style) + rate/size limits. The security boundary without schema smarts.
- Studio composes: derive a path-keyed OpPolicy from app shapes (derive-zod already exists),
  deploy the same policy to client engine + relay hook. Schema knowledge stays in studio's repo.
- The generic ~200-line reference relay is a community deliverable ("no lock-in" demonstrated);
  studio's relay = that + its derived policy.

## Agent as a peer (2026-07-03 — fold into the design; Miha: "sells me even more on mesh")

An LLM collaborator joins a room as a REGULAR peer: same op protocol, same presence channel,
narrower `OpPolicy` (path-scoped write ACL), every op attributed and revertible via the log,
tripwire ejects misbehavior. No privileged "AI integration" API — an agent is a principal with
tighter ACLs. SDUI completes it: a schema-described UI is machine-legible, so the agent acts on
state, not screenshots, and undo works on its changes like anyone else's.

Design implications to honor in v1:
- `OpPolicy` ctx must express non-human principals (kind/subject on the auth claims).
- Presence vocabulary must not assume human cursors (agent presence = activity descriptor,
  e.g. "editing pricing section").
- Per-principal rate/size limits matter more once peers can be programs.
This is a relay-rung headline use case, not a P2P one.

## Packaging (2026-07-03 decision)

Two packages — because peerDependencies are per PACKAGE, not per entry point (a pure `/server`
entry of an Angular-peered package still drags @angular/core into server installs):
- **`@mmstack/mesh-protocol`**: zero-dep, runtime-agnostic, plain-tsc build. Op envelope, message
  types, OpPolicy, handshake constants, pure ordering/rebase helpers, and the reference relay
  core (injected `{send,onMessage,onClose}` socket + storage interfaces → zero runtime deps;
  ws/Durable-Objects/Bun adapters are doc recipes, not deps). Split a `-relay` package out only
  if it grows. **Durable Objects are the reference deployment story** (Miha 2026-07-03: a mesh
  room IS the actor pattern) — the DO adapter recipe is first-class docs, not an afterthought.
- **`@mmstack/mesh`**: the Angular client sync engine over the store op-log (peers:
  @angular/core, @mmstack/primitives, mesh-protocol). Transports as entry points WITHIN it
  (same peer set): BroadcastChannel in core, `@mmstack/mesh/webrtc` later.
Dependence: client → protocol, relay → protocol, never client ↔ relay.

## The vision (Miha's framing)

WebRTC / signal integration with store in mind — "mesh sync" enabling collaborative architectures:
multiplayer, but fine-grained. Not a document CRDT bolted on; the reactive store itself is the
synchronized artifact, at leaf granularity.

## The shape

Transport-agnostic core over the op stream ([[store-oplog]] — `idea/store-oplog.md`): a sync
engine consumes local ops, ships them over a channel, applies remote ops, and resolves conflicts.
The transport is a plug:

| transport | topology | gets us |
| --- | --- | --- |
| BroadcastChannel | same-origin tabs | multi-tab consistency, zero infra — ship first |
| WebSocket relay | star | classic collaborative app; server orders ops (no conflict ambiguity) |
| WebRTC data channels | mesh | P2P, low-latency; needs a signaling server anyway (reuse the relay) |

The ladder matters: **tab-sync is shippable soon and independently valuable** (two tabs of the
same app stay consistent — also applies to the query cache: broadcast `cache.update`/invalidations
from concurrency item 3, so a mutation in one tab refreshes the other). Every rung reuses the same
op protocol; WebRTC is the last mile, not the foundation.

**Tab rung = a `tabSync(store, { id })` overload (Miha, 2026-07-03). BUILT 2026-07-04.** `tabSync` already exists
in primitives (MessageBus multiplexed BroadcastChannel, echo guard, injector/destroy ergonomics,
server no-op); the store overload ships ops instead of values, and opLog's echo-free `apply`
replaces the received-marker dance structurally. Explicit `id` required (no deterministic-id
path). Genuinely new pieces, all RFC-scoped: (1) join/hydration handshake — op sync REQUIRES a
shared base (sync-request → snapshot + position → buffered ops), unlike value-mode's
first-change-wins; (2) HLC/Lamport timestamp in the envelope for per-leaf LWW tie-break —
BroadcastChannel has no sequencer, so the tab rung is the HARDER consistency case and the honest
proving ground; (3) layering: the CORE op envelope lives in primitives beside opLog (primitives
never imports mesh-anything); @mmstack/mesh-protocol layers wire/room concerns (rooms, auth,
OpPolicy, relay handshake) on top.

## Conflict handling (the real design work)

- Server-ordered (relay) topology: no conflicts, just rebasing local-pending ops — do this first.
- Mesh topology: per-leaf **LWW** (Lamport/HLC timestamps) as the default — fine-grained leaves
  make LWW much less lossy than document-level LWW, which is the whole point of "multiplayer but
  fine-grained."
- Escape hatch where LWW is wrong: `merge3` (already in fork-store) with `prev` from the op as
  base; per-path merge policies, mirroring how changedEqual rules attach in forms.
- Arrays are the hard part, as always (see op-log array semantics: keyed ops where identity
  exists). Text collaboration (character-level) is explicitly OUT — that's Yjs/Automerge territory;
  document interop with them rather than reimplementing CRDTs.
- Presence/awareness (cursors, selection, who's-here) is a separate **ephemeral** channel — no
  persistence, no conflicts, trivially LWW. It's also the flashiest demo for the least work;
  a good first "multiplayer" deliverable even before state sync.

## Fit

- Community: signals-native multiplayer with no backend lock-in would be a loud release.
- app-builder: collaborative editing of app definitions (the builder itself is a store-shaped
  editor) — and later, end-user multiplayer features in built apps.
- Prior art to study before designing: Yjs awareness protocol, Automerge sync protocol, Replicache
  / Zero (server-authoritative rebase model — closest to the relay rung).
