# Mesh sync: collaborative / multiplayer store architectures

**Status:** long-term idea ("ideas for now" tier). Captured 2026-07-02.

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
