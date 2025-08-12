import { inject, Injectable, type Injector } from '@angular/core';
import { filter, Subject } from 'rxjs';

const EVENT_SYMBOL = Symbol.for('MMSTACK_LOCAL_EVENT');

type BaseEvent<TType, TPayload> = {
  [EVENT_SYMBOL]: true;
  type: TType;
  dbName: string;
  dbVersion: number;
  tableName: string;
  payload: TPayload;
};

export type IDBChangeEvent<T, TKey> =
  | BaseEvent<'add', T>
  | BaseEvent<
      'update',
      {
        key: TKey;
        value: T;
      }
    >
  | BaseEvent<'remove', TKey>;

@Injectable({
  providedIn: 'root',
})
export class IDBEventBus {
  readonly events$ = new Subject<IDBChangeEvent<any, any>>();
}

function generateID() {
  if (globalThis.crypto?.randomUUID) {
    return globalThis.crypto.randomUUID();
  }
  return Math.random().toString(36).substring(2);
}

function isChangeEvent(e: unknown): e is IDBChangeEvent<any, any> {
  return typeof e === 'object' && !!e && (e as any)[EVENT_SYMBOL] === true;
}

export function setupBroadcastChannel(
  dbName: string,
  dbVersion: number,
  injector?: Injector,
): (e: IDBChangeEvent<any, any>) => void {
  const bus = injector ? injector.get(IDBEventBus) : inject(IDBEventBus);
  const channel = new BroadcastChannel(
    `MMSTACK_DB_EVENTS_CHANNEL_${dbName}_${dbVersion}`,
  );
  const id = generateID();

  channel.onmessage = (e) => {
    const msg = e.data;
    if (!isChangeEvent(msg)) return;
    if (!('channelId' in msg) || msg.channelId === id) return;
    bus.events$.next(msg);
  };

  return (e) =>
    channel.postMessage({
      ...e,
      channelId: id,
      [EVENT_SYMBOL]: true,
    });
}

export type FireEvent<T, TKey> = (
  typeAndPayload: Pick<IDBChangeEvent<T, TKey>, 'type' | 'payload'>,
) => IDBChangeEvent<T, TKey>;

export function createEventFactory<T, TKey>(
  dbName: string,
  dbVersion: number,
  tableName: string,
): FireEvent<T, TKey> {
  return (
    typeAndPayload: Pick<IDBChangeEvent<T, TKey>, 'type' | 'payload'>,
  ): IDBChangeEvent<T, TKey> => {
    return {
      [EVENT_SYMBOL]: true,
      type: typeAndPayload.type,
      dbName,
      dbVersion,
      tableName,
      payload: typeAndPayload.payload,
    } as IDBChangeEvent<T, TKey>;
  };
}

export function dbEvents(
  dbName: string,
  dbVersion: number,
  injector?: Injector,
) {
  const bus = injector ? injector.get(IDBEventBus) : inject(IDBEventBus);
  return bus.events$.pipe(
    filter((e) => e.dbName === dbName && e.dbVersion === dbVersion),
  );
}
