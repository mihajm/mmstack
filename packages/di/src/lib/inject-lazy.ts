import {
  inject,
  Injector,
  runInInjectionContext,
  type HostAttributeToken,
  type InjectOptions,
  type ProviderToken,
} from '@angular/core';

const UNINITIALIZED_SYMBOL = Symbol('@mmstack/di/inject-lazy/uninitialized');

type OptionalInjectOptions = Omit<InjectOptions, 'optional'> & {
  optional: true;
};

type NonOptionalInjectOptions = Omit<InjectOptions, 'optional'> & {
  optional?: false;
};

/**
 * Defers the resolution and instantiation of a token until the returned getter
 * function is called. The resolved value is cached for subsequent calls — the
 * actual `inject()` call happens at most once, on first access.
 *
 * Useful for services that are expensive to construct, or for breaking
 * circular dependency chains in component fields.
 *
 * @typeParam T The type of the resolved dependency.
 * @param token The dependency token to inject.
 * @returns A getter function that returns the lazily resolved dependency.
 *
 * @example
 * ```ts
 * @Component({ ... })
 * class MyComponent {
 *   // Injection context captured at construction; HeavyService is NOT instantiated yet.
 *   private readonly getHeavy = injectLazy(HeavyService);
 *
 *   onClick = () => {
 *     // First access constructs HeavyService and caches it; subsequent calls return the same instance.
 *     this.getHeavy().doExpensiveThing();
 *   };
 * }
 * ```
 */
export function injectLazy<T>(token: ProviderToken<T>): () => T;

/**
 * Defers the resolution and instantiation of an optional token until the
 * returned getter is called. Returns `null` (not undefined) when the token
 * isn't provided, matching Angular's `inject(token, { optional: true })`
 * semantics.
 *
 * @typeParam T The type of the resolved dependency.
 * @param token The dependency token to inject.
 * @param options Injection options specifying optional resolution.
 * @returns A getter function that returns the lazily resolved dependency or `null`.
 *
 * @example
 * ```ts
 * const getAnalytics = injectLazy(AnalyticsService, { optional: true });
 *
 * function trackEvent(name: string) {
 *   getAnalytics()?.track(name); // safely no-op if Analytics isn't provided
 * }
 * ```
 */
export function injectLazy<T>(
  token: ProviderToken<T>,
  options: OptionalInjectOptions,
): () => T | null;

/**
 * Defers the resolution and instantiation of a token until the returned getter function is called.
 * The resolved value is cached for subsequent calls.
 *
 * @param token The dependency token to inject.
 * @param options Injection options specifying non-optional resolution.
 * @returns A getter function that returns the lazily resolved dependency.
 */
export function injectLazy<T>(
  token: ProviderToken<T>,
  options: NonOptionalInjectOptions,
): () => T;

/**
 * Defers reading a host attribute until the returned getter is called.
 * Mirrors {@link HostAttributeToken} resolution but lazily.
 *
 * @param token The host attribute token to inject.
 * @returns A getter function that returns the lazily resolved attribute string.
 *
 * @example
 * ```ts
 * @Directive({ ... })
 * class MyDirective {
 *   private readonly getRole = injectLazy(new HostAttributeToken('role'));
 *   // Only reads the DOM attribute when first accessed.
 * }
 * ```
 */
export function injectLazy(token: HostAttributeToken): () => string;

/**
 * Defers the resolution and instantiation of a host attribute token until the returned getter function is called.
 * The resolved value is cached for subsequent calls.
 *
 * @param token The host attribute token to inject.
 * @param options Injection options specifying non-optional resolution.
 * @returns A getter function that returns the lazily resolved attribute string.
 */
export function injectLazy(
  token: HostAttributeToken,
  options?: {
    optional?: false;
  },
): () => string;

/**
 * Defers the resolution and instantiation of a host attribute token until the returned getter function is called.
 * The resolved value is cached for subsequent calls.
 *
 * @param token The host attribute token to inject.
 * @param options Injection options specifying optional resolution.
 * @returns A getter function that returns the lazily resolved attribute string or null.
 */
export function injectLazy(
  token: HostAttributeToken,
  options: {
    optional: true;
  },
): () => string | null;

export function injectLazy<T>(
  token: ProviderToken<T> | HostAttributeToken,
  options?: Partial<OptionalInjectOptions | NonOptionalInjectOptions>,
): () => T | string | null {
  const injector = inject(Injector);
  let instance: T | string | null | typeof UNINITIALIZED_SYMBOL =
    UNINITIALIZED_SYMBOL;

  return () => {
    if (instance === UNINITIALIZED_SYMBOL)
      instance = runInInjectionContext(injector, () => {
        return options
          ? inject(token as any, options as any)
          : inject(token as any);
      });

    return instance as T | string | null;
  };
}
