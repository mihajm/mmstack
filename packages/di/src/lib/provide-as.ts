import type { Provider, ProviderToken } from '@angular/core';

/**
 * Creates a provider for `token` from either a plain value (`useValue`) or a
 * zero-arg factory (`useFactory`), based on a runtime `typeof` check.
 *
 * The factory branch runs in an injection context, so it can use `inject()`:
 *
 * ```ts
 * provideAs(API_CONFIG, () => ({ baseUrl: inject(BASE_URL), retries: 3 }));
 * ```
 *
 * **Functions are ALWAYS treated as factories.** When `T` is itself a function
 * type, a bare function value would be misread as a factory — wrap it instead:
 *
 * ```ts
 * type Validator = (value: string) => boolean;
 * const isLongEnough: Validator = (v) => v.length > 5;
 *
 * provideAs(VALIDATOR, () => isLongEnough); // ✅ factory returning the function value
 * provideAs(VALIDATOR, isLongEnough);       // ❌ would CALL it as a factory
 * ```
 *
 * @typeParam T The type of the value the token holds.
 * @param token The token to provide.
 * @param value A value of `T`, or a factory producing `T` (run in an injection context).
 * @returns A `Provider` to add to a `providers` array.
 */
export function provideAs<T>(
  token: ProviderToken<T>,
  value: T | (() => T),
): Provider {
  return typeof value === 'function'
    ? {
        provide: token,
        useFactory: value,
      }
    : {
        provide: token,
        useValue: value,
      };
}
