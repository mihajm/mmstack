// import { computed } from '@angular/core';
// import { store } from '@mmstack/primitives';
// import { createWorkerHost, workerStoreContext } from '@mmstack/worker/host';

// /**
//  * The worker side of the worker+mesh demo. This device's graph lives here, off the main thread:
//  * it OWNS `doc` and PUBLISHES `derived`, a value it computes from `doc`. Mesh sync happens on the
//  * main thread against the doc replica (see worker-mesh-bridge.ts), so a remote peer's edit that
//  * lands here recomputes `derived` — proof the write really traversed this worker.
//  */
// export type Doc = { title: string };
// export type Derived = { titleLen: number; upper: string };

// const doc = store<Doc>({ title: '' }, workerStoreContext());

// const derived = computed<Derived>(() => {
//   const t = doc().title;
//   return { titleLen: t.length, upper: t.toUpperCase() };
// });

// export const host = createWorkerHost({
//   stores: { doc },
//   published: { derived },
// });

// export type MeshWorker = typeof host;
