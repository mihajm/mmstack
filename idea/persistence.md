# Persistence: local → offline-first & long-term storage

**Status: RESOLVED 2026-07-04 (discussion + build).** The old monolithic `@mmstack/local`
offline-first lib is dead: the direction moved under it once the op-protocol landed. The
reconciliation engine (the hard 80%) lives in `@mmstack/primitives` (opSync, rebaseOps, merge
policies, storeHistory). The missing piece is now built: **`persistedStore`** (primitives) — a
store whose whole-value snapshot persists to an async backend and restores on boot, with
`providePersistedStoreOptions` to wire the backend once. Schema evolution via `version` + async
`migrate` (envelope on disk when versioned; older snapshot migrated forward on boot then re-persisted,
newer-than-build left untouched; migrate is async so the ladder can be lazy-imported — app-builder's
intent). No redundant write-back of a freshly hydrated snapshot (persistedRef tracks the on-disk ref;
migrated snapshots still heal). 16 specs, 600 primitives green.

Key decisions:
- **Bring-your-own backend, not bundled IDB.** `persistedStore` ships no IndexedDB code; takes an
  `AsyncStore` adapter ({ get, set, del }). Interface designed against BOTH idb-keyval (drops in
  directly) AND Dexie (~4-line table adapter; it names things put/delete). idb-keyval wins naming.
- **Not shipping idb-keyval as a dep** keeps primitives dependency-free.
- **resource left as-is.** Its IDB cache stays; it can later adopt the same AsyncStore interface to
  drop its copy (separate resource-API decision).
- **persistedStore vs resource cache = siblings over the interface**, not one on the other (a cache
  is not an op-journaled reactive store; only the bottom keyed-blob layer is shared, now an
  interface not shared code).
- **Better's studio-layer backend is a blob store** (S3/folder, clients load all upfront) — the
  dumbest server, ideal local-first case. Offline = persistedStore (IDB) + op-journal; blob store is
  the durable log, direct or as the mesh relay's storage backend. Studio/resource layer, NOT the
  EHR/FHIR clinical layer (which owns the audit/GDPR apparatus).

**(historical eval below, superseded)**

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
