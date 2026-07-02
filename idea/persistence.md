# Persistence: local → offline-first & long-term storage

**Status:** idea/evaluation. Captured 2026-07-02. Scope boundary with the concurrency roadmap:
`idea/concurrency.md` item 4 covers **short-term offline bridging** (IDB read cache recipe +
mutation-queue persistence + replay) and is sequenced there. THIS file is the long-term question:
what does real offline-first / durable local state look like for mmstack.

## Current state

- `packages/local` is currently just the IDB layer (`local/idb`); the old form/* -era surface is
  gone. queryResource's IDB persistence rides it.
- Prior decision (memory): evaluate **signalDB / dexie** rather than reviving `local` as a
  hand-rolled store — don't rebuild a database.

## The evaluation to run (docs-first, before any code)

1. **What's the unit of durable state?** Query cache entries (already solved-ish), store subtrees
   (the op-log journal makes this cheap — persist ops, replay on boot, compact via snapshot;
   [[store-oplog]]), or collections/entities (where signalDB/dexie live).
2. **signalDB vs dexie (+ liveQuery) vs raw IDB:** signalDB is signals-native but young; dexie is
   battle-tested with reactive queries but its reactivity needs bridging into signals. Either way
   the mmstack surface should be thin: a persistence *adapter* seam, not a database.
3. **Relationship to entity `service()`** (concurrency item 3): the service layer's cache-key
   conventions are also the natural persistence keys — one more reason service() comes first.
4. **Relationship to mesh-sync:** offline-first + sync is the same op-journal replayed to a peer
   instead of to disk. Design the journal once ([[store-oplog]]), spend it three times
   (boot-replay, mutation replay, sync).

## Non-goals (for now)

Full offline-first guarantees (conflict-free arbitrary-duration divergence) — per the earlier
scoping: bridge short offline periods well; if full offline falls out cheaply from the journal +
merge3 machinery, fine, but it's not the target.
