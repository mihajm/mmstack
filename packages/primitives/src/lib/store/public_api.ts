export * from './fork-store';
export { isStore } from './internals';
export { isLeaf } from './leaf';
export {
  applyOps,
  diffOps,
  invertBatch,
  opLog,
  type CreateOpLogOptions,
  type OpBatch,
  type OpLog,
  type OpLogDriver,
  type StoreOp,
} from './op-log';
export {
  compareHlc,
  compareTotal,
  createHlcClock,
  type Hlc,
  type HlcClock,
} from './hlc';
export {
  createConvergingApply,
  isConflicted,
  keyedArray,
  lww,
  mergeThree,
  OP_PROTO_VERSION,
  opSync,
  policyStrategy,
  preserve,
  rebaseOps,
  type Conflicted,
  type ConvergingApply,
  type MergeContext,
  type MergeFn,
  type MergePolicyEntry,
  type OpEnvelope,
  type OpSync,
  type OpSyncOptions,
  type RebaseResult,
} from './op-sync';
export {
  storeHistory,
  type StoreHistory,
  type StoreHistoryOptions,
} from './store-history';
export {
  persist,
  persistedStore,
  providePersistedStoreOptions,
  PERSISTED_STORE_OPTIONS,
  type AsyncStore,
  type PersistHandle,
  type PersistOptions,
  type PersistedStore,
  type PersistedStoreDefaults,
  type PersistedStoreOptions,
} from './persisted-store';
export { isOpaque, opaque, type Opaque } from './opaque';
export {
  projection,
  reconcile,
  type ProjectionOptions,
  type ReconcileKey,
} from './projection';
export {
  createStoreContext,
  extendStore,
  mutableStore,
  store,
  toStore,
  type ExtendStoreOptions,
  type StoreOptions,
  type toStoreOptions,
} from './store';

export type {
  MutableSignalStore,
  SignalStore,
  WritableSignalStore,
} from './types';
