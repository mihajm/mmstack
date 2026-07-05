# Op substrate unification: persistence + mesh + worker as readers over one write seam

**Status: design locked 2026-07-04 (Miha).** Direction to unify the three "edges" on the shared
op-protocol in `@mmstack/primitives`, so they compose without any library importing another.

## The model

A `store` has one op stream (`opLog` — the write seam). Everything else is a READER of that stream:

- **persistence** reads ops/snapshots to disk (the time edge)
- **mesh** reads ops to peers (the space edge)
- **worker** reads ops across the thread boundary (the thread edge)

Because they all read the same seam, they compose: a persisted, meshed, worker-owned graph is just
three readers on one store. This is the op-protocol RFC thesis (one substrate, many edges).

## Hard invariant (Miha)

`@mmstack/mesh` must not import `@mmstack/worker` and vice versa. Any integration seam is either a
primitive, or a small generic interface (duplication of a 4-line transport interface is fine), or a
primitive-level composition. If a design needs a cross-import, it is wrong — step back.

## Conflict model: (a) owner-authoritative, with the asterisk

The worker stays owner-authoritative — but that is a worker-INTERNAL fact (worker owns state, the
main thread mirrors it). It is invisible to the mesh. To the mesh a device is ONE client/origin;
whether that client keeps state in a worker, on the main thread, or on disk is the client's private
wiring. `worker.ts` never names mesh. The device presents as one connection; where it places state
is a client concern.

## Why it composes for free (the load-bearing fact)

Multiple `opLog`/`opSync` readers on ONE store do not storm, because:
- `opLog.apply` is echo-free — a reader never re-emits an op it just applied.
- `opLog`'s diff has equal-value tolerance — a round-trip returning the same value yields zero ops.

So: mesh applies a remote edit → the worker reader forwards it once → the worker echoes it back →
equal value → no further emission. The value-level `lastSynced` bridge hack is unnecessary; the
composition is inherent to the substrate. (Proven in packages/primitives .../op-compose.spec.ts.)

**Conflict model = optimistic (decided 2026-07-04).** The worker main side goes optimistic (local
apply + route to owner + reconcile on the authoritative echo), matching mesh (which is already
optimistic). Owner-authority is preserved (the owner still sequences and the main reconciles to it).
Honest-async stays available as a user composition (fork + await the `write()` promise). KEY finding
that makes the reconcile trivial: every store op is `set path value` or `delete path` — both
IDEMPOTENT (array structural changes emit a whole-array `set`, not element-wise inserts). So
re-applying the owner's echo of your own write lands on the same value → opLog spurious-write
tolerance → noop. Therefore chunk 2 needs NO worker protocol change and NO source correlation; only
`worker-store.ts`'s main side changes (writable store + opLog that ships local changes + inbound
batches via echo-free apply). Owned vs published is known at runtime from `worker.manifest.stores`
(owned ships writes; published stays a read-only replica).

## Minimal plan (worker is experimental, shipped hours ago, no users — clean to change)

1. ~~Promote `microtaskOpLogDriver` to primitives.~~ **DROPPED 2026-07-04.** Not needed: everything
   we compose on the main thread (worker main-side store, meshSync, persist) has an Angular injector
   and uses the normal effect driver; the DI-free driver is only for the worker HOST side, which
   already has it. And it must NOT move — `microtask-driver.ts` documents that it lives in
   worker/host on purpose because `createWatch` may be absent in the older Angular majors primitives
   back-ports to (LTS branches). opSync stays transport-agnostic + DI-free-capable via `driver`;
   we just don't need that here.
2. Rework the worker's MAIN-SIDE owned store to be a WRITABLE opLog endpoint: local writes route to
   the worker (as today, via the batch protocol), inbound worker batches apply echo-free. Keep the
   existing wire protocol and owner-authority; only the main-side representation changes from a
   read-only replica to a writable, composable op endpoint.
3. Extract persistence into a `persist(store, backend)` READER (persistedStore = `store()` +
   `persist()`), so persistence attaches to an existing store instead of only creating its own.
4. Compose: `meshSync(g)` + `persist(g)` on the worker's main-side store `g`. No bespoke bridge; the
   value-level worker-mesh-bridge.ts becomes the interim proof and is retired.
5. Prove with an e2e: a persisted + meshed + worker-owned graph converges across devices and
   survives a reload.

Keep every step minimal and behind the existing 52 worker tests as the safety net.

## Outcome (SHIPPED 2026-07-04)

Done, all green: primitives 609, worker 55, playground-e2e 62.
- `persist(store, backend)` extracted; `persistedStore = store() + persist()`. Mud specs (bursts,
  clear-during-pending, boot-window write, throwing backend, two readers on one store).
- Worker main side reworked to a writable opLog endpoint (optimistic writes + echo-free apply);
  owner-authority + wire protocol unchanged; no protocol change (idempotent ops). New worker specs:
  optimistic-immediate reflect, no-op resolves, composed opLog reader sees writes + owner changes
  with no echo storm. Published subtrees stay read-only (`.write` rejects; store type narrows).
- Value-level `worker-mesh-bridge.ts` DELETED. The /worker-mesh demo composes `meshSync(doc.store)`
  + `persist(doc.store)` directly on the worker store. e2e: two devices converge through each
  other's worker (worker+mesh, no bridge); persist captures worker-owned changes to real IndexedDB
  (worker+persist).

**Client-wiring finding (documented, not a primitive gap):** boot-RESTORE of a worker graph from
disk is an app boot-policy, because on reload TWO hydration sources race — the worker (empty initial)
and disk — and `persist`'s "boot write wins" guard can't tell the worker's hydration from a user
edit. Whoever should win on boot (here: disk over worker-empty) is the client's call. Also: don't
call `persist()` (or anything that creates an `effect`) from inside an `effect` — Angular's
reactive-context guard rejects it. The clean restore recipe (await worker hydration → read disk →
seed the worker → attach persist) is a client pattern to document, kept out of the primitive.
