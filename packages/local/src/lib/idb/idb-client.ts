import {
  type Injector,
  isDevMode,
  resource,
  type ResourceRef,
} from '@angular/core';
import {
  createNoopConnection,
  type IDBConnection,
  promisifyRequest,
} from './idb-connection';
import {
  createEventFactory,
  dbEvents,
  type IDBChangeEvent,
  setupBroadcastChannel,
} from './idb-events';
import type { IDBSchema, IDBTableSchema } from './idb-schema';
import {
  type CreateIDBTableOptions,
  createNewTable,
  createNoopTable,
  type IDBTable,
} from './idb-table';
import { toResourceObject } from './to-resource-object';

/**
 * The main client object returned by createDB.
 * It manages the connection and acts as a factory for table handlers.
 */
export type IDBClient = ResourceRef<IDBConnection> & {
  /**
   * The name of the database.
   */
  name: string;
  /**
   * The version of the database.
   */
  version: number;
  /**
   * Creates or retrieves a table handler for the specified table name.
   * If the table does not exist, it will be created based on the schema.
   * @param tableName The name of the table to use.
   * @param opt Options for creating the table handler.
   * @returns An IDBTable handler for the specified table.
   */
  useTable: <
    T extends Record<PropertyKey, any>,
    TKey extends keyof T = keyof T,
  >(
    tableName: string,
    opt?: CreateIDBTableOptions<T>,
  ) => IDBTable<T, TKey>;
};

/** Options for creating the IDBClient */
export type CreateIDBClientOptions = {
  /**
   * The version of the database.
   * @default 1
   */
  version?: number;
  /** The schema definition for the database, mapping table names to their schemas. */
  schema: IDBSchema;
  /** A map of versions & their imperative migration functions. */
  migrations?: Record<number, (db: IDBDatabase, tx: IDBTransaction) => void>;
  /**
   * If true, the client will automatically sync changes across tabs.
   * @default false
   */
  syncTabs?: boolean;
  /**
   * Optional lifecycle hooks for the database connection.
   */
  lifeCycle?: {
    /**
     * Callback for when the database is blocked by another connection.
     * @param e The IDBVersionChangeEvent that triggered the block.
     */
    onBlocked?: (e: IDBVersionChangeEvent) => void;
    /**
     *
     * @param e The IDBVersionChangeEvent that triggered the version change.
     * This is called when the database version changes, allowing you to handle cleanup or updates.
     */
    onVersionChange?: (e: IDBVersionChangeEvent) => void;
    /**
     * Callback for when the database connection is closed.
     * @param e The event that triggered the close.
     */
    onClose?: (e: Event) => void;
  };
  /**
   * Optional injector to use for dependency injection.
   */
  injector?: Injector;
};

/**
 * Creates a new IDBClient instance, should be used when you require more than 1 IDB instance within an app. Otherwise simply configure the default one using `provideDBConfig`.
 * @see provideDBConfig
 * @param dbName The name of the database.
 * @param options The options for creating the IDBClient.
 * @returns A new IDBClient instance.
 */
