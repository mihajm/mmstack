// shared wire types, re-exported so main-thread consumers import only from '@mmstack/worker'
export * from '@mmstack/worker/protocol';

export {
  connectWorker,
  WorkerAbortError,
  WorkerCrashedError,
  type ConnectWorkerOptions,
  type WorkerManifest,
  type WorkerRef,
} from './lib/connect-worker';
export {
  PAUSED,
  workerResource,
  type WorkerParamsFn,
  type WorkerRequestContext,
  type WorkerResourceOptions,
  type WorkerResourceRef,
} from './lib/worker-resource';
export {
  workerStore,
  type WorkerStoreOptions,
  type WorkerStoreRef,
} from './lib/worker-store';
