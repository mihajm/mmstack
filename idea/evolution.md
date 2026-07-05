# Evolution: how a distributed, persisted op system changes shape (designed 2026-07-05)

Status: DESIGN (Miha-prompted: "important for long term"). Nothing here is built except where
marked. Companion of op-protocol-rfc.md (§3 envelope, §6 handshake, §7 trust); this doc owns
the cross-layer story the RFC leaves per-layer.

## 1. Problem

Every layer versions itself, nobody owns a rolling upgrade:

- `proto` (wire shape) and `policyVersion` are exact-match-or-reject at hello and per envelope.
  Correct, but a policy deploy ejects every connected client until refresh — outage-shaped.
- persist has `version` + `migrate`, but it migrates OUT OF BAND (disk snapshot → new shape
  locally). Composed with mesh, a schema-migrated local root can then receive a `delta` answer
  of old-shape ops → undefined state. The boot race we documented (disk vs welcome) gets a
  third axis: shape.
- `relay.hydrate` (shipped 2026-07-05) restores persisted rooms but has no migrate hook —
  server-side snapshots age with no path forward.
- Mixed-version rooms: an old client and a new client concurrently emitting different shapes
  into one room has no defined semantics at all.

## 2. The three version axes (different compatibility rules on purpose)

| axis | what it versions | rule |
|---|---|---|
| `proto` | envelope/wire shape | exact match, bump ≈ never (evolve additively) |
| `policyVersion` | the pure validation fn | exact match — REQUIRED for tripwire soundness: a violation only proves hostility if both sides ran the same function. Never loosen. |
| `schemaVersion` (NEW) | the shape of the room's data | the missing axis; rules below |

The fix for outage-shaped rejects is never loosening the match — it is making the TRANSITION
graceful (§5) and the reject SPEAKABLE (§6).

## 3. Core principle: migrate through the log, never out of band

The journal is the persistence record and the audit trail. A schema migration is therefore an
ENVELOPE — a root-set (or targeted ops) emitted by a privileged writer that transforms the
room from shape N to N+1, carrying a schema marker. Everything downstream works by
construction:

- Journal replay is safe forever: v1 ops apply to v1 state, the migration envelope flips the
  shape at its seq, v2 ops apply after. The "old journal tail onto migrated root" hazard only
  exists when state is migrated OUTSIDE the log and old ops are replayed on top. Banning that
  is the whole rule.
- `relay.hydrate` needs no migrate hook: migration went through the log, so compacted
  snapshots are post-migration automatically.
- Audit keeps working: the migration is attributed (writer = the migrator principal — an
  agent is a user, §0) and invertible like any other envelope.

## 4. The evolution contract (docs-able, two sentences)

**Additive changes are free and versionless.** New paths fold into the root; old clients
ignore paths they don't render; `set` on a field old clients don't know is harmless. Design
schemas open (records, optional fields) so almost every change is additive.

**Breaking changes are a logged migration plus a coordinated reload.** Bump `schemaVersion`,
emit the migration envelope, invalidate watermarks (§5), and old clients get told to update
(§6). No compatibility window in v1: we control the clients (SPA reload gets new code), so
lockstep is honest and simple. A Kafka-style N/N+1 window is a LATER rung, added only if a
consumer (CMMN engine with uncontrolled clients?) demands it.

## 5. Mechanics

- **Watermarks are schema-scoped.** Reuse the existing epoch machinery: a migration bumps the
  room epoch (or a parallel schemaEpoch), every watermark dies, every client re-hydrates via
  snapshot. Nobody ever applies cross-shape deltas. Cost: one re-snapshot storm per migration
  — fine for a rare event.
- **Old clients at migration time:** they receive the epoch bump / schema marker, recognize
  a schemaVersion above their own, and stop applying + surface 'outdated' (§6). The existing
  "newer build wrote it, leave it untouched" stance from persist generalizes: never
  downgrade-interpret newer-shape data.
- **Hello carries schemaVersion.** Tri-state answer gains a fourth: `reject {reason:
  'schema', expected}` when the client is older than the room. (A client NEWER than the room
  may join read-only or trigger migration per §7 — v1: reject too, migrator handles it.)
