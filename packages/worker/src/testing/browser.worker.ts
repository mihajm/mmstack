import { computed } from '@angular/core';
import { store } from '@mmstack/primitives/core';
import {
  createWorkerHost,
  transfer,
  workerStoreContext,
} from '@mmstack/worker/host';

export type CounterState = { value: number; history: number[] };

const counter = store<CounterState>(
  { value: 0, history: [] },
  workerStoreContext(),
);

const stats = computed(() => {
  const h = counter().history;
  return { count: h.length, sum: h.reduce((a, b) => a + b, 0) };
});

const fib = (n: number): number => {
  let a = 0;
  let b = 1;
  for (let i = 0; i < n; i++) [a, b] = [b, a + b];
  return a;
};

// no `port`: the host must serve the worker global scope on its own
export const host = createWorkerHost({
  stores: { counter },
  published: { stats },
  tasks: {
    fib,
    bytes: (n: number) => {
      const out = new Uint8Array(n).fill(7).buffer;
      return transfer({ out }, [out]);
    },
    throwLater: () => {
      setTimeout(() => {
        throw new Error('uncaught in worker');
      });
      return 'scheduled';
    },
    unclonable: () => ({ format: () => 'x' }),
  },
});

export type BrowserWorker = typeof host;
