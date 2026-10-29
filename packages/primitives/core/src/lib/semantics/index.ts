// The root surface is what an app reads an outcome with. The interpreter kit (operator algebra,
// array shims) is the `@mmstack/primitives/algebra` entry; the registry plumbing stays internal.
export { ABSORBER_PRECEDENCE, joinAbsorbers } from './algebra';
export {
  type Absorbing,
  DONE,
  type Done,
  error,
  errorConstant,
  errorEdge,
  errorHidden,
  type ErrorMintReport,
  type ErrorOrigin,
  type ErrorReporter,
  type ErrorSentinel,
  type ErrorSubclass,
  ifError,
  ifLoading,
  isAbsorbing,
  isDone,
  isError,
  isLoading,
  isSentinel,
  isSentinelAware,
  isStrictSentinels,
  loading,
  type Loading,
  type Sentinel,
  SENTINEL_KINDS,
  sentinelAware,
  type SentinelKind,
  SentinelLeakError,
  setErrorReporter,
  setStrictSentinels,
} from './sentinel';
export {
  inSensitiveRegion,
  isSensitive,
  isSensitiveMode,
  redact,
  registerCanonical,
  runSensitiveRegion,
  sensitive,
  SensitiveLeakError,
  setSensitiveMode,
  setSensitivePolicy,
  unbox,
  unboxAll,
} from './sensitive';
export { sensitiveEqual } from './sensitive-equal';
export {
  openWalk as ɵopenSensitiveWalk,
  type SensitiveWalk as ɵSensitiveWalk,
  walkSensitive as ɵwalkSensitive,
  type WalkStep as ɵSensitiveWalkStep,
} from './sensitive-walk';
export type { SensitivePolicy } from './sensitive-registry';
export { provideStrictSentinels } from './strict-sentinels';
