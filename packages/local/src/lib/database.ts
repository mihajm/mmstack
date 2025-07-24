import {
  computed,
  Injector,
  isDevMode,
  Resource,
  resource,
  untracked,
  ValueEqualityFn,
  type ResourceRef,
} from '@angular/core';
import { toWritable } from '@mmstack/primitives';
import { toResourceObject, transactionMutation } from './util';

type AnyObject = Record<PropertyKey, any>;

/**
 * A reactive slice of data from the store, representing a single record.
 * @template T The type of data in the slice.
 * @see ResourceRef
 */
export type DatabaseSliceRef<T extends AnyObject | undefined> =
  ResourceRef<T> & {
    remove: () => void;
    // patch: (value: PatchValue<T>) => T;
  };

/**
 * A special reactive slice representing the entire collection, acting as a
 * factory for lightweight, derived "lens" slices.
 * @template T The type of records in the collection.
 */
export type DatabaseCollectionRef<T extends AnyObject> = ResourceRef<T[]> & {
  /** Creates a lightweight, derived lens for a single record within the collection. */
  getRecord(key: string | number): DatabaseSliceRef<T | undefined>;
  /** Creates a lightweight, derived lens for a single record within the collection, with a fallback value. */
  getRecord(key: string | number, fallback: T): DatabaseSliceRef<T>;
  /**
   * Adds a new record to the collection and returns the key of the newly created record.
   * @param value The record to add.
   * @returns The key of the new record.
   */
  add(value: T): string | number;
  /** Removes a record from the collection by its key. */
  remove(key: string | number): void;
};

/**
 * The control object returned by the `database` primitive.
 * @template T The type of records in the store.
 */
export type Database<T extends AnyObject> = {
  /**
   * (Lazy) Retrieves a fully independent, reactive slice for a single record.
   * @param key The unique key of the record.
   * @returns A slice whose data may be `undefined` until loaded or if not found.
   */
  getRecord(key: string | number): DatabaseSliceRef<T | undefined>;
  /**
   * (Lazy) Retrieves a fully independent, reactive slice for a single record.
   * @param key The unique key of the record.
   * @param fallback A default value to use if the record isn't found.
   * @returns A slice whose data is guaranteed to be of type `T`.
   */
  getRecord(key: string | number, fallback: T): DatabaseSliceRef<T>;
  /**
   * (Eager) Retrieves a special slice containing the entire collection.
   * This slice can be used to create lightweight "lens" slices into its data.
   * @param fallback - Optional fallback value to return if the collection is empty.
   * If not provided, an empty array will be used.
   */
  getCollection(fallback?: T[]): DatabaseCollectionRef<T>;
  /**
   * The status of the database resource as a whole.
   */
  status: Resource<unknown>['status'];
  /**
   * If the database is still instantiating
   */
  isLoading: Resource<unknown>['isLoading'];
  /**
   * If the database creation is in an error state.
   */
  error: Resource<unknown>['error'];
};

type StringOr<T extends PropertyKey> = T | Omit<string, T>;

export type CreateDatabaseOptions<T extends AnyObject> = {
  /**
   * The name of the the database. This is used to instantiate the database with this name
   */
  dbName: string;
  /**
   * An integer version of the database schema, defaults to 1. Cannot be less than 1.
   * Increment this when you want to change the structure of the data in the store.
   * This will trigger an upgrade event, where provided migrations will run, if no migrations are provided, the old store will be cleared.
   * @default 1
   */
  /**
   * The property on a record that serves as its unique key.
   */
  keyPath: StringOr<keyof T>;
  version?: number;
  /**
   * The name of the store in the database. This is used to create the object store.
   * If not provided, the store will be named after the database name suffixed with "-store".
   */
  storeName?: string;
  /*
   * indexes - An array of indexes to create on the store.
   * Each index is an object with a name, keyPath, and optional options.
   * The name is the name of the index, keyPath is the path to the indexed
   * property, and options are the options for the index.
   */
  indexes?: {
    name: string;
    keyPath: string | string[];
    options?: IDBIndexParameters;
  }[];
  /**
   * migrations - An object containing migration functions for each version. Only the migrations matching the old version will be run.
   * If no migrations are provided, or if one for the existing version is not provided, the store will be cleared.
   */
  migrations?: Record<
    number,
    (transaction: IDBTransaction, db: IDBDatabase) => void
  >;
  /**
   * The equality function to use when comparing values in the store.
   */
  equal?: ValueEqualityFn<T>;
  /**
   * An optional injector to use for dependency injection within the database.
   */
  injector?: Injector;
};

