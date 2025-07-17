import { isDevMode } from '@angular/core';
import { CacheEntry } from './cache';

type StoredEntry<T> = Omit<CacheEntry<T>, 'timeout'>;

export type CacheDB<T> = {
  getAll: () => Promise<StoredEntry<T>[]>;
  store: (value: StoredEntry<T>) => Promise<void>;
  remove: (key: string) => Promise<void>;
};

export function createNoopDB<T>(): CacheDB<T> {
  return {
    getAll: async () => [],
    store: async () => {
      // noop
    },
    remove: async () => {
      // noop
    },
  };
}

function toCacheDB<T>(db: IDBDatabase, storeName: string): CacheDB<T> {
  const getAll = async () => {
    const now = Date.now();
    return new Promise<StoredEntry<T>[]>((res, rej) => {
      const transaction = db.transaction(storeName, 'readonly');
      const store = transaction.objectStore(storeName);
      const request = store.getAll();

      request.onsuccess = () => res(request.result);
      request.onerror = () => rej(request.error);
    })
      .then((entries) => entries.filter((e) => e.expiresAt > now))
      .catch((err) => {
        if (isDevMode())
          console.error('Error getting all items from cache DB:', err);
        return [];
      });
  };

  const store = (value: StoredEntry<T>) => {
    return new Promise<void>((res, rej) => {
      const transaction = db.transaction(storeName, 'readwrite');
      const store = transaction.objectStore(storeName);

      store.put(value);

      transaction.oncomplete = () => res();
      transaction.onerror = () => rej(transaction.error);
    }).catch((err) => {
      if (isDevMode()) console.error('Error storing item in cache DB:', err);
    });
  };

  const remove = (key: string) => {
    return new Promise<void>((res, rej) => {
      const transaction = db.transaction(storeName, 'readwrite');
      const store = transaction.objectStore(storeName);

      store.delete(key);

      transaction.oncomplete = () => res();
      transaction.onerror = () => rej(transaction.error);
    }).catch((err) => {
      if (isDevMode()) console.error('Error removing item from cache DB:', err);
    });
  };

  return {
    getAll,
    store,
    remove,
  };
}

export function createSingleStoreDB<T>(
  name: string,
  getStoreName: (version: number) => string,
  version = 1,
): Promise<CacheDB<T>> {
  const storeName = getStoreName(version);

  if (!globalThis.indexedDB) return Promise.resolve(createNoopDB());

  return new Promise<IDBDatabase>((res, rej) => {
    if (version < 1) rej(new Error('Version must be 1 or greater'));

    const req = indexedDB.open(name, version);

    req.onupgradeneeded = (event) => {
      const db = req.result;
      const oldVersion = event.oldVersion;

      db.createObjectStore(storeName, { keyPath: 'key' });

      if (oldVersion > 0) {
        db.deleteObjectStore(getStoreName(oldVersion));
      }
    };

    req.onerror = () => {
      rej(req.error);
    };

    req.onsuccess = () => res(req.result);
  })
    .then((db) => toCacheDB<T>(db, storeName))
    .catch((err) => {
      if (isDevMode()) console.error('Error creating query DB:', err);
      return createNoopDB();
    });
}
