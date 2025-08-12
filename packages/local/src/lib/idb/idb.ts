import {
  inject,
  Injectable,
  InjectionToken,
  type Provider,
} from '@angular/core';
import { createIDBClient, type CreateIDBClientOptions } from './idb-client';
import { type CreateIDBTableOptions, type IDBTable } from './idb-table';

const CONFIG_TOKEN = new InjectionToken<
  CreateIDBClientOptions & { dbName: string }
>('MMSTACK_DEFAULT_IDB_CONFIG');

const DEFAULT_DB_NAME = 'MMSTACK_DEFAULT_DB';

/**
 * The configuration provider for the default IDB client
 * @param config Configuration for the IDB client.
 * @example
 * ```typescript
 * provideDBConfig({
 *   dbName: 'my_custom_db',
 *   version: 2,
 *   syncTabs: true, // syncs changes across tabs via a BroadcastChannel
 *   schema: {
 *     myTable: {
 *       primaryKey: 'id',
 *       autoIncrement: true,
 *       indexes: {
 *         byEmail: { keyPath: 'email', options: { unique: true } },
 *         byName: { keyPath: 'name', options: { multiEntry: true } },
 *     },
 *   },
 * });
 * ```
 */
export function provideDBConfig(
  config: CreateIDBClientOptions & { dbName?: string },
): Provider {
  return {
    provide: CONFIG_TOKEN,
    useValue: {
      ...config,
      dbName: config.dbName ?? DEFAULT_DB_NAME,
    },
  };
}

@Injectable({
  providedIn: 'root',
})
export class DefaultConnection {
  private readonly cfg: CreateIDBClientOptions & { dbName: string } = inject(
    CONFIG_TOKEN,
    { optional: true },
  ) ?? {
    dbName: DEFAULT_DB_NAME,
    schema: {},
  };

  readonly client = createIDBClient(this.cfg.dbName, this.cfg);
}

/**
 * Options for creating an IDB table resource instance. If no client is provided, the default client will be used.
 */
export type CreateIDBOptions<T extends Record<PropertyKey, any>> = Omit<
  CreateIDBTableOptions<T>,
  'client'
> & {
  /**
   * Optionally provide a specific client to use for this table.
   */
  client?: CreateIDBTableOptions<T>['client'];
};

/**
 * Creates a Table resource instance for the given table name. This is an in-memory signal mirror to the data within an indexedDB table.
 * Updates to the table are reflected immediately in the resource's value & patched optimisically to the indexedDB table.
 * @param tableName The name of the table to create a resource for. Must have a matching schema provided in the IDBClient (typically via `provideDBConfig`).
 * @param opt Options for creating the table resource.
 * @returns An IDBTable instance that can be used to interact with the table.
 * @example
 * ```typescript
 * import { idb, provideDBConfig } from '@mmstack/local';
 *
 * type User = {
 *  id?: number;
 *  name: string;
 * };
 *
 * const appConfig = {
 * providers: [
 *   provideDBConfig({
 *     dbName: 'myAppDB',
 *     version: 1,
 *     schema: {
 *       users: {
 *         primaryKey: 'id',
 *         autoIncrement: true, // if true, the id will be auto-incremented and should not be provided in the add call
 *         indexes: {
 *           byName: { keyPath: 'name', options: { unique: false } }
 *         }
 *       }
 *     }
 *   })
 * ]
 * };
 *
 *  users.add({ name: 'John Doe' });
 *```
 */
export function idb<T extends Record<PropertyKey, any>>(
  tableName: string,
  opt: CreateIDBTableOptions<T>,
): IDBTable<T> {
  const client =
    opt.client ??
    (opt.injector
      ? opt.injector.get(DefaultConnection).client
      : inject(DefaultConnection).client);

  return client.useTable(tableName, opt);
}
