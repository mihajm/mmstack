# Concurrency instrumentation seam (devtools item, ex-idea/concurrency.md §6)

**Status:** design pass done 2026-07-03 (queued behind the telemetry port, now unblocked).
**Note:** the original `idea/concurrency.md` was never committed and is lost (folder-deletion
casualty, like translate.md); its devtools item survives via `idea/telemetry.md`'s "downstream
consumer" section, which this doc supersedes. Design-only — nothing here is built.

## Shape: a neutral listener token in primitives

`@mmstack/primitives` must not depend on telemetry. The seam is a dnd-plugin-style optional
provider token; every tap is `listener?.hook(...)` behind a once-resolved optional inject, so
the absent case stays zero-cost (no effects created, no closures allocated).

```ts
// packages/primitives (concurrent/instrumentation.ts)
export interface ConcurrencyInstrumentation {
  // span-shaped hooks RETURN an opaque handle; the machinery calls end(handle) —
  // deliberately isomorphic to telemetry's startSpan()/SpanHandle so mapping is 1:1
  pendingStart?(e: { scope: string; resources: number; at: number }): unknown;
  pendingEnd?(handle: unknown, e: { at: number }): void;
  suspenseStart?(e: { scope: string; type: 'value' | 'loading'; at: number }): unknown;
  suspenseEnd?(handle: unknown, e: { at: number }): void;
  transactionStart?(e: { scope: string; at: number }): unknown;
  transactionEnd?(handle: unknown, e: { at: number; settled: boolean }): void;

  // event-shaped hooks (fire-and-forget)
  resourceRegistered?(e: { scope: string; resource?: string; suspends: boolean }): void;
  resourceRemoved?(e: { scope: string; resource?: string }): void;
  abortPending?(e: { scope: string; aborted: number }): void;
  scopeRetargeted?(e: { scope: string; target: string | null }): void;
  reveal?(e: { scope: string; heldMs: number }): void; // commit/hold released one frame
}

export const CONCURRENCY_INSTRUMENTATION: InjectionToken<ConcurrencyInstrumentation>;
export function provideConcurrencyInstrumentation(l: ConcurrencyInstrumentation): Provider;
```

## Identity: scope naming rides the existing seams

Scopes are anonymous today. Add `name?: string` to `provideTransitionScope(opt?)` /
`provideForwardingTransitionScope(opt?)` (and an input on the suspense boundary / outlet that
forwards it). Fallback: generated `scope#n`. Resources reuse Angular `debugName` when present —
same single-identity rule as the RFC §12 store-path plan; no parallel naming scheme.

## Where the taps live

- **pending / suspense windows**: signal transitions need an observer; the PROVIDERS wire an
  effect only when a listener is present — exactly the `bridgeScopeToPendingTasks` pattern
  (it already demonstrates provider-level, opt-in, injector-scoped wiring).
- **add / remove / abortPending / beginHold / endHold / setTarget**: imperative call sites in
  `transition-scope.ts`, tapped inline.
- **transactions**: `startTransition` / `startTransaction` bracket their attributed-pending
  settle; `transactionEnd.settled` distinguishes settle from teardown.
- **refetch causality**: not a new tap — `tracedSignal.causedBy()` is already the carrier
  (telemetry §8.2). The consumer attributes refetch spans; primitives stay ignorant.

## Vocabulary → telemetry mapping (the 1:1 contract)

| Hook | Telemetry call | Name | Attrs |
|---|---|---|---|
| pendingStart/End | `startSpan` + `end` | `mm.pending` | scope, resources |
| suspenseStart/End | `startSpan` + `end` | `mm.suspense` | scope, type |
| transactionStart/End | `startSpan` + `end` | `mm.transaction` | scope, settled |
| resourceRegistered/Removed | `event` | `mm.resource.registered/removed` | scope, resource, suspends |
| abortPending | `event` | `mm.abort_pending` | scope, aborted |
| scopeRetargeted | `event` | `mm.scope.retargeted` | scope, target |
| reveal | `event` | `mm.reveal` | scope, heldMs |

The span-shaped hooks return/accept opaque handles and carry `at` epoch-ms stamps, matching the
telemetry SinkSpan SPI (`startMs`/`endMs`) so buffered replay keeps true clocks. Every emit is
category-tagged (`category: 'perf'`) so the consent module gates the whole subsystem with one
requirement.

## Consumers (both trivial given the mapping)

1. **`concurrencyTelemetry()`** — a listener factory (lives telemetry-side, or app-side glue)
   that binds hooks to `inject(TELEMETRY)`. ~30 lines because the vocabulary was shaped for it.
2. **Performance custom-tracks preset** — the same listener shape writing
   `performance.measure(name, { start, end, detail: { devtools: { track: 'mmstack' } } })`,
   giving Chrome DevTools Performance-panel tracks for pending/suspense/transaction windows.
   Dev-only, no backend. This likely subsumes "concurrency devtools" entirely.

## Open (decide when building)

- Volume: pending can flap on fast settles — min-duration filter (e.g. drop <1 frame) in the
  consumer, not the seam.
- Whether `latest()` exposes a `debugName` option for resource identity (cheap, worth it).
- Whether the suspense boundary component tap belongs in primitives or the component lib that
  owns `<mm-suspense>`.
