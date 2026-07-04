import { computed } from '@angular/core';
import { createStoreContext, store } from '@mmstack/primitives';
import { createWorkerHost } from '@mmstack/worker/host';
import type { SchemaOf } from '@mmstack/worker/protocol';
import { describe, expect, it } from 'vitest';
import type { WorkerRef } from './connect-worker';
import { workerStore } from './worker-store';

// compile-time contract: assertions are type-checked by the build; the body never runs (if (never))
function makeHost() {
  const counter = store(
    { value: 0, history: [] as number[] },
    createStoreContext(),
  );
  const stats = computed(() => ({ sum: 0, count: 0 }));
  return createWorkerHost({
    stores: { counter },
    published: { stats },
    tasks: { fib: (n: number) => n * 2 },
  });
}
type App = ReturnType<typeof makeHost>;

describe('manifest typing (compile-time)', () => {
  it('infers value types, gates write() to owned keys, and rejects bad keys', () => {
    const never = false as boolean;
    if (never) {
      const worker = null as unknown as WorkerRef<SchemaOf<App>>;

      const counter = workerStore(worker, 'counter');
      const cv: { value: number; history: number[] } | undefined =
        counter.value();
      void cv;
      counter.write((d) => d.value.set(1));

      const stats = workerStore(worker, 'stats');
      const sv: { sum: number; count: number } | undefined = stats.value();
      void sv;
      // @ts-expect-error published subtree is read-only — no write()
      stats.write(() => {
        // noop
      });

      const r: Promise<number> = worker.runTask('fib', 21);
      void r;
      // @ts-expect-error 'unknown' is not a task
      worker.runTask('unknown', 1);
    }
    expect(true).toBe(true);
  });
});