export function createIDBClient(
  dbName: string,
  {
    version = 1,
    migrations = {},
    schema,
    syncTabs = false,
    injector,
    lifeCycle,
  }: CreateIDBClientOptions,
): IDBClient {
  // server platform check
  const IDBSupported = globalThis.indexedDB !== undefined;

  const { onBlocked, onVersionChange, onClose } = lifeCycle ?? {};

  const registry = new Map<string, IDBTable<any, any>>();

  const events$ = dbEvents(dbName, version, injector);

  let fireEvent = (_: IDBChangeEvent<any, any>): void => {
    // noop by default
  };

  const base = {
    name: dbName,
    version,
    useTable: <
      T extends Record<PropertyKey, any>,
      TKey extends keyof T = keyof T,
    >(
      tableName: string,
      options?: CreateIDBTableOptions<T>,
    ): IDBTable<T, TKey> => {
      const found = registry.get(tableName);
      if (found) return found as IDBTable<T, TKey>;

      const tableSchema = schema[tableName];

      if (!tableSchema) {
        if (isDevMode() && IDBSupported)
          console.error(
            `Table "${tableName}" not found in schema. Available tables: ${Object.keys(
              schema,
            ).join(', ')}`,
          );

        return createNoopTable<T, TKey>(tableName);
      }

      const eventFactory = createEventFactory<T, IDBValidKey>(
        dbName,
        version,
        tableName,
      );

      const newTable = createNewTable<T, TKey>(tableName, {
        ...options,
        injector: options?.injector ?? injector,
        schema: tableSchema as IDBTableSchema<T>,
        client: client,
        fireEvent: (e) => {
          const ev = eventFactory(e);
          fireEvent(ev);
          return ev;
        },
        events$,
      });

      registry.set(tableName, newTable);

      return {
        ...newTable,
        destroy: () => {
          newTable.destroy();
          registry.delete(tableName);
        },
      };
    },
  };

  const noopConnection = createNoopConnection();

  const dbPromise = new Promise<IDBDatabase>((res, rej) => {
    if (!IDBSupported)
      return rej(new Error('IndexedDB is not supported in this environment'));
    if (version < 1) rej(new Error('Version must be 1 or greater'));

    const req = indexedDB.open(dbName, version);

    if (onBlocked) {
      req.onblocked = onBlocked;
    }

    req.onupgradeneeded = (event) => {
      const db = req.result;
      const oldVersion = event.oldVersion;
      const newVersion = event.newVersion || version;

      // Ensure we have a transaction, which is always available in onupgradeneeded
      const tx = req.transaction;
      if (!tx) return;

      // Case 1: Fresh installation
      if (oldVersion === 0) {
        for (const tableName in schema) {
          const tableSchema = schema[tableName];
          if (!tableSchema) continue; // Skip if no schema defined

          const store = db.createObjectStore(tableName, {
            keyPath: tableSchema.primaryKey.toString(),
            autoIncrement: tableSchema.autoIncrement,
          });

          if (tableSchema.indexes) {
            for (const indexName in tableSchema.indexes) {
              const indexSchema = tableSchema.indexes[indexName];
              if (!indexSchema) continue; // typesafety
              store.createIndex(
                indexName,
                indexSchema.keyPath,
                indexSchema.options,
              );
            }
          }
        }

        return;
      }

      if (oldVersion >= newVersion) return;

      for (let i = oldVersion + 1; i <= version; i++) {
        const migrationFn = migrations[i];
        if (migrationFn) migrationFn(db, tx);
      }
    };

    //add hooks for blocking terminated events

    req.onerror = () => rej(req.error);
    req.onsuccess = () => res(req.result);
  });

  const connectionPromise = dbPromise
    .then((db) => {
      if (onClose) {
        db.onclose = onClose;
      }

      db.onversionchange = (e: IDBVersionChangeEvent) => {
        onVersionChange?.(e);
        // Close the database connection to allow version change
        db.close();
      };

      const connection: IDBConnection = {
        getAll: <T extends Record<PropertyKey, any>>(
          tableName: string,
          abortSignal?: AbortSignal,
        ): Promise<T[]> => {
          const tx = db.transaction(tableName, 'readonly');
          const store = tx.objectStore(tableName);
          return promisifyRequest(store.getAll(), tx, abortSignal);
        },
        add: <T>(
          tableName: string,
          value: T,
          abortSignal?: AbortSignal,
        ): Promise<IDBValidKey> => {
          const tx = db.transaction(tableName, 'readwrite');
          const store = tx.objectStore(tableName);
          return promisifyRequest(store.add(value), tx, abortSignal);
        },
        update: <T>(
          tableName: string,
          value: T,
          abortSignal?: AbortSignal,
        ): Promise<IDBValidKey> => {
          const tx = db.transaction(tableName, 'readwrite');
          const store = tx.objectStore(tableName);
          return promisifyRequest(store.put(value), tx, abortSignal);
        },
        remove: (
          tableName: string,
          key: IDBValidKey,
          abortSignal?: AbortSignal,
        ): Promise<void> => {
          const tx = db.transaction(tableName, 'readwrite');
          const store = tx.objectStore(tableName);
          return promisifyRequest(store.delete(key), tx, abortSignal).then(
            () => void 0,
          );
        },
      };

      return connection;
    })
    .catch((err) => {
      if (isDevMode() && IDBSupported)
        console.error('IDB connection error:', err);
      return noopConnection;
    });

  if (syncTabs) {
    fireEvent = setupBroadcastChannel(dbName, version, injector);
  }

  const connection = toResourceObject(
    resource({
      loader: () => connectionPromise,
      defaultValue: noopConnection,
    }),
    noopConnection,
  );

  const client: IDBClient = {
    ...connection,
    ...base,
  };

  return client;
}
