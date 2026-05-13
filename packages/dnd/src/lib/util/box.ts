const DATA_KEY = Symbol('@mmstack/dnd:data');

type Boxed<T> = {
  [DATA_KEY]: T;
};

export function box<T>(value: T): Boxed<T> {
  return {
    [DATA_KEY]: value,
  };
}

export function unbox<T>(boxed: Boxed<T>): T {
  return boxed[DATA_KEY];
}
