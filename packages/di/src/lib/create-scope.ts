import {
  inject,
  Injectable,
  InjectionToken,
  Injector,
  runInInjectionContext,
  type Provider,
} from '@angular/core';

@Injectable()
export class ScopeRegistry {
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
