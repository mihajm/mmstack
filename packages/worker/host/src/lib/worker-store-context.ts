import { createStoreContext, type toStoreOptions } from '@mmstack/primitives';

// Memoized at THIS module's scope. `@mmstack/worker/host` only ever loads inside a worker, so a
// module-scope singleton here is a per-thread singleton — the worker equivalent of an app's root
// injector (providedIn: 'root'). All stores in the worker share it; it is the graph's single
// proxy-identity + GC-coordination point.
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
