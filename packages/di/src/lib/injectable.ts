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
 * Creates a typed `InjectionToken` plus a tuple of `[inject, provide]` helpers.
 * Without configuration, the inject helper returns `T | null` when the token
 * hasn't been provided.
 *
 * @typeParam T The type of the value the token holds.
 * @param token Unique token identifier (used as the token's debug name).
 * @returns A tuple `[injectFn, provideFn]` for type-safe dependency injection.
 *
 * @example
 * ```ts
 * const [injectTheme, provideTheme] = injectable<'dark' | 'light'>('Theme');
 *
 * // In a provider scope:
 * bootstrapApplication(App, { providers: [provideTheme('dark')] });
 *
 * // In a consumer:
 * const theme = injectTheme(); // 'dark' | 'light' | null
 * ```
 */
export function injectable<T>(token: string): InjectFns<T | null>;

/**
 * Creates a typed `InjectionToken` with an eager fallback value. The inject
 * helper returns `T` (never `null`): when the token isn't provided, the
 * configured `fallback` is returned.
 *
 * @typeParam T The type of the value the token holds.
 * @param token Unique token identifier.
 * @param opt Configuration with `fallback` value (evaluated immediately).
 * @returns A tuple `[injectFn, provideFn]` for type-safe dependency injection.
 *
 * @example
 * ```ts
 * const [injectConfig, provideConfig] = injectable<Config>('Config', {
 *   fallback: { apiUrl: 'https://api.example.com', retries: 3 },
 * });
 *
 * const config = injectConfig(); // Always Config — never null
 * ```
 */
export function injectable<T>(
  token: string,
  opt: FallbackInjectableOptions<T>,
): InjectFns<T>;

/**
 * Creates a typed `InjectionToken` with a *lazy* fallback. The fallback
 * factory runs on first access (and only once) when the token isn't
 * provided — useful when constructing the default is expensive or has its
 * own dependencies.
 *
 * @typeParam T The type of the value the token holds.
 * @param token Unique token identifier.
 * @param opt Configuration with `lazyFallback` factory (deferred until needed).
 * @returns A tuple `[injectFn, provideFn]` for type-safe dependency injection.
 *
 * @example
 * ```ts
 * const [injectCache, provideCache] = injectable<Cache>('Cache', {
 *   lazyFallback: () => new Cache({ size: 1000 }), // only constructed if no override is provided
 * });
 * ```
 */
export function injectable<T>(
  token: string,
  opt: LazyFallbackInjectableOptions<T>,
): InjectFns<T>;

/**
 * Creates a typed `InjectionToken` that throws a custom error message when
 * the token isn't provided. Use this when "no provider" is genuinely a bug
 * rather than a permitted state.
 *
 * @typeParam T The type of the value the token holds.
 * @param token Unique token identifier.
 * @param opt Configuration with `errorMessage` to throw on missing provider.
 * @returns A tuple `[injectFn, provideFn]` for type-safe dependency injection.
 *
 * @example
 * ```ts
 * const [injectAuth, provideAuth] = injectable<AuthService>('Auth', {
 *   errorMessage: 'AuthService must be provided before any consumer reads it',
 * });
 *
 * const auth = injectAuth(); // throws if no provideAuth(...) is in scope
 * ```
 */
export function injectable<T>(
  token: string,
  opt: ErrorMessageInjectableOptions,
): InjectFns<T>;

/**
 * Creates a typed `InjectionToken` with a baked-in factory used as the lazy
 * fallback. The factory runs in an injection context, so it can use
 * `inject()` to compose dependencies.
 *
 * @typeParam T The type of the value the factory produces.
 * @param fn Factory function evaluated lazily on first inject if no override is provided.
 * @param name Optional token name (used as the debug name).
 * @returns A tuple `[injectFn, provideFn]` for type-safe dependency injection.
 *
 * @example
 * ```ts
 * const [injectUser, provideUser] = injectable(
 *   () => inject(HttpClient).get<User>('/api/me'),
 *   'CurrentUser',
 * );
 * ```
 */
export function injectable<T>(fn: () => T, name?: string): InjectFns<T>;

export function injectable<T>(
  tokenOrFn: string | (() => T),
  optOrString?: InjectableOptions<T> | string,
): InjectFns<T> {
  const token =
    typeof tokenOrFn === 'string'
      ? tokenOrFn
      : typeof optOrString === 'string'
        ? optOrString
        : '@mmstack/di/injectable';

  const opt =
    typeof tokenOrFn === 'function'
      ? { lazyFallback: tokenOrFn }
      : typeof optOrString === 'string'
        ? undefined
        : optOrString;

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
