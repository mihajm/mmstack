import { finalize, shareReplay, type Observable } from 'rxjs';

/**
 * @internal
 * Single-flight sharing: if a pending observable is already registered under `key`,
 * return it; otherwise create one, share it (replaying the latest event to late
 * subscribers), and deregister it on teardown/settle.
 *
 * Used by both the dedupe interceptor (keyed by full request hash, app-wide) and the
 * cache interceptor (keyed by the CACHE key, guarding the miss/stale-revalidation path)
 * — same mechanism, different keying/scope, so it lives here exactly once.
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
