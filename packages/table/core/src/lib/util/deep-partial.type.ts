export type DeepPartial<T> = {
  [P in keyof T]?: T[P] extends any[]
    ? T[P]
    : T[P] extends object
      ? DeepPartial<T[P]>
      : T[P];
};
