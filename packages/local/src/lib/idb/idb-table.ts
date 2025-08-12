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
import { generateID, type FireEvent, type IDBChangeEvent } from './idb-events';
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

type AddValue<T, TKey extends keyof T> = Omit<T, TKey> & {
  [K in TKey]?: IDBValidKey;
};

/**
 * Represents a table handler for IndexedDB.
 * It provides methods to add, update, and remove items,
 * as well as to retrieve the table's data.
 * It extends ResourceRef to provide reactive data handling.
 * All updates happen optimistcally and are reverted in case of an error.
 */
export type IDBTable<
  T extends Record<PropertyKey, any>,
  TKey extends keyof T,
> = Omit<ResourceRef<T[]>, 'set' | 'update'> & {
  /**
   * The name of the table.
   */
  name: string;
  /**
   * Adds a new item to the table.
   * @param value The item to add.
   * @returns A promise that resolves when the add operation is complete.
   */
  add: (value: AddValue<T, TKey>) => Promise<T[TKey]>;
  /**
   *
   * @param key The key of the item to update.
   * @param itemOrUpdater The new item or a function that takes the previous item and returns the new item.
   * @returns A promise that resolves when the update is complete.
   */
  update: (key: T[TKey], itemOrUpdater: T | ((prev: T) => T)) => Promise<void>;
  /**
   * Removes an item from the table by its key.
   * @param key The key of the item to remove.
   * @returns A promise that resolves when the remove operation is complete.
   */
  remove: (key: T[TKey]) => Promise<void>;
};

export function createNewTable<
  T extends Record<PropertyKey, any>,
  TKey extends keyof T,
>(
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
): IDBTable<T, TKey> {
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

  const add = async (
    item: AddValue<T, TKey>,
    fromEvent = false,
  ): Promise<T[TKey]> => {
    const prev = untracked(tableData.value);

    let tempKey = (item as any)[schema.primaryKey] as T[TKey] | undefined;

    if (schema.autoIncrement && tempKey === undefined && prev.length > 0) {
      const isString = typeof prev[0]?.[schema.primaryKey] === 'string';
      const isNumber = typeof prev[0]?.[schema.primaryKey] === 'number';
      if (isString) {
        tempKey = generateID() as T[TKey];
      } else if (isNumber) {
        tempKey = (Math.max(
          ...prev.map((v) => v[schema.primaryKey] as number),
        ) + 1) as T[TKey];
      }
    }

    try {
      tableData.update((cur) => [...cur, item as T]);

      let payload = item as T;

      if (!fromEvent) {
        const key = await untracked(client.value).add<T>(
          tableName,
          item as T,
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
        return key as T[TKey];
      }
      return tempKey as T[TKey];
    } catch (err) {
      if (isDevMode())
        console.error(`Error adding value to table ${tableName}:`, err);
      tableData.set(prev);
      return tempKey as T[TKey];
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

export function createNoopTable<
  T extends Record<PropertyKey, any>,
  TKey extends keyof T,
>(tableName: string): IDBTable<T, TKey> {
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
    add: () => Promise.resolve(Math.random() as T[TKey]),
    update: () => Promise.resolve(),
    remove: () => Promise.resolve(),
  };
}
