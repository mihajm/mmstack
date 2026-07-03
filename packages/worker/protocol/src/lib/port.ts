/**
 * The minimal structural transport the worker protocol rides on — the intersection of a `Worker`,
 * a `MessagePort`, and a `BroadcastChannel`. Modeled on `@mmstack/resource`'s `MutationSyncChannel`:
 * anything with `postMessage` + assignable `onmessage` qualifies, so a `MessageChannel` port-pair
 * works in tests with zero adapters and a future `@mmstack/mesh` can slot a WS/RTC channel behind
 * the same type.
 */
export type WorkerPortLike = {
  postMessage(message: unknown, transfer?: Transferable[]): void;
  // `ev` is intentionally `any`: a real `Worker`/`MessagePort` types this as `(ev: MessageEvent)`,
  // and under `strictFunctionTypes` only an `any`-typed event param keeps those assignable to this
  // shape cast-free (a `{ data }` param fails the contravariance check). Read `ev.data` and narrow
  // it to a `WorkerEnvelope` at the handler.
  onmessage: ((ev: any) => void) | null;
  /** `Worker` has `terminate()`, `MessagePort`/`BroadcastChannel` have `close()` — either, both optional. */
  terminate?(): void;
  close?(): void;
};

/** Closes a port by whichever teardown method it exposes. */
export function closePort(port: WorkerPortLike): void {
  port.terminate?.();
  port.close?.();
}

// values whose reachable Transferables should be MOVED (detached at the sender) rather than cloned
const TRANSFERABLES = new WeakMap<object, Transferable[]>();

/**
 * Marks `value` so that, when it is sent over a {@link WorkerPortLike}, the listed `Transferable`s
 * (e.g. an `ArrayBuffer`) are moved rather than structure-cloned — zero-copy, but detached at the
 * sender. Comlink-idiom. v1 honors this on task input/output only; store traffic always clones (a
 * moved buffer inside a replicated tree would detach the owner's copy).
 *
 * ```ts
 * const buf = new Float64Array(1e6);
 * workerResource(() => transfer({ buf }, [buf.buffer]), { worker, task: 'process' });
 * ```
 */
export function transfer<T extends object>(value: T, transferables: Transferable[]): T {
  TRANSFERABLES.set(value, transferables);
  return value;
}

/** @internal Reads back the Transferables registered on a value via {@link transfer}, if any. */
export function takeTransferables(value: unknown): Transferable[] | undefined {
  if (value !== null && typeof value === 'object')
    return TRANSFERABLES.get(value as object);
  return undefined;
}
