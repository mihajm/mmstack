/**
 * The compile-time SHAPE of a worker host — its owned stores, published derivations, and tasks
 * (key → value/signature). It is a phantom: carried through `typeof host` for main-thread type
 * inference, never present at runtime. `workerStore`/`runTask` read it to constrain keys, infer
 * value types, and expose `write()` only on OWNED (writable) subtrees.
 */
export type WorkerSchema = {
  readonly stores: Record<string, unknown>;
  readonly published: Record<string, unknown>;
  readonly tasks: Record<string, (...args: any[]) => any>;
};

/** An empty schema — the default for an untyped connection (keys are `string`, values `unknown`). */
export type EmptyWorkerSchema = {
  readonly stores: Record<string, never>;
  readonly published: Record<string, never>;
  readonly tasks: Record<string, never>;
};

declare const WORKER_SCHEMA: unique symbol;

/** Phantom-tags a type with its {@link WorkerSchema} `M` so `SchemaOf` can recover it. */
export type HasSchema<M extends WorkerSchema> = { readonly [WORKER_SCHEMA]?: M };

/**
 * Recovers the {@link WorkerSchema} carried by a `WorkerHost`/`WorkerRef` (via {@link HasSchema}),
 * or passes a raw schema through — so `connectWorker<typeof host>()` and `connectWorker<MySchema>()`
 * both work. Falls back to the loose schema otherwise.
 */
export type SchemaOf<H> = H extends HasSchema<infer M>
  ? M
  : H extends WorkerSchema
    ? H
    : WorkerSchema;

/** The input type of a schema's task `K`. */
export type TaskInput<M extends WorkerSchema, K extends keyof M['tasks']> =
  Parameters<M['tasks'][K]>[0];

/** The resolved output type of a schema's task `K`. */
export type TaskOutput<M extends WorkerSchema, K extends keyof M['tasks']> =
  Awaited<ReturnType<M['tasks'][K]>>;

/** Keys addressable by `workerStore` — owned OR published. */
export type StoreKeys<M extends WorkerSchema> =
  | (keyof M['stores'] & string)
  | (keyof M['published'] & string);

/** The value type behind a store/published key. */
export type StoreValueOf<M extends WorkerSchema, K extends string> =
  K extends keyof M['stores']
    ? M['stores'][K]
    : K extends keyof M['published']
      ? M['published'][K]
      : unknown;

/** True when a key is an OWNED (writable) subtree — used to gate `write()`. */
export type IsWritableKey<M extends WorkerSchema, K extends string> =
  K extends keyof M['stores'] ? true : false;

/** Extracts the value type a signal/store holds (for building a schema from host options). */
export type SignalValueOf<S> = S extends {
  (): infer V;
}
  ? V
  : never;
