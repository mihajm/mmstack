import { type HttpResourceRef } from '@angular/common/http';
import { effect, type Injector, untracked } from '@angular/core';

export type RetryOptions =
  | number
  | {
      max?: number;
      backoff?: number;
    };

/**
 * Callback fired by the retry wrapper for every failed attempt.
 * `retryCount` is the number of retries that already happened before this
 * error (`0` on the original failure, `1` after the first retry, etc.).
 * `isFinal` is `true` when no further retry will be scheduled — either because
 * retries are exhausted or `retry` was unset/0.
 */
export type RetryErrorCallback<TError = unknown> = (
  err: TError,
  retryCount: number,
  isFinal: boolean,
) => void;

export function retryOnError<T>(
  res: HttpResourceRef<T>,
  opt?: RetryOptions,
  onError?: RetryErrorCallback,
  injector?: Injector,
  beforeRetry?: () => void,
): HttpResourceRef<T> {
  const max = opt ? (typeof opt === 'number' ? opt : (opt.max ?? 0)) : 0;
  const backoff = typeof opt === 'object' ? (opt.backoff ?? 1000) : 1000;

  let retries = 0;

  let timeout: ReturnType<typeof setTimeout> | undefined;

  const handleError = () => {
    const err = untracked(res.error);
    const isFinal = retries >= max;

    onError?.(err, retries, isFinal);

    if (isFinal) return;

    retries++;

    if (timeout) clearTimeout(timeout);

    timeout = setTimeout(
      () => {
        beforeRetry?.();
        res.reload();
      },
      retries <= 0 ? 0 : backoff * Math.pow(2, retries - 1),
    );
  };

  const reset = () => {
    if (timeout) clearTimeout(timeout);
    timeout = undefined;
    retries = 0;
  };

  const ref = effect(
    () => {
      switch (res.status()) {
        case 'error':
          return handleError();
        // a success, a value write, an abort or a disabled request ends the retry run
        case 'resolved':
        case 'local':
        case 'idle':
          return reset();
      }
    },
    { injector },
  );

  return {
    ...res,
    destroy: () => {
      ref.destroy();
      res.destroy();
    },
  };
}
