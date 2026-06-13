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
  // eslint-disable-next-line @typescript-eslint/no-unsafe-function-type
  private readonly resolving = new Set<Function>();
  // original factory → replacement factory (testing/storybook overrides)
  // eslint-disable-next-line @typescript-eslint/no-unsafe-function-type
  overrides: Map<Function, Function> | null = null;

  getOrCreate<T>(
    factory: () => T,
    scopeName?: string,
    factoryName?: string,
  ): T {
    if (this.registry.has(factory)) return this.registry.get(factory);
    if (this.resolving.has(factory)) {
      const resolvedName = factoryName ?? (factory.name || undefined);
      throw new Error(
        `[mmstack/di]: Circular dependency detected in scope "${scopeName ?? 'unknown'}"${resolvedName ? ` while resolving "${resolvedName}"` : ''}`,
      );
    }

    this.resolving.add(factory);
    try {
      const actual = (this.overrides?.get(factory) ?? factory) as () => T;
      const val = runInInjectionContext(this.injector, actual);
      // cache under the ORIGINAL factory — the inject helpers always look up by it,
      // override or not
      this.registry.set(factory, val);
      return val;
    } finally {
      this.resolving.delete(factory);
    }
  }
}

/**
 * A `[injectFn, replacementFactory]` pair used to swap a registered factory at a
 * specific scope boundary — see {@link createScope}'s `provideFn` options.
 */
export type ScopeOverride<T = unknown> = readonly [() => T, () => NoInfer<T>];

/**
 * Creates a specialized dependency injection scope.
 *
 * This utility allows you to create a localized dependency injection scope where you can
 * register and provide shared state, services, or primitives that are bound to a specific
 * component tree instead of the global root injector. Each component subtree that provides
 * the scope gets its own, isolated set of instances.
 *
 * @param name Optional name for the scope, primarily used for debugging and error messages.
 * @returns A tuple containing `[registerFn, provideFn]`:
 * - `registerFn`: A function to register a factory within the scope. Returns an injection function to retrieve the value.
 * - `provideFn`: An Angular provider function that must be added to the `providers` array where the scope begins.
 *   Accepts optional `{ overrides }` — pairs of `[injectFn, replacementFactory]` that swap
 *   specific registrations at this boundary only (great for tests and Storybook).
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
 *
 * // In a test or story, stub a single registration:
 * TestBed.configureTestingModule({
 *   providers: [
 *     provideUserScope({
 *       overrides: [[injectLogger, () => ({ log: () => void 0 })]],
 *     }),
 *   ],
 * });
 * ```
 */
export function createScope(name?: string) {
  const token = new InjectionToken<ScopeRegistry>(name ?? '@mmstack/di/scope');

  // links each returned inject helper back to its registered factory, so
  // overrides can be keyed by the (public) inject helper
  // eslint-disable-next-line @typescript-eslint/no-unsafe-function-type
  const factoryByInjectFn = new WeakMap<Function, Function>();

  const provideFn = (opt?: {
    /**
     * Swap specific registrations at this scope boundary: each entry is the
     * inject helper returned by `registerFn` paired with a replacement factory.
     * The replacement runs in the same injection context the original would.
     */
    overrides?: ScopeOverride<any>[];
  }): Provider => ({
    provide: token,
    useFactory: () => {
      const registry = new ScopeRegistry();
      if (opt?.overrides?.length) {
        registry.overrides = new Map(
          opt.overrides.map(([injectFn, replacement]) => {
            const original = factoryByInjectFn.get(injectFn);
            if (!original)
              throw new Error(
                `[mmstack/di]: Override target is not registered in scope "${name ?? 'unknown'}" — pass the inject helper returned by this scope's registerFn`,
              );
            return [original, replacement] as const;
          }),
        );
      }
      return registry;
    },
  });

  const registerFn = <T>(factory: () => T, factoryName?: string) => {
    const injectFn = () => {
      const registry = inject(token, { optional: true });
      if (!registry)
        throw new Error(
          `[mmstack/di]: Scope ${name ?? 'unknown'} not found. Please make sure you provide it`,
        );

      return registry.getOrCreate(factory, name, factoryName);
    };

    factoryByInjectFn.set(injectFn, factory);

    return injectFn;
  };

  return [registerFn, provideFn] as const;
}
