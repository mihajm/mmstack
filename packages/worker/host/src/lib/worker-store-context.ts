import { createStoreContext, type toStoreOptions } from '@mmstack/primitives';

let context: toStoreOptions | undefined;

/**
 * The one shared store context for this worker — pass it to every `store`/`toStore` you create in
 * the worker so they share proxy identity and cleanup, exactly as `providedIn: 'root'` shares one
 * cache across an app's stores.
 *
 * ```ts
 * // my.worker.ts
 * const todos = store<Todo[]>([], workerStoreContext());
 * const filter = store({ q: '' }, workerStoreContext()); // same context
 * ```
 */
export function workerStoreContext(): toStoreOptions {
  return (context ??= createStoreContext());
}
