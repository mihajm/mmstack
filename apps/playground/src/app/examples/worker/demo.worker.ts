import { computed } from '@angular/core';
import { store } from '@mmstack/primitives';
import { createWorkerHost, workerStoreContext } from '@mmstack/worker/host';

/**
 * The worker side of the demo. Runs entirely off the main thread:
 * - OWNS the `counter` store (main thread reads a replica, writes route here).
 * - PUBLISHES `stats`, a derived subtree recomputed here (rung 3).
 * - exposes `fib`, a heavy named task (rung 1, CSP-safe).
 *
 * `createWorkerHost` serves the worker's `self` scope by default.
 */
export type CounterState = { value: number; history: number[] };
export type Stats = { count: number; sum: number; avg: number; max: number };

const counter = store<CounterState>({ value: 0, history: [] }, workerStoreContext());

const stats = computed<Stats>(() => {
  const h = counter().history;
  const sum = h.reduce((a, b) => a + b, 0);
  return {
    count: h.length,
    sum,
    avg: h.length ? Math.round((sum / h.length) * 100) / 100 : 0,
    max: h.length ? Math.max(...h) : 0,
  };
});

const fib = (n: number): number => {
  let a = 0;
  let b = 1;
  for (let i = 0; i < n; i++) [a, b] = [b, a + b];
  return a;
};

const host = createWorkerHost({
  stores: { counter },
  published: { stats },
  tasks: { fib },
});

/** The worker's compile-time contract — imported (type-only) by the main thread for full inference. */
export type AppWorker = typeof host;
