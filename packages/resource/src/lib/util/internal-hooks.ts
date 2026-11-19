/** @internal Called by `queryResource` once a failure is final (no retry follows). */
export const ON_FINAL_ERROR: unique symbol = Symbol(
  '@mmstack/resource:on-final-error',
);

/** @internal */
export type InternalQueryHooks = {
  [ON_FINAL_ERROR]?: (err: unknown) => void;
};
