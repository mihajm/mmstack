import {
  inject,
  Injectable,
  Injector,
  runInInjectionContext,
} from '@angular/core';

function generateID() {
  if (globalThis.crypto?.randomUUID) {
    return globalThis.crypto.randomUUID();
  }
  return Math.random().toString(36).substring(2);
}

@Injectable({
  providedIn: 'root',
})
export class RootInjectables {
  private readonly injector = inject(Injector);
  private readonly registry: Record<string, any> = {};

  register<T>(register: (injector: Injector) => T): string {
    let key = generateID();

    while (this.registry[key]) {
      key = generateID();
    }

    const injector = this.injector;

    const value = runInInjectionContext(this.injector, () =>
      register(injector),
    );
    this.registry[key] = value;

    return key;
  }

  get<T>(key: string): T {
    return this.registry[key];
  }
}

/**
 * Creates a lazily-initialized root-level injectable that maintains a singleton instance.
 * The factory function runs in the root injection context on first access.
 * This should only be used for pure singletons, if you need scoped instances use regular @Injectable services.
 *
 * @param register - Factory function that creates the injectable instance using the root injector
 * @returns An inject function that returns the singleton instance
 */
export function rootInjectable<T>(
  register: (injector: Injector) => T,
): () => T {
  let key: string | null = null;
  return () => {
    const registry = inject(RootInjectables);
    if (!key) {
      key = registry.register(register);
    }
    return registry.get<T>(key);
  };
}