function createNoopDB<T extends AnyObject>(): Database<T> {
  return {} as unknown as Database<T>; // todo
}

function createAllSliceFactory<T extends AnyObject>(
  dbResource: ResourceRef<IDBDatabase | undefined>,
  storeName: string,
  equal: ValueEqualityFn<T>,
  injector: Injector,
): Database<T>['getCollection'] {
  const arrayEqual: ValueEqualityFn<T[]> = (a, b) => {
    if (a === b) return true;
    if (a.length !== b.length) return false;
    if (!a.length) return true; // both are empty arrays
    return a.every((item, index) => equal(item, b[index]));
  };

  return (fallback = []) => {
    const allResource = toResourceObject(
      resource({
        params: () => dbResource.value(),
        loader: ({ params: db }) => {
          if (!db) return Promise.resolve(fallback);
          return new Promise<T[]>((res, rej) => {
            const store = db
              .transaction(storeName, 'readonly')
              .objectStore(storeName);

            const request = store.getAll();

            request.onsuccess = () => res(request.result);
            request.onerror = () => rej(request.error);
          });
        },
        defaultValue: fallback,
      }),
    );

    const setMutation = transactionMutation(
      dbResource.value,
      (store, values: T[]) => {
        store.clear();
        values.forEach((v) => store.add(v));
        return values;
      },
      'readwrite',
      storeName,
      {
        onMutate: (values) => {
          const prev = untracked(allResource.value);
          allResource.set(values);
          return prev;
        },
        onError: (err, prev) => {
          if (isDevMode()) console.error('Database mutation error:', err);
          return allResource.set(prev);
        },
        onSuccess: () => {
          // TODO: fire broadcast channel event
        },
      },
    );

    const addMutation = transactionMutation(
      dbResource.value,
      (store, value: T) => {
        const key = store.add(value);
        return value;
      },
      'readwrite',
      storeName,
    );

    const value = toWritable(
      computed(() => {
        try {
          return allResource.value();
        } catch {
          return fallback;
        }
      }),
      (v) => setMutation.mutate(v),
    );

    return {} as any; // todo
  };
}

function createSliceFactory<T extends AnyObject>(
  dbResource: ResourceRef<IDBDatabase | undefined>,
) {}

export function database<T extends AnyObject>({
  dbName,
  version = 1,
  storeName = `${dbName}-store`,
  indexes = [],
  migrations = {},
  keyPath,
  equal = Object.is,
}: CreateDatabaseOptions<T>): Database<T> {
  if (!globalThis.indexedDB) return createNoopDB<T>();

  const dbPromise = new Promise<IDBDatabase>((res, rej) => {
    if (version < 1) rej(new Error('Version must be 1 or greater'));

    const req = indexedDB.open(dbName, version);

    req.onupgradeneeded = (event) => {
      const db = req.result;
      const oldVersion = event.oldVersion;
      const newVersion = event.newVersion || version;

      if (oldVersion > 0) {
        const pending: ((
          transaction: IDBTransaction,
          db: IDBDatabase,
        ) => void)[] = [];

        let notFound = false;

        for (let v = oldVersion + 1; v <= newVersion; v++) {
          const migration = migrations[v];
          if (migration) {
            pending.push(migration);
          } else {
            notFound = true;
            break; // since we're clearing the store, no need to check further versions.
          }
        }

        if (notFound) {
          db.deleteObjectStore(storeName);
        } else {
          pending.forEach((migration) => migration(req.transaction!, db));
        }

        const store = db.createObjectStore(storeName, {
          keyPath: keyPath.toString(),
        });

        indexes.forEach(({ name, keyPath, options }) => {
          if (!store.indexNames.contains(name)) {
            store.createIndex(name, keyPath, options);
          }
        });
      }
    };

    req.onerror = () => rej(req.error);
    req.onsuccess = () => res(req.result);
  });

  let dbResource = toResourceObject(
    resource({
      loader: () => dbPromise,
    }),
  );

  const value = dbResource.value;

  dbResource = {
    ...dbResource,
    value: toWritable(
      computed(() => {
        try {
          return value();
        } catch {
          return undefined;
        }
      }),
      (v) => value.set(v),
    ),
  };

  return {} as unknown as Database<T>; // todo
}
