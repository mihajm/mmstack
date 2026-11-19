import { isDevMode } from '@angular/core';
import { type CacheEntry } from './cache';

type StoredEntry<T> = Omit<CacheEntry<T>, 'timeout'>;

export type CacheDB<T> = {
  getAll: () => Promise<StoredEntry<T>[]>;
  store: (value: StoredEntry<T>) => Promise<void>;
  remove: (key: string) => Promise<void>;
  /** Removes every row. Optional for custom implementations; the cache falls back to `remove` per row. */
  clear?: () => Promise<void>;
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
    clear: async () => {
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
      // some browsers abort rather than error
      transaction.onabort = () => rej(transaction.error);
    })
      .then((entries) => {
        const live = entries.filter((e) => e.expiresAt > now);
        // rows that expired while no tab held them would otherwise stay forever
        if (live.length !== entries.length)
          entries
            .filter((e) => e.expiresAt <= now)
            .forEach((e) => void remove(e.key));
        return live;
      })
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
      transaction.onabort = () => rej(transaction.error);
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
      transaction.onabort = () => rej(transaction.error);
    }).catch((err) => {
      if (isDevMode()) console.error('Error removing item from cache DB:', err);
    });
  };

  const clear = () => {
    return new Promise<void>((res, rej) => {
      const transaction = db.transaction(storeName, 'readwrite');
      transaction.objectStore(storeName).clear();

      transaction.oncomplete = () => res();
      transaction.onerror = () => rej(transaction.error);
      transaction.onabort = () => rej(transaction.error);
    }).catch((err) => {
      if (isDevMode()) console.error('Error clearing cache DB:', err);
    });
  };

  return {
    getAll,
    store,
    remove,
    clear,
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
    if (version < 1) {
      rej(new Error('Version must be 1 or greater'));
      return; // rej does not stop execution
    }

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

    // another tab still holds an older version that does not let go: run without persistence
    req.onblocked = () => {
      rej(new Error(`Opening "${name}" v${version} is blocked by another tab`));
    };

    req.onsuccess = () => {
      const db = req.result;
      // let a newer version (another tab after an upgrade) open instead of blocking it
      db.onversionchange = () => db.close();
      res(db);
    };
  })
    .then((db) => toCacheDB<T>(db, storeName))
    .catch((err) => {
      if (isDevMode()) console.error('Error creating query DB:', err);
      return createNoopDB();
    });
}
