import { finalize, shareReplay, type Observable } from 'rxjs';

/**
 * @internal
 * Single-flight sharing keyed by `key`; shares the pending observable and deregisters on settle.
 */
export function sharePending<T>(
  pending: Map<string, Observable<T>>,
  key: string,
  create: () => Observable<T>,
): Observable<T> {
  const existing = pending.get(key);
  if (existing) return existing;

  const shared = create().pipe(
    finalize(() => pending.delete(key)),
    shareReplay({ bufferSize: 1, refCount: true }),
  );
  pending.set(key, shared);

  return shared;
}
