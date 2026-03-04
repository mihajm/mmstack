import { type HttpResourceRef } from '@angular/common/http';
import { effect } from '@angular/core';

export type RetryOptions =
  | number
  | {
      max?: number;
      backoff?: number;
    };

// Retry on error, if number is provided it will retry that many times with exponential backoff, otherwise it will use the options provided
export function retryOnError<T>(
  res: HttpResourceRef<T>,
  opt?: RetryOptions,
): HttpResourceRef<T> {
  const max = opt ? (typeof opt === 'number' ? opt : (opt.max ?? 0)) : 0;
  const backoff = typeof opt === 'object' ? (opt.backoff ?? 1000) : 1000;

  let retries = 0;

  let timeout: ReturnType<typeof setTimeout> | undefined;

  const onError = () => {
    if (retries >= max) return;
    retries++;

    if (timeout) clearTimeout(timeout);

    setTimeout(
      () => res.reload(),
      retries <= 0 ? 0 : backoff * Math.pow(2, retries - 1),
    );
  };

  const onSuccess = () => {
    if (timeout) clearTimeout(timeout);
    retries = 0;
  };

  const ref = effect(() => {
    switch (res.status()) {
      case 'error':
        return onError();
      case 'resolved':
        return onSuccess();
    }
  });

  return {
    ...res,
    destroy: () => {
      ref.destroy(); // cleanup on manual destroy
      res.destroy();
    },
  };
}
