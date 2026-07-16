# Solid 2.0 harvest — what's worth borrowing for our async/concurrency primitives

**Captured 2026-07-03** while designing [[worker-graph]]. Read from ACTUAL source
(`@solidjs/signals@2.0.0-beta.15` npm tarball — the GitHub repo is not public; npm `latest` is the
stale `0.13.13`). Scope discipline: "works in the Angular graph" — we do NOT adopt Solid's reactive
CORE (graph-coloring CHECK/DIRTY heap scheduler, node-level union-find lanes, GlobalQueue,
`flush()`-as-general-primitive, `NotReadyError` throw-to-suspend). Those are engine-level; adopting
them means replacing Angular reactivity. Only primitive-level patterns built ON signals are fair game.

## Already have equivalent-or-better (do nothing)

- keyed/index list mapping → `mappers` module: `indexArray` / `keyArray` / `mapObject` (richer than
  Solid's `mapArray`/`indexArray` — writable+mutable overloads, onDestroy).
- keep-previous → `keep-previous` + `latest()` keepPrevious.
- reactive-expression→promise → `until(signal, predicate)` (vs Solid `resolve`/`onSettled`; a
  `settled(fn)` helper is low value).
- loading/error boundaries + the first-paint-vs-refreshing split → transition-scope `suspend` vs
  `indicator` registration IS Solid's `<Loading>` vs `isPending`. We shipped their headline 2.0
  feature independently.
- createReaction → effect+untracked. createOptimistic → forkStore (+ worker write path).

## Genuine gaps

1. **`projection()` — SHIPPED 2026-07-03.** `packages/primitives/src/lib/store/projection.ts` +
   exported `reconcile(prev, next, key)` (keyed 2-way, ref-preserving) + 7-test spec. Shipped impl
   is a lazy pull-based linkedSignal recompute (NOT effect-driven/eager as originally sketched
   here), lazy per-leaf reads; structuredClone draft (mutate-or-return); reconcile keeps
   object refs on unchanged subtrees and array item identity by key. `workerProjection` convenience
   NOT built (published subtrees already emit any Signal). Original note below.
   **Missing quadrant (context):** Signal→memo,
   Store→projection. A read-only STORE whose structure is fine-grained keyed-reconciled from a
   derivation. We have derive-a-value (`derived`) and derive-an-array (`indexArray`/`keyArray`) but
   not derive-a-store-subtree with per-property tracking. = Solid `createProjection(fn, seed,
   {key='id'})`. IS the worker published-subtree shape → `workerProjection` on the host is this over
   the port. Needs a keyed 2-way `reconcile(store, next, {key})` util (we have merge3 = 3-way
   ancestor-based; keyed 2-way identity-preserving is the missing sibling — confirm during build).
2. **`isPending(() => expr)` — TIER 2, optional.** Lexical/dynamic pending probe over a read
   expression vs our registration-based transition-scope. Composes with use()/latest(). Nice-to-have.
3. **`revealOrder` — TIER 3, niche.** Coordinate sibling suspense-boundary reveal timing
   (sequential | together | natural). Distinctive UX primitive we lack; low priority.

## Scheduler borrow (worker-host only, not general)

`core/scheduler.d.ts` (real): `GlobalQueue`, microtask batching + `clock` version counter,
**`flush()`/`flush(fn)`** synchronous drain, explicit effect phases `EFFECT_PURE=0` (height-ordered
`Heap`/`dirtyQueue`, glitch-free topological) → `RENDER=1` → `USER=2`. For the worker host: microtask
batching confirms `microtaskOpLogDriver`; copy the `flush()` signature for deterministic test settle +
honest flush-before-apply across the port; phase-split → recompute-graph THEN emit-envelopes so a
settling worker-side latest() ships value + status in ONE wave, not two racing envelopes.

## Optimism reference (not v1)

`core/lanes.d.ts` (real): each optimistic write = `OptimisticLane`; lanes MERGE when dependency
graphs overlap (union-find `findLane`/`mergeLanes`); revert on transition settle. This is the
sophisticated version of forkStore-optimism. v1 uses forkStore (merge3 exists); lanes are the
documented reference IF concurrent-optimistic-merge is ever needed.

## Why Ryan left cross-boundary reactive graph an experiment (doesn't apply to us)

His "Resumability without Serialization" (HackMD) + Road-to-2.0 (#2425): it's an SSR
resumability/hydration problem — reconstruct a reactive graph on the CLIENT from server-computed
state. Named blockers are all hydration-specific: cold-resume "unnecessary execution" ordering;
DOM-structure changes breaking creation-order hydration IDs ("no one has solved this fine-grained,
it's why Qwik uses a VDOM"); code-size from registering all boundaries. Deferred because it's "3
steps removed" gated on compiler work (unify compiled graph outputs → reactive graph serialization →
restoration during hydration). We do the OPPOSITE, easier thing: both graphs already alive+running,
built independently in code; we ship DATA DELTAS (op-log) between two warm graphs — no cold-resume,
no hydration-ID↔DOM matching, no compiler graph-identity reconstruction. The one hard shared
sub-problem (minimal reactive-state serialization) we already shipped as the op-log. His endgame
("boundaries being the signals themselves") is our north star too, just for threads not hydration.
