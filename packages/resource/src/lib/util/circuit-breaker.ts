import {
  computed,
  effect,
  inject,
  InjectionToken,
  Injector,
  Provider,
  Signal,
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
   * @default Always returns false
   */
  shouldFailForever?: (err?: Error) => boolean;
};

/**
 * Options for creating a circuit breaker.
 *  - `false`: Disables circuit breaker functionality (always open).
 *  - true: Creates a new circuit breaker with default options.
 *  - `CircuitBreaker`: Provides an existing `CircuitBreaker` instance to use.
 *  - `{ treshold?: number; timeout?: number; }`: Creates a new circuit breaker with the specified options.
 */
export type CircuitBreakerOptions =
  | false
  | CircuitBreaker
  | CreateCircuitBreakerOptions;

/** @internal */
const DEFAULT_OPTIONS: Required<CreateCircuitBreakerOptions> = {
  treshold: 5,
  timeout: 30000,
  shouldFail: () => true,
  shouldFailForever: () => false,
};

/** @internal */
function internalCeateCircuitBreaker(
  treshold = 5,
  resetTimeout = 30000,
  shouldFail: (err?: Error) => boolean = () => true,
  shouldFailForever: (err?: Error) => boolean = () => false,
): CircuitBreaker {
  const halfOpen = signal(false);
  const failureCount = signal(0);

  const status = computed<CircuitBreakerState>(() => {
    if (failureCount() >= treshold) return 'OPEN';
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
    failureCount.set(treshold - 1);
  };

  let failForeverResetId: ReturnType<typeof setTimeout> | null = null;
  const effectRef = effect((cleanup) => {
    if (!isOpen()) return;

    const timeout = setTimeout(tryOnce, resetTimeout);
    failForeverResetId = timeout;
    return cleanup(() => {
      clearTimeout(timeout);
      failForeverResetId = null;
    });
  });

  const failInternal = () => {
    failureCount.set(failureCount() + 1);
    halfOpen.set(false);
  };

  const failForever = () => {
    if (failForeverResetId) clearTimeout(failForeverResetId);
    effectRef.destroy();
    failureCount.set(Infinity);
    halfOpen.set(false);
    return;
  };

  const fail = (err?: Error) => {
    if (shouldFailForever(err)) return failForever();
    if (shouldFail(err)) return failInternal();
    // If the error does not trigger a failure, we do nothing.
  };

  return {
    status,
    isClosed,
    isOpen,
    fail,
    success,
    halfOpen: tryOnce,
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
    destroy: () => {
      // noop
    },
  };
}

const CB_DEFAULT_OPTIONS = new InjectionToken<
  Required<CreateCircuitBreakerOptions>
>('MMSTACK_CIRCUIT_BREAKER_DEFAULT_OPTIONS');

export function provideCircuitBreakerDefaultOptions(
  options: CircuitBreakerOptions,
): Provider {
  return {
    provide: CB_DEFAULT_OPTIONS,
    useValue: {
      ...DEFAULT_OPTIONS,
      ...options,
    },
  };
}

function injectCircuitBreakerOptions(
  injector = inject(Injector),
): Required<CreateCircuitBreakerOptions> {
  return injector.get(CB_DEFAULT_OPTIONS, DEFAULT_OPTIONS, {
    optional: true,
  });
}

/**
 * Creates a circuit breaker instance.
 *
 * @param options - Configuration options for the circuit breaker.  Can be:
 *   - `undefined`:  Creates a "no-op" circuit breaker that is always open (never trips).
 *   - `true`: Creates a circuit breaker with default settings (threshold: 5, timeout: 30000ms).
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

  const { treshold, timeout, shouldFail, shouldFailForever } = {
    ...injectCircuitBreakerOptions(injector),
    ...opt,
  };

  return internalCeateCircuitBreaker(
    treshold,
    timeout,
    shouldFail,
    shouldFailForever,
  );
}
