import {
  inject,
  Injectable,
  InjectionToken,
  Injector,
  runInInjectionContext,
  type Provider,
} from '@angular/core';

@Injectable()
class ScopeRegistry {
  private readonly injector = inject(Injector);
  // eslint-disable-next-line @typescript-eslint/no-unsafe-function-type
  private readonly registry = new Map<Function, any>();

  getOrCreate<T>(factory: () => T): T {
    if (this.registry.has(factory)) return this.registry.get(factory);

    const val = runInInjectionContext(this.injector, factory);
    this.registry.set(factory, val);
    return val;
  }
}

/**
 * Creates a specialized dependency injection scope.
 *
 * This utility allows you to create a localized dependency injection scope where you can
 * register and provide shared state, services, or primitives that are bound to a specific
 * component tree instead of the global root injector.
 *
 * @param name Optional name for the scope, primarily used for debugging and error messages.
 * @returns A tuple containing `[registerFn, provideFn]`:
 * - `registerFn`: A function to register a factory within the scope. Returns an injection function to retrieve the value.
 * - `provideFn`: An Angular provider function that must be added to the `providers` array where the scope begins.
 *
 * @example
 * ```ts
 * const [registerInUserScope, provideUserScope] = createScope('UserScope');
 *
 * // Define a state/service bound to this scope
 * const injectUserState = registerInUserScope(() => signal({ name: 'John Doe' }));
 * const injectLogger = registerInUserScope(() => {
 *  const globalLogger = inject(GlobalLogger);
 *  const user = injectUserState();
 *  return {
 *    log: (msg: string) => globalLogger.log(`[USER MODULE (${user().name})]: ${msg}`),
 *  }
 * })
 * @Component({
 *   providers: [provideUserScope()] // provides a new instance of every dependency registered to the scope
 * })
 * class ParentComponent {}
 *
 * @Component({})
 * class ChildComponent {
 *   readonly userState = injectUserState();
 *   readonly logger = injectLogger();
 * }
 * ```
 */
export function createScope(name?: string) {
  const token = new InjectionToken<ScopeRegistry>(name ?? '@mmstack/di/scope');

  const provideFn = (): Provider => ({
    provide: token,
    useClass: ScopeRegistry,
  });

  const registerFn = <T>(factory: () => T) => {
    return () => {
      const registry = inject(token, { optional: true });
      if (!registry)
        throw new Error(
          `[mmstack/di]: Scope ${name ?? 'unknown'} not found. Please make sure you provide it`,
        );

      return registry.getOrCreate(factory);
    };
  };

  return [registerFn, provideFn] as const;
}
