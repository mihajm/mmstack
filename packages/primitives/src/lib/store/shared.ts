export type BaseType =
  | string
  | number
  | boolean
  | symbol
  | undefined
  | null
  // eslint-disable-next-line @typescript-eslint/no-unsafe-function-type
  | Function
  | Date
  | RegExp
  | any[];

export type Key = string | number;

export type AnyRecord = Record<Key, any>;
