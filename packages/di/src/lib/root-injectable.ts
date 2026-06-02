import { inject, InjectionToken, Injector } from '@angular/core';

/**
 * Creates a root-level singleton wired into the global (`providedIn: 'root'`)
 * injector. Returns a typed `inject()` helper — calling it anywhere in an
 * injection context yields the same singleton instance. Useful for app-wide
 * signal stores, configuration, or services that don't need per-component
 * scoping.
 *
 * @typeParam T The type of the singleton value produced by the factory.
 * @param factory Factory invoked once (lazily) to construct the singleton.
 *   Receives the root `Injector` for cases where `inject()` isn't ergonomic.
 * @param name Optional token name (used as the debug name).
 * @returns A getter function that returns the same singleton instance on every call.
 *
 * @example
 * ```ts
 * // Define once at module scope:
 * const injectCurrentUser = rootInjectable(
 *   () => signal<User | null>(null),
 *   'CurrentUser',
 * );
 *
 * // Consume from anywhere in an injection context:
 * @Component({ ... })
 * class HeaderComponent {
 *   readonly user = injectCurrentUser();
 * }
 * ```
 */
export function rootInjectable<T>(
  factory: (injector: Injector) => T, // Keeping the injector just in case
  name?: string,
): () => T {
  const token = new InjectionToken<T>(name ?? '@mmstack/di/root-injectable', {
    providedIn: 'root',
    factory: () => factory(inject(Injector)),
  });

  return () => inject(token);
}
