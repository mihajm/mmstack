import {
  inject,
  InjectionToken,
  type AbstractType,
  type InjectOptions,
  type Provider,
  type Type,
} from '@angular/core';

type ServiceType<T> =
  T extends Type<infer U>
    ? U
    : T extends AbstractType<infer U>
      ? U
      : T extends InjectionToken<infer U>
        ? U
        : never;

type MapDeps<T extends readonly any[]> = {
  [K in keyof T]: ServiceType<T[K]>;
};

type ProviderFn<T> = {
  (value: T): Provider;
  <const TDeps extends any[]>(
    fn: (...deps: MapDeps<TDeps>) => T,
    deps: TDeps,
  ): Provider;
};

type InjectFns<T> = [
  (opt?: Omit<InjectOptions, 'optional'>) => T,
  ProviderFn<T>,
];

type FallbackInjectableOptions<T> = {
  /** Default value returned when the injectable is not provided */
  fallback: T;
};

type LazyFallbackInjectableOptions<T> = {
  /** Function that returns a default value when the injectable is not provided. Useful for expensive defaults. */
  lazyFallback: () => T;
};

type ErrorMessageInjectableOptions = {
  /** Error message thrown when the injectable is not provided */
  errorMessage: string;
};

type InjectableOptions<T> =
  | FallbackInjectableOptions<T>
  | LazyFallbackInjectableOptions<T>
  | ErrorMessageInjectableOptions;

/**
 * Creates a typed InjectionToken with inject and provide helper functions.
 *
 * @param token - Unique token identifier
 * @param opt - Optional configuration for fallback value or error message
 * @returns A tuple of [injectFn, provideFn] for type-safe dependency injection
 */
export function injectable<T>(token: string): InjectFns<T | null>;

/**
 * Creates a typed InjectionToken with inject and provide helper functions.
 * Returns a fallback value when the injectable is not provided.
 *
 * @param token - Unique token identifier
 * @param opt - Configuration with fallback value
 * @returns A tuple of [injectFn, provideFn] for type-safe dependency injection
 */
export function injectable<T>(
  token: string,
  opt: FallbackInjectableOptions<T>,
): InjectFns<T>;

/**
 *
 * Creates a typed InjectionToken with inject and provide helper functions.
 * Returns a lazily evaluated fallback value when the injectable is not provided.
 *
 * @param token
 * @param opt
 */
export function injectable<T>(
  token: string,
  opt: LazyFallbackInjectableOptions<T>,
): InjectFns<T>;

/**
 * Creates a typed InjectionToken with inject and provide helper functions.
 * Throws an error with a custom message when the injectable is not provided.
 *
 * @param token - Unique token identifier
 * @param opt - Configuration with error message
 * @returns A tuple of [injectFn, provideFn] for type-safe dependency injection
 */
export function injectable<T>(
  token: string,
  opt: ErrorMessageInjectableOptions,
): InjectFns<T>;

export function injectable<T>(
  token: string,
  opt?: InjectableOptions<T>,
): InjectFns<T> {
  const injectionToken = new InjectionToken<T>(token);

  const options = opt as
    | Partial<
        FallbackInjectableOptions<T> &
          LazyFallbackInjectableOptions<T> &
          ErrorMessageInjectableOptions
      >
    | undefined;

  let fallback: T | undefined | null = options?.fallback;

  const initFallback =
    options?.lazyFallback ?? (() => options?.fallback ?? null);

  const fallbackFn = () => {
    if (fallback === undefined) fallback = initFallback();
    return fallback;
  };

  const injectFn = (iOpt?: Omit<InjectOptions, 'optional'>) => {
    const injected =
      inject(injectionToken, {
        ...iOpt,
        optional: true,
      }) ?? fallbackFn();

    if (injected === null && options?.errorMessage)
      throw new Error(options.errorMessage);

    return injected as T;
  };

  const provideFn = (
    fnOrValue: T | ((...deps: any[]) => T),
    deps?: any[],
  ): Provider => {
    if (deps !== undefined)
      return {
        provide: injectionToken,
        useFactory: fnOrValue as (...args: any[]) => T,
        deps,
      };

    return {
      provide: injectionToken,
      useValue: fnOrValue,
    };
  };

  return [injectFn, provideFn];
}
