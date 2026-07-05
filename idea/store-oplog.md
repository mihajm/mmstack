# store op-log: the shared substrate — SETTLED DESIGN (2026-07-02)

**Status: IMPLEMENTED same day** — `primitives/src/lib/store/op-log.ts` + 21-test spec (493
primitives tests green): emission minimality via structural sharing, add-vs-undefined honesty,
array unit rules, apply atomicity (single notification wave, recompute-counted), echo-freedom,
flush-before-apply (a pending local write is never swallowed by a baseline advance),
invert round-trips (add↔delete), fork.commit-as-one-batch, a two-peer mini-mesh loop test, and
the mutable-store warn (detection via STORE_KIND — `isMutable`'s `in` probe can't see through
the proxy's `has` trap). Feeds worker-graph, mesh-sync, persistence, undo, devtools.

## The grounding fact that shaped everything

`toStore` is a proxy over ONE backing signal. Every leaf write routes up through `derived.onChange`
chains (`createFallbackOnChange` copies the container per level) and lands as a single immutable
root commit with **structural sharing** — untouched subtrees keep reference identity. That is the
exact contract `merge3`/fork already rely on. Consequence: ops don't need write-path hooks at all.
A **reference-identity-pruned diff** of (prevRoot, nextRoot) recovers minimal ops from OUTSIDE the
store, descending only where refs differ — O(changed paths), not O(tree).

## Decisions

1. **Emission = external, effect-driven diff.** `opLog(source, opt)` creates an effect that reads
   the root, diffs against the previous root by ref-pruned walk, and emits one `OpBatch` per
   effect run. No monkey-patching, no store-core changes, ZERO cost when no log exists. Works on
   **any `WritableSignal<object>` honoring the copy-on-write contract** — stores qualify, and so
   do e.g. plain form model signals. MUTABLE stores are unsupported (in-place mutation defeats
   ref-identity diffing — dev warn, same precedent as fork's `'fine'` strategy).
2. **Batch = tick.** Per-tick coalescing is the txn unit: two writes to one leaf in a tick emit
   one composed op (`prev: v0, next: v2`). Correct for sync/undo/persistence; granularity finer
   than a tick is not observable by the UI anyway. `batch.version` is a per-log monotonic int;
   `batch.origin` identifies the log instance (option, defaulted).
3. **Op shape:**
   ```ts
   type StoreOp =
     | { kind: 'set'; path: (string | number)[]; next: unknown; prev?: unknown }
     | { kind: 'delete'; path: (string | number)[]; prev?: unknown };  // absent key ≠ undefined (merge3 lesson)
   type OpBatch = { origin: string; version: number; ops: StoreOp[] };
   ```
   `prev` is ALWAYS carried in-memory — it's free (old subtree refs via structural sharing).
   Wire serializers decide whether to encode it (worker mirror: strip; undo/merge journal: keep).
   Resolves the earlier "prev cost" question: cost lives at serialization, not emission.
4. **Arrays:** same length → per-index descent (natural for `arr[2].x.set(...)` writes); length
   change → whole-array op (index attribution lies under insert/remove/reorder). Reorders of
   same-length arrays emit per-index value ops (correct by value, blind to identity) — document.
   Keyed/splice ops deferred until an `indexArray` integration provides identity.
5. **`applyOps` lives ON the log handle: `log.apply(batch)`.** It builds the next root immutably
   along op paths, does ONE `set` (atomic — one notification wave), AND advances the log's own
   diff baseline in the same step — so applying a remote batch emits **no echo batch** by
   construction. This kills the classic sync-loop echo problem without origin-filtering
   gymnastics; local writes interleaved in the same tick still diff out correctly against the
   advanced baseline. Missing containers along an op path are vivified `'auto'`-style
   (object for string key, array for index).
6. **Transactions need no new machinery: fork IS the staging primitive.** Stage N writes on a
   `forkStore`, `commit()` is one root set → one batch. Expose `invertBatch(batch)` (prev-based)
   for undo instead of a txn API.
7. **Subscription:** `log.subscribe(cb): () => void` — synchronous, ordered, lossless (called
   per batch after the effect's diff); plus `log.latest: Signal<OpBatch | null>` for
   devtools-style sampling (lossy by design). Don't write to the same store synchronously from
   a callback (dev-guard recursion depth).

## API sketch

```ts
const s = store({ todos: [...] });
const log = opLog(s, { origin: 'tab-main', injector });

log.subscribe((batch) => channel.postMessage(encode(batch)));   // ship
channel.onmessage = (m) => log.apply(decode(m.data));            // apply, echo-free
const undo = invertBatch(lastBatch);                              // prev-based inverse
```

## Consumer check (why this shape serves all five)

- **worker graph:** mirror = `opLog` one side, `log.apply` the other; echo-free by decision 5;
  serializer strips `prev`. Initial hydration = one snapshot, then deltas.
- **mesh/tab sync:** same protocol over BroadcastChannel/WS/RTC; `(origin, version)` gives LWW
  ordering; `prev` gives merge3 its ancestor when policies need it.
- **persistence:** journal batches (keep `prev` for backward compaction or strip for size);
  boot = snapshot + replay via `log.apply`.
- **undo/redo:** `invertBatch`; per-tick granularity = one undo step per tick — acceptable,
  document (an explicit fork-staged edit gives coarser intentional steps).
- **devtools:** `log.latest` + paths are the store-path identity telemetry §12 wants.

## Known limits (accepted, documented)

- Per-tick coalescing: sub-tick write sequences merge into composed ops (invisible to UI anyway).
- Same-length array reorder loses identity attribution (value-correct).
- Mutable stores unsupported.
- The diff trusts the copy-on-write contract — a consumer who deep-clones-and-sets an unchanged
  subtree produces spurious (but harmless, value-correct) ops. Same trust merge3 already places.

## Implementation notes (for the build session)

- File: `packages/primitives/src/lib/store/op-log.ts` (+ spec). Pure sibling — no changes to
  store.ts/leaf.ts. Diff walker mirrors merge3's short-circuit structure.
- Effect needs an injector (param, like other primitives); works in TestBed and zoneless.
- Spec must cover: minimality under structural sharing (recompute counts), delete-vs-undefined,
  array length-change vs same-length, apply atomicity (one notification), echo-freedom of
  apply→diff, invert round-trip, mutable-store warn, fork.commit()-as-one-batch.
