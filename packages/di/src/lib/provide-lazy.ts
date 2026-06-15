import { inject, InjectionToken, type Provider } from '@angular/core';
import { injectAsync, type AsyncLoader } from './inject-async';

/**
 * Registers a lazily-loaded dependency against a token and returns a
 * `[injectFn, provideFn, token]` tuple. The provided value is a **loader**
 * (typically a dynamic `import()`) rather than an eager value.
 *
 * Drop `provideFn(loader)` into any `providers` array — a route, a component, or
 * `bootstrapApplication` — and call `injectFn()` deep in the tree to get a
 * memoized `() => Promise<T>` getter, without statically importing the module.
 *
 * **Scope-shared:** every consumer under the same provider boundary shares one
 * instance and one in-flight load. The resolver is built once, at the provide
 * site, so an auto-provided service is scoped to (and destroyed with) that
 * injector — matching what putting something in `providers` means. (For
 * per-consumer instances instead, call {@link injectAsync} directly with
 * `providedWith`.)
 *
 * The third tuple element is the raw loader `InjectionToken` — useful for
 * `TestBed.overrideProvider(token, { useValue: mockLoader })`.
 *
 * @typeParam T The type of the lazily-loaded dependency.
 * @param name Optional token name (used as the tokens' debug names).
 * @returns A tuple `[injectFn, provideFn, token]`.
 *
 * @example
 * ```ts
 * const [injectMarkdown, provideMarkdown] = provideLazy<MarkdownService>('Markdown');
 *
 * // Register the lazy dependency at a route boundary:
 * const routes: Routes = [
 *   {
 *     path: 'docs',
 *     providers: [
 *       provideMarkdown(() => import('./markdown.service').then((m) => m.MarkdownService)),
 *     ],
 *     loadComponent: () => import('./docs.component'),
 *   },
 * ];
 *
 * // Consume it anywhere under that route — no static import of the module:
 * @Component({ ... })
 * class DocsComponent {
 *   private readonly markdown = injectMarkdown();
 *   async preview(src: string) {
 *     return (await this.markdown()).render(src);
 *   }
 * }
 * ```
 */
export function provideLazy<T>(name = '@mmstack/di/provide-lazy') {
  const loaderToken = new InjectionToken<AsyncLoader<T>>(`${name}:loader`);
  // The shared resolver: a token whose factory runs once per provider scope, in
  // that scope's injection context, so injectAsync binds to the right injector.
  const handleToken = new InjectionToken<() => Promise<T>>(`${name}:handle`);

  const provideFn = (loader: AsyncLoader<T>): Provider[] => [
    { provide: loaderToken, useValue: loader },
    { provide: handleToken, useFactory: () => injectAsync(inject(loaderToken)) },
  ];

  function injectFn(): () => Promise<T>;
  function injectFn(opt: { optional: true }): () => Promise<T | null>;
  function injectFn(opt?: { optional?: boolean }): () => Promise<T | null> {
    const handle = inject(handleToken, { optional: true });
    if (handle) return handle;
    if (opt?.optional) return () => Promise.resolve(null);
    throw new Error(
      `[mmstack/di]: ${name} was injected but never provided. Add its provideFn(...) to a parent providers array, or pass { optional: true }.`,
    );
  }

  return [injectFn, provideFn, loaderToken] as const;
}
