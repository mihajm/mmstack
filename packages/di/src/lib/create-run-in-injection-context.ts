import { inject, Injector, runInInjectionContext } from '@angular/core';

/**
 * Captures an injection context and returns a runner function.
 *
 * This runner function allows you to execute callbacks inside the captured context at a later time.
 * It's really just a slight DX improvement over calling `runInInjectionContext` over and over.
 *
 * @param injector An optional injector. If not provided, the current context's injector is pulled natively via `inject(Injector)`.
 * @returns A runner function that executes any provided callback within the captured context.
 *
 * @example
 * ```ts
 * @Component({ ... })
 * class MyComponent {
 *   // Capture at construction so we can run injection-context code later.
 *   private readonly run = createRunInInjectionContext();
 *
 *   onClick = () => {
 *     // `inject()` works here even though we're no longer in an injection context.
 *     const value = this.run(() => inject(SomeService).doThing());
 *   };
 * }
 * ```
 */
export function createRunInInjectionContext(injector?: Injector) {
  if (!injector) injector = inject(Injector);

  return <T>(fn: () => T) => runInInjectionContext(injector, fn);
}
