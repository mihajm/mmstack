import {
  computed,
  effect,
  inject,
  InjectionToken,
  Injector,
  type Provider,
  type Signal,
  signal,
  untracked,
} from '@angular/core';

/**
 * Represents the possible states of a circuit breaker.
 * - `CLOSED`: The circuit breaker is closed, and operations are allowed to proceed.
 * - `OPEN`: The circuit breaker is open, and operations are blocked.
 * - `HALF_OPEN`: The circuit breaker is in a half-open state, allowing a limited number of operations to test if the underlying issue is resolved.
 */
type CircuitBreakerState = 'CLOSED' | 'OPEN' | 'HALF_OPEN';

/**
 * Represents a circuit breaker, which monitors operations and prevents failures from cascading.
 */
export type CircuitBreaker = {
  /**
   * A signal indicating whether the circuit breaker is currently closed (allowing operations).
   */
  isClosed: Signal<boolean>;
  /**
   *  A signal indicating whether the circuit breaker is either open or in a half-open state.
   * This is useful for checking if operations are blocked.
   * If the circuit breaker is open, operations should not proceed.
   */
  isOpen: Signal<boolean>;
  /**
   * A signal representing the current state of the circuit breaker.
   */
  status: Signal<CircuitBreakerState>;
  /**
   * Signals a failure to the circuit breaker.  This may cause the circuit breaker to open.
   */
  fail: (err?: Error) => void;
  /**
   * Signals a success to the circuit breaker.  This may cause the circuit breaker to close.
   */
  success: () => void;
  /**
   * Attempts to transition the circuit breaker to the half-open state. This is typically used
   * to test if the underlying issue has been resolved after the circuit breaker has been open.
   */
  halfOpen: () => void;
  /**
   * Fully resets the breaker state — clears the failure count, drops the half-open
   * flag, and lifts a permanent open caused by `shouldFailForever`. Use after the
   * underlying condition has been resolved (e.g. user re-authenticated after a
   * 401-triggered permanent open).
   */
  hardReset: () => void;
  /**
   * Destroys the circuit breaker & initiates related cleanup
   */
  destroy: () => void;
};

/**
 * Options for creating a circuit breaker.
 */
type CreateCircuitBreakerOptions = {
  /**
   * The number of failures that will cause the circuit breaker to open.
   * @default 5
   */
  threshold?: number;
  /**
   * @deprecated Misspelled — use `threshold` instead. Kept for backwards compatibility; will be removed in a future major.
   */
  treshold?: number;
  /**
   * The time in milliseconds after which the circuit breaker will reset and allow operations to proceed again.
   * @default 30000 (30 seconds)
   */
  timeout?: number;
  /**
   * A function that determines whether an error should cause the circuit breaker to increment the failure count.
   * @default Always returns true
   */
  shouldFail?: (err?: Error) => boolean;
  /**
   * A function that determines whether an error should cause the circuit breaker to be open forever.
   * `hardReset()` is required to lift this state.
   * @default Always returns false
   */
  shouldFailForever?: (err?: Error) => boolean;
};

/**
 * Options for creating a circuit breaker.
 *  - `false`: Disables circuit breaker functionality (always open).
 *  - true: Creates a new circuit breaker with default options.
 *  - `CircuitBreaker`: Provides an existing `CircuitBreaker` instance to use.
 *  - `{ threshold?: number; timeout?: number; }`: Creates a new circuit breaker with the specified options.
 */
export type CircuitBreakerOptions =
  | false
  | CircuitBreaker
  | CreateCircuitBreakerOptions;

/** @internal */
const DEFAULT_OPTIONS: Required<
  Omit<CreateCircuitBreakerOptions, 'treshold'>
> = {
  threshold: 5,
  timeout: 30000,
  shouldFail: () => true,
  shouldFailForever: () => false,
};

/** @internal */
function internalCeateCircuitBreaker(
  threshold = 5,
  resetTimeout = 30000,
  shouldFail: (err?: Error) => boolean = () => true,
  shouldFailForever: (err?: Error) => boolean = () => false,
): CircuitBreaker {
  const halfOpen = signal(false);
  const failureCount = signal(0);
  const failedForever = signal(false);

  const status = computed<CircuitBreakerState>(() => {
    if (failedForever() || failureCount() >= threshold) return 'OPEN';
    return halfOpen() ? 'HALF_OPEN' : 'CLOSED';
  });

  const isClosed = computed(() => status() !== 'OPEN');
  const isOpen = computed(() => status() !== 'CLOSED');

  const success = () => {
    failureCount.set(0);
    halfOpen.set(false);
  };

  const tryOnce = () => {
    if (!untracked(isOpen)) return;
    halfOpen.set(true);
    failureCount.set(threshold - 1);
  };

  // Auto-probe effect: schedules a half-open retry after `resetTimeout` whenever
  // the breaker is open, *unless* we've been failed forever (in which case only
  // hardReset() can recover).
  const effectRef = effect((cleanup) => {
    if (!isOpen() || failedForever()) return;

    const timeout = setTimeout(tryOnce, resetTimeout);
    return cleanup(() => {
      clearTimeout(timeout);
    });
  });

  const failInternal = () => {
    failureCount.set(failureCount() + 1);
    halfOpen.set(false);
  };

  const failForever = () => {
    failedForever.set(true);
    halfOpen.set(false);
  };

  const fail = (err?: Error) => {
    if (shouldFailForever(err)) return failForever();
    if (shouldFail(err)) return failInternal();
    // If the error does not trigger a failure, we do nothing.
  };

  const hardReset = () => {
    failedForever.set(false);
    failureCount.set(0);
    halfOpen.set(false);
  };

  return {
    status,
    isClosed,
    isOpen,
    fail,
    success,
    halfOpen: tryOnce,
    hardReset,
    destroy: () => effectRef.destroy(),
  };
}

