import { createWatch } from '@angular/core/primitives/signals';
import type { OpLogDriver } from '@mmstack/primitives';

/**
 * An injector-free {@link OpLogDriver} for `@mmstack/primitives` `opLog`. Schedules the emission
 * reaction on the microtask queue via `createWatch` (Angular's renderer-independent watch
 * primitive) instead of an `effect`, so an opLog can run where there is no Angular injector: the
 * worker side of the worker-graph, whose store has no application tick driving it.
 *
 * This lives in `@mmstack/worker/host` rather than in primitives on purpose. `createWatch` is a
 * lower-tier signals-primitives export; keeping it out of `@mmstack/primitives` lets that package
 * back-port to older Angular majors that may not export it. The worker package tracks a newer
 * Angular where `createWatch` is available.
 *
 * Batching is per-microtask rather than per-app-tick; the worker protocol orders by
 * `(origin, version)`, never tick alignment, so that is safe.
 */
export function microtaskOpLogDriver(): OpLogDriver {
  return (run) => {
    let scheduled = false;
    const watch = createWatch(
      () => run(),
      (w) => {
        if (scheduled) return;
        scheduled = true;
        queueMicrotask(() => {
          scheduled = false;
          w.run();
        });
      },
      false,
    );
    watch.notify();
    return { destroy: () => watch.destroy() };
  };
}
