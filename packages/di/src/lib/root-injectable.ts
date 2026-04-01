import { inject, InjectionToken, Injector } from '@angular/core';

/**
 * Creates a root-level singleton hooked into the global injector.
 * @example const injectUser = rootInjectable(() => ({ name: signal('John') }));
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
