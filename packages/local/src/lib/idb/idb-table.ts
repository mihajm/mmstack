import {
  isDevMode,
  resource,
  untracked,
  type Injector,
  type ResourceRef,
  type ValueEqualityFn,
} from '@angular/core';
import { filter, Observable } from 'rxjs';
import type { IDBClient } from './idb-client';
import type { IDBConnection } from './idb-connection';
import type { FireEvent, IDBChangeEvent } from './idb-events';
import type { IDBTableSchema } from './idb-schema';
import { toResourceObject } from './to-resource-object';

/**
 * Options for creating an IDBTable.
 * This includes the client, injector, and optional equality function for comparing values.
 */
export type CreateIDBTableOptions<T extends Record<PropertyKey, any>> = {
  /**
   * The client to use for the table operations.
   */
  client: IDBClient;
  injector?: Injector;
  equal?: ValueEqualityFn<T>;
};

/**
 * Represents a table handler for IndexedDB.
 * It provides methods to add, update, and remove items,
 * as well as to retrieve the table's data.
 * It extends ResourceRef to provide reactive data handling.
 * All updates happen optimistcally and are reverted in case of an error.
 */
export type IDBTable<T extends Record<PropertyKey, any>> = Omit<
  ResourceRef<T[]>,
  'set' | 'update'
> & {
  /**
   * The name of the table.
   */
  name: string;
  /**
   * Adds a new item to the table.
   * @param value The item to add.
   * @returns A promise that resolves when the add operation is complete.
   */
  add: (value: T) => Promise<void>;
  /**
   *
   * @param key The key of the item to update.
   * @param itemOrUpdater The new item or a function that takes the previous item and returns the new item.
   * @returns A promise that resolves when the update is complete.
   */
  update: (
    key: IDBValidKey,
    itemOrUpdater: T | ((prev: T) => T),
  ) => Promise<void>;
  /**
   * Removes an item from the table by its key.
   * @param key The key of the item to remove.
   * @returns A promise that resolves when the remove operation is complete.
   */
  remove: (key: IDBValidKey) => Promise<void>;
};

export function createNewTable<T extends Record<PropertyKey, any>>(
  tableName: string,
  {
    client,
    schema,
    injector,
    equal = Object.is,
    fireEvent,
    events$,
  }: CreateIDBTableOptions<T> & {
    schema: IDBTableSchema<T>;
    fireEvent: FireEvent<T, IDBValidKey>;
    events$: Observable<IDBChangeEvent<T, IDBValidKey>>;
  },
): IDBTable<T> {
  const rawTableData = toResourceObject(
    resource<T[], IDBConnection>({
      params: () => client.value(),
      loader: ({ params }) => params.getAll(tableName),
      defaultValue: [],
      equal: (a, b) => {
        if (a.length !== b.length) return false;
        if (a.length === 0) return true;

        return a.every((v, i) => {
          if (b[i] === undefined) return v !== undefined;
          return equal(v, b[i]);
        });
      },
      injector,
    }),
    [],
  );

  const sub = events$
    .pipe(filter((e) => e.tableName === tableName))
    .subscribe((ev) => {
      switch (ev.type) {
        case 'add':
          return add(ev.payload, true);
        case 'remove':
          return remove(ev.payload, true);
        case 'update':
          return update(ev.payload.key, ev.payload.value, true);
      }
    });

  const controller = new AbortController();

  const tableData = {
    ...rawTableData,
    destroy: () => {
      rawTableData.destroy();
      sub.unsubscribe();
      controller.abort();
    },
  };

  const add = async (item: T, fromEvent = false): Promise<void> => {
    const prev = untracked(tableData.value);

    try {
      const tempKey = item[schema.primaryKey];
      tableData.update((cur) => [...cur, item]);
      let payload = item;
      if (!fromEvent) {
        const key = await untracked(client.value).add<T>(
          tableName,
          item,
          controller.signal,
        );
        if (key !== tempKey) {
          payload = { ...item, [schema.primaryKey]: key } as T;
          tableData.update((cur) =>
            cur.map((v) => (v[schema.primaryKey] === tempKey ? payload : v)),
          );
        }
        fireEvent({
          type: 'add',
          payload,
        });
      }
    } catch (err) {
      if (isDevMode())
        console.error(`Error adding value to table ${tableName}:`, err);
      tableData.set(prev);
    }
  };

  const remove = async (key: IDBValidKey, fromEvent = false): Promise<void> => {
    const prev = untracked(tableData.value);

    try {
      tableData.update((cur) =>
        cur.filter((v) => v[schema.primaryKey] !== key),
      );
      if (!fromEvent) {
        await untracked(client.value).remove(tableName, key, controller.signal);
        fireEvent({
          type: 'remove',
          payload: key,
        });
      }
    } catch (err) {
      if (isDevMode())
        console.error(`Error removing ${key} from table ${tableName}:`, err);
      tableData.set(prev);
    }
  };

  const update = async (
    key: IDBValidKey,
    itemOrUpdater: T | ((prev: T) => T),
    fromEvent = false,
  ) => {
    const prev = untracked(tableData.value);

    const updater =
      typeof itemOrUpdater === 'function' ? itemOrUpdater : () => itemOrUpdater;

    try {
      let nextValue: T | undefined;

      const mapped: T[] = prev.map((v) => {
        if (v[schema.primaryKey] !== key || nextValue !== undefined) return v;
        const next = updater(v);
        nextValue = next;
        return next;
      });

      if (!nextValue) return;

      tableData.set(mapped);
      if (!fromEvent) {
        await untracked(client.value).update<T>(
          tableName,
          nextValue,
          controller.signal,
        );
        fireEvent({
          type: 'update',
          payload: { key, value: nextValue },
        });
      }
    } catch (err) {
      if (isDevMode())
        console.error(`Error removing ${key} from table ${tableName}:`, err);
      tableData.set(prev);
    }
  };

  return {
    ...tableData,
    add,
    remove,
    update,
    name: tableName,
  };
}

export function createNoopTable<T extends Record<PropertyKey, any>>(
  tableName: string,
): IDBTable<T> {
  const data = toResourceObject<T[]>(
    resource({
      loader: () => Promise.resolve([]),
      defaultValue: [],
    }),
    [],
  );

  return {
    ...data,
    name: tableName,
    add: () => Promise.resolve(),
    update: () => Promise.resolve(),
    remove: () => Promise.resolve(),
  };
}
