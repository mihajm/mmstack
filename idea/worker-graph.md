# Worker graph: zoneless state-driven parallelism

**Status:** long-term idea ("ideas for now" tier, like service() was). Captured 2026-07-02.

## The vision (Miha's framing)

Teach workers to couple to the reactive graph and manage their own graph in parallel. Ideally pull
a lot of app-builder (interpreter, story-runner, connector orchestration) into worker threads so
main-thread execution stays clean — main thread renders, workers compute. The hard thinking:
serialization bottlenecks (should be minimal) and race conditions / atomicity.

## Why app-builder is unusually portable to workers

The explicit-context architecture (no zones, no ambient state — the same property the telemetry
RFC leans on) means the interpreter/story/connector layers thread everything through `opt`/`ctx`.
Code with no ambient dependencies is exactly the code that can move threads. The ctx/variable
layer is built on our own primitives (store/derived), so if those primitives learn to mirror
across threads, the layer above comes along largely for free.

## Proposed answers to the two hard problems

- **Serialization:** never ship snapshots; ship **ops** ([[store-oplog]] — `idea/store-oplog.md`).
  A worker-side store mirrors a main-side store (or vice versa) by applying deltas. Initial
  hydration is the only snapshot. Structured clone is fast for small deltas; measure before
  reaching for SharedArrayBuffer (which drags in COOP/COEP deployment constraints — note it,
  avoid it in v1).
- **Races/atomicity:** **single-writer ownership per subtree.** Each store subtree has exactly one
  owning thread; everyone else holds a read-replica mirrored via ops. Cross-boundary writes are
  messages to the owner (applied in arrival order, per-subtree FIFO — the same ordering discipline
  as offline mutation replay). No locks, no torn reads: atomicity comes from op batches (`txn`)
  applied in one notification wave.

## The ladder (each rung independently shippable)

1. **`workerResource(fn)` / `inWorker(fn)`** — run a pure function in a (pooled) worker, expose it
   with the standard resource status surface so it participates in transition scopes: heavy
   compute makes UI *pending*, not *frozen*. Community-useful on day one (parsing, diffing,
   search indexing, big derivations). Teaches us the real serialization costs. Small.
2. **Worker-owned store subtree** — a store slice whose owner is a worker; main thread reads a
   live replica; writes route to the owner. Requires the op-log + applyOps. Medium.
3. **Graph coupling** — a worker hosts derivations/effects over its subtree(s) and publishes
   results as further subtrees; `latest()`/`use()` semantics extend across the thread boundary
   (a worker computation in flight = pending in the main-thread scope). Large.
4. **App-builder execution off-main** — interpreter + story-runner in a worker over mirrored ctx;
   main thread = renderer + input. The payoff rung.

## Open questions

- Effect scheduling in workers: no Angular app tick there — a worker graph needs its own
  microtask-based scheduler (we already run signals outside change detection in tests; verify the
  primitives are genuinely renderer-independent).
- DI in workers: none. The worker side should be plain functions + stores; injection stays on the
  owning main-thread edge (this constrains which app-builder layers can move first).
- Transferables for large payloads (ArrayBuffer moves for free — relevant for file/blob-ish
  connector responses).
- Debuggability: op traffic is exactly what devtools/telemetry want to visualize anyway.
