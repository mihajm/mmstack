import { effect, resource, signal, Signal } from '@angular/core';
import { toResourceObject } from './to-resource-object';

function promisifyTransaction<T>(
  db: IDBDatabase,
  fn: (store: IDBObjectStore) => T,
  type: 'readonly' | 'readwrite',
  storeName: string,
  abort?: AbortSignal,
): Promise<T> {
  return new Promise<T>((res, rej) => {
    const transaction = db.transaction(storeName, type);
    const store = transaction.objectStore(storeName);
    const result = fn(store);

    abort?.addEventListener('abort', () => {
      transaction.abort();
    });

    transaction.oncomplete = () => res(result);
    transaction.onerror = () => rej(transaction.error);
    transaction.onabort = () => rej(transaction.error);
  });
}

export function transactionMutation<T, TCTX = void>(
  db: Signal<IDBDatabase | undefined>,
  fn: (store: IDBObjectStore, value: T) => T,
  type: 'readonly' | 'readwrite' = 'readwrite',
  storeName: string,
  {
    onError,
    onMutate,
    onSuccess,
  }: {
    onMutate?: (result: T) => TCTX;
    onSuccess?: (result: T, ctx: TCTX) => void;
    onError?: (err: unknown, ctx: TCTX) => void;
  } = {},
) {
  const next = signal<T | null>(null);

  let ctx = undefined as TCTX;

  const r = toResourceObject(
    resource({
      params: () => ({ db: db(), value: next() }),
      loader: ({ params: { db, value }, abortSignal }) => {
        if (!db || value === null) return Promise.resolve(null);
        return promisifyTransaction<T>(
          db,
          (store) => fn(store, value),
          type,
          storeName,
          abortSignal,
        );
      },
      defaultValue: null,
    }),
  );

  const ref = effect(() => {
    try {
      const v = r.value();
      if (v === null) return;
      onSuccess?.(v, ctx);
    } catch (err) {
      onError?.(err, ctx);
    } finally {
      next.set(null);
    }
  });

  return {
    destroy: () => {
      ref.destroy();
      r.destroy();
    },
    isLoading: r.isLoading,
    mutate: (value: T) => {
      next.set(value);
      if (!onMutate) return;
      ctx = onMutate(value);
    },
  };
}
