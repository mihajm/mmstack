export type IDBConnection = {
  getAll: <T extends Record<PropertyKey, any>>(
    tableName: string,
    abortSignal?: AbortSignal,
  ) => Promise<T[]>;
  add: <T>(
    tableName: string,
    value: T,
    abortSignal?: AbortSignal,
  ) => Promise<IDBValidKey>;
  update: <T>(
    tableName: string,
    value: T,
    abortSignal?: AbortSignal,
  ) => Promise<IDBValidKey>;
  remove: (
    tableName: string,
    key: IDBValidKey,
    abortSignal?: AbortSignal,
  ) => Promise<void>;
};

export function promisifyRequest<T>(
  req: IDBRequest<T>,
  tx: IDBTransaction,
  abortSignal?: AbortSignal,
): Promise<T> {
  const abortFn = () => tx.abort();

  abortSignal?.addEventListener('abort', abortFn);

  const cleanup = () => abortSignal?.removeEventListener('abort', abortFn);

  return new Promise((resolve, reject) => {
    req.onsuccess = () => {
      resolve(req.result);
      cleanup();
    };
    req.onerror = () => {
      reject(req.error);
      cleanup();
    };
  });
}

export function createNoopConnection(): IDBConnection {
  return {
    getAll: async <T extends Record<PropertyKey, any>>(
      _: string,
    ): Promise<T[]> => [],
    add: async <T>(_: string, __: T): Promise<IDBValidKey> => {
      return Math.random() as IDBValidKey;
    },
    update: async <T>(_: string, __: T): Promise<IDBValidKey> => {
      return Math.random() as IDBValidKey;
    },
    remove: async (_: string, __: IDBValidKey): Promise<void> => {
      // noop
    },
  };
}