/** @internal */
function createNeverBrokenCircuitBreaker(): CircuitBreaker {
  return {
    isClosed: computed(() => true),
    isOpen: computed(() => false),
    status: signal('CLOSED'),
    fail: () => {
      // noop
    },
    success: () => {
      // noop
    },
    halfOpen: () => {
      // noop
    },
    hardReset: () => {
      // noop
    },
    destroy: () => {
      // noop
    },
  };
}

const CB_DEFAULT_OPTIONS = new InjectionToken<
  Required<Omit<CreateCircuitBreakerOptions, 'treshold'>>
>('MMSTACK_CIRCUIT_BREAKER_DEFAULT_OPTIONS');

/**
 * Provides application-wide default options for {@link createCircuitBreaker}.
 * Any `createCircuitBreaker()` call without explicit options (or with only
 * partial options) merges these defaults in, so you can centralize threshold /
 * timeout / failure-classifier behavior in one place.
 *
 * Per-call options always win over the provided defaults.
 *
 * @example
 * ```ts
 * bootstrapApplication(AppComponent, {
 *   providers: [
 *     provideCircuitBreakerDefaultOptions({
 *       threshold: 10,
 *       timeout: 60_000,
 *       shouldFailForever: (err) =>
 *         err instanceof HttpErrorResponse && [401, 403].includes(err.status),
 *     }),
 *   ],
 * });
 * ```
 */
export function provideCircuitBreakerDefaultOptions(
  options: CircuitBreakerOptions,
): Provider {
  return {
    provide: CB_DEFAULT_OPTIONS,
    useValue: {
      ...DEFAULT_OPTIONS,
      ...normalizeThreshold(options),
    },
  };
}

function injectCircuitBreakerOptions(
  injector = inject(Injector),
): Required<Omit<CreateCircuitBreakerOptions, 'treshold'>> {
  return injector.get(CB_DEFAULT_OPTIONS, DEFAULT_OPTIONS, {
    optional: true,
  });
}

/** @internal — strips the deprecated `treshold` field and folds it into `threshold` */
function normalizeThreshold(
  opt: CircuitBreakerOptions | undefined,
): Partial<Omit<CreateCircuitBreakerOptions, 'treshold'>> {
  if (!opt || typeof opt !== 'object' || 'isClosed' in opt) return {};
  const { treshold, threshold, ...rest } = opt;
  return {
    ...rest,
    threshold: threshold ?? treshold,
  };
}

/**
 * Creates a circuit breaker instance.
 *
 * @param options - Configuration options for the circuit breaker.  Can be:
 *   - `undefined`:  Uses defaults (threshold: 5, timeout: 30000ms) or provided defaults via {@link provideCircuitBreakerDefaultOptions}.
 *   - `false`: Creates a "no-op" circuit breaker that is always closed (never trips).
 *   - `true`: Creates a circuit breaker with default settings.
 *   - `CircuitBreaker`:  Reuses an existing `CircuitBreaker` instance.
 *   - `{ threshold?: number; timeout?: number; }`: Creates a circuit breaker with the specified threshold and timeout.
 *
 * @returns A `CircuitBreaker` instance.
 *
 * @example
 * // Create a circuit breaker with default settings:
 * const breaker = createCircuitBreaker();
 *
 * // Create a circuit breaker with custom settings:
 * const customBreaker = createCircuitBreaker({ threshold: 10, timeout: 60000 });
 *
 * // Share a single circuit breaker instance across multiple resources:
 * const sharedBreaker = createCircuitBreaker();
 * const resource1 = queryResource(..., { circuitBreaker: sharedBreaker });
 * const resource2 = mutationResource(..., { circuitBreaker: sharedBreaker });
 */
export function createCircuitBreaker(
  opt?: CircuitBreakerOptions,
  injector?: Injector,
): CircuitBreaker {
  if (opt === false) return createNeverBrokenCircuitBreaker();

  if (typeof opt === 'object' && 'isClosed' in opt) return opt;

  const { threshold, timeout, shouldFail, shouldFailForever } = {
    ...injectCircuitBreakerOptions(injector),
    ...normalizeThreshold(opt),
  };

  return internalCeateCircuitBreaker(
    threshold,
    timeout,
    shouldFail,
    shouldFailForever,
  );
}