- **persist × mesh composition rule (doc + one guard):** for a meshed store, the mesh answer
  is the shape authority; disk is offline fallback. persist's local `migrate` remains correct
  for the offline/single-user case; when meshed, a schema-stale disk snapshot must not be
  adopted over a pending welcome — tie adoption to the same epoch check. (This is also where
  the boot-arbitration work lands: sources become comparable by (epoch, watermark, schema).)
- **policyVersion deploys ride the same UX path:** reject at hello already carries
  `expected`; the client surfaces 'outdated' instead of a dead socket. Policy and schema often
  bump together (schema-derived policies); axes stay separate because they don't have to.

## 6. The 'outdated' surface (item 3 folded in: sync-health)

One composed, user-facing health signal per synced store — the missing production surface:

```
syncHealth: Signal<{
  status: 'live' | 'behind' | 'offline' | 'outdated' | 'ejected' | 'degraded';
  behindBy?: number;        // seq distance when resumable
  reason?: 'proto' | 'policy-version' | 'schema' | 'quota' | 'worker';
  lastSyncedAt?: number;
}>
```

- 'outdated' = any versioned reject → the app's cue for an update/reload prompt. This turns
  every §2 hard-match from an outage into a banner.
- 'degraded' = persistence failing (quota, backend errors — today swallowed as dev-mode
  warns; they need an error channel to feed this), worker dead, etc. Local-only wiring,
  no protocol change.
- Feeds: meshSync status + reject reasons, persist error channel, worker liveness. Composition
  is a small primitive over existing signals; design detail deferred to implementation.

## 7. Who runs migrations (v1 answer)

A **deploy-job migrator**: a principal with root write rights (pathPrefixAcl `[]` +
`kind: 'migrator'`), run as part of the deploy — connects, reads room schemaVersion, emits
the migration envelope + epoch bump, disconnects. Explicit, controlled, auditable.
Client-driven auto-migration (first v2 client migrates the room) is DEFERRED: it needs
double-migrate arbitration (compare-and-set on the room's schemaVersion at the relay) and
makes every client carry the migration ladder. Revisit only if deploy-job proves annoying.

## 8. Simulation harness (item 4 folded in: the proof tool for all of the above)

Deterministic distributed simulation over the already-injected seams (no lib changes needed —
sockets, clocks, transports are all injectable BY DESIGN):

- **Core:** seeded PRNG + virtual clock + a scheduler that owns all message delivery. Fake
  transport with per-link latency, reorder, drop, and partition controls. N peers (L0
  opSync/opLog for speed; a thin layer reuses mesh's fake connectors for client-level runs)
  + one relay (in-memory sockets, injected `now`).
- **Invariants asserted at quiescence:** (1) all honest peers converge to identical roots;
  (2) fold-from-scratch of the journal equals the final root (audit determinism); (3) no
  tripwire ejects among honest peers; (4) watermarks monotone per (epoch, origin); (5) after
  partition heal, offline edits land per MergePolicy with no loss.
- **Property mode:** random op streams per peer × random schedules, seed printed on failure
  for exact repro. Run a few hundred seeds in CI (they're milliseconds each — everything is
  sync + virtual time).
- **Scenario deck (the §1 hazards, executable):** partition-heal; relay restart + hydrate
  (with and without epoch/journal); migration mid-flight; migration during partition (old
  client heals into a migrated room → must surface 'outdated', not corrupt); boot race disk
  vs welcome vs writes; zombie writer; rate/policy ejection under load.
- **Where:** `packages/mesh/protocol` spec-level harness first (zero Angular, fastest loop),
  promoted to a small shared testing util if worker/branching want it (they will — rebase and
  branching share the machinery per roadmap §2).

## 9. Sequencing

1. Simulation harness first (§8) — it proves current behavior before evolution changes it,
   and the migration scenarios then become TDD for §5.
2. 'outdated'/sync-health surface (§6) — small, local, immediately useful, no protocol change.
3. schemaVersion in hello + schema reject + epoch-bump-on-migration (§5) — the protocol
   delta, small and additive (proto unchanged: new optional hello field + new reject reason).
4. Migrator recipe + docs of the §4 contract.
5. N/N+1 compatibility window — only on demonstrated need.

Everything is additive to the shipped experimental surface; nothing above forces a proto bump.
