# Store leaf debugName path-propagation (§12 standalone win) — DEFERRED, scoped

**Status:** deliberately deferred from the 2026-07-05 night run (production-grade discipline:
not rushing the store core at midnight). ~30 min of careful work when fresh; NOT blocked on
any design question. From idea/op-protocol-rfc.md §12 / concurrency-devtools.md.

## The win
When a store root carries a `debugName`, vivified child leaves get `${root}:path.to.leaf`, so
Angular DevTools' signal graph shows named leaves instead of anonymous ones. Zero telemetry
involvement; valuable on its own.

## Why deferred (the exact entanglement)
`buildChildNode` (packages/primitives/src/lib/store/store.ts:131) builds each child via
`derived(target, { from, onChange, equal })` then `toStore(computation, options)`. `derived`
accepts `CreateSignalOptions` (which includes `debugName`), so the leaf naming itself is a
one-line addition. The RISK is threading: `options` is `Required<toStoreOptions>` and is shared
across the subtree via `STORE_SHARED_OPTIONS`, carrying the injector-scoped proxy cache and
resolved globals. Propagating a per-child debugName means passing a NEW options object per
child (`{ ...options, debugName: childName }`), and that must be proven not to disturb:
- the proxy cache keying (getCachedChild / STORE_SHARED_GLOBALS),
- shared-globals identity (extendStore / forkStore read STORE_SHARED_OPTIONS),
- the record fast-path and noUnionLeaves probes.
581 store specs must stay green; this needs unhurried verification, not a night sprint.

## The plan (clean, when fresh)
1. Add `debugName?: string` to `toStoreOptions` (store.ts:48).
2. In `buildChildNode`, when `options.debugName` is set, compute
   `childName = `${options.debugName}:${String(prop)}`` (array index → `.${i}`), pass
   `debugName: childName` into the `derived(...)` call, and recurse with
   `{ ...options, debugName: childName }` — BUT keep STORE_SHARED_OPTIONS pointing at the
   original shared-globals object so the cache/injector stay shared (thread debugName
   OUTSIDE the shared-globals bag, e.g. as a separate non-cached param to buildChildNode).
3. Seed the root name from `store(value, { debugName })`.
4. Specs: assert a vivified leaf's debugName equals the path; assert arrays index; assert the
   record fast-path and cache-sharing (two reads of the same child are identical) unchanged.

The cleanest shape is likely a dedicated `path` param threaded alongside `options` (not inside
it), so the shared-globals object is never cloned — that sidesteps the cache risk entirely.
