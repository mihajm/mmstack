import { isPlatformBrowser } from '@angular/common';
import {
  assertInInjectionContext,
  DestroyRef,
  inject,
  InjectionToken,
  Injector,
  isDevMode,
  PLATFORM_ID,
  type InjectOptions,
  type ProviderToken,
  type Type,
} from '@angular/core';

interface DefaultExport<T> {
  /**
   * Default exports are bound under the name `"default"`, per the ES Module spec:
   * https://tc39.es/ecma262/#table-export-forms-mapping-to-exportentry-records
   */
  default: T;
}

// Sentinel distinguishing "not provided anywhere" from a legitimately provided
// null/undefined/falsy value during the resolution probe.
const NOT_FOUND = Symbol('@mmstack/di/inject-async/not-found');

/**
 * The loader passed to {@link injectAsync} / {@link provideLazy}: an async
 * function resolving to a provider token, typically a dynamic `import()`.
 *
 * Both shapes are accepted — return the token directly
 * (`() => import('./svc').then(m => m.Svc)`) or rely on default-export
 * unwrapping (`() => import('./svc')` where the module `default`-exports it).
 */
export type AsyncLoader<T> = () => Promise<
  ProviderToken<T> | DefaultExport<ProviderToken<T>>
>;

/**
 * A trigger that resolves when the lazy-loaded dependency should be eagerly
 * prefetched. Mirrors Angular v22's `PrefetchTrigger`.
 */
export type PrefetchTrigger = () => Promise<void>;

/**
 * How to prefetch a lazy dependency: a custom {@link PrefetchTrigger}, the
 * built-in `'idle'` (prefetch when the browser goes idle), or a `number` of
 * milliseconds (prefetch when idle, but no later than that deadline).
 */
export type Prefetch = PrefetchTrigger | 'idle' | number;

/**
 * Options for {@link injectAsync}. The spatial flags (`self`/`skipSelf`/`host`)
 * and `optional` mirror Angular's `InjectOptions` and behave as they do for
 * `injectLazy`. `prefetch` and `providedWith` are mmstack additions.
 */
export interface InjectAsyncOptions extends Pick<
  InjectOptions,
  'optional' | 'self' | 'skipSelf' | 'host'
> {
  /**
   * Eagerly load (and resolve) the dependency ahead of the first explicit
   * access. Accepts `'idle'`, a millisecond deadline, or a custom
   * {@link PrefetchTrigger}. Only ever runs in the browser, and is skipped on
   * slow / data-saver connections — a no-op on the server.
   */
  prefetch?: Prefetch;
  /**
   * The injector the loaded token is resolved & auto-provided against, and whose
   * lifetime scopes an auto-provided instance. Defaults to the call-site
   * injector. Pass an `InjectionToken<Injector>` to resolve the target lazily
   * from the current context (the mechanism {@link provideLazy} builds on).
   */
  providedWith?: Injector | InjectionToken<Injector>;
}

function maybeUnwrapDefaultExport<T>(value: T | DefaultExport<T>): T {
  return value && typeof value === 'object' && 'default' in value
    ? (value as DefaultExport<T>).default
    : (value as T);
}

/**
 * Lazily loads a service's code chunk (via the async `loader`, typically a
 * dynamic `import()`) and resolves it from DI on first access — a v19+ port of
 * Angular v22's native `injectAsync`, with a few additions.
 *
 * Returns a memoized getter: the loader runs at most once, and the resolved
 * instance is cached. Must be called in an injection context.
 *
 * Unlike native `injectAsync`, the loaded token does **not** have to be
 * `providedIn: 'root'`. Resolution is a behavioral probe, not metadata
 * inspection:
 * - if the token resolves through normal DI (a `providedIn:'root'` singleton, or
 *   anything provided up the tree) you get that instance — identical to native;
 * - otherwise, if it's a class, it is auto-provided in an on-the-fly child
 *   injector scoped to (and destroyed with) the target injector;
 * - a bare `InjectionToken` with no provider throws, unless `{ optional: true }`.
 *
 * @typeParam T The type of the lazily-loaded dependency.
 * @param loader Async function resolving to the provider token (or a module
 *   whose `default` export is the token).
 * @param options See {@link InjectAsyncOptions}.
 * @returns A memoized getter returning a `Promise` of the resolved dependency.
 *
 * @example
 * ```ts
 * @Component({ ... })
 * class EditorComponent {
 *   private readonly markdown = injectAsync(() =>
 *     import('./markdown.service').then((m) => m.MarkdownService),
 *   );
 *
 *   async preview(src: string) {
 *     const svc = await this.markdown();
 *     return svc.render(src);
 *   }
 * }
 * ```
 */
export function injectAsync<T>(
  loader: () => Promise<ProviderToken<T>>,
  options: InjectAsyncOptions & { optional: true },
): () => Promise<T | null>;
export function injectAsync<T>(
  loader: () => Promise<DefaultExport<ProviderToken<T>>>,
  options: InjectAsyncOptions & { optional: true },
): () => Promise<T | null>;
export function injectAsync<T>(
  loader: () => Promise<ProviderToken<T>>,
  options?: InjectAsyncOptions,
): () => Promise<T>;
export function injectAsync<T>(
  loader: () => Promise<DefaultExport<ProviderToken<T>>>,
  options?: InjectAsyncOptions,
): () => Promise<T>;
export function injectAsync<T>(
  loader: AsyncLoader<T>,
  options: InjectAsyncOptions & { optional: true },
): () => Promise<T | null>;
export function injectAsync<T>(
  loader: AsyncLoader<T>,
  options?: InjectAsyncOptions,
): () => Promise<T>;
export function injectAsync<T>(
  loader: AsyncLoader<T>,
  options?: InjectAsyncOptions,
): () => Promise<T | null> {
  assertInInjectionContext(injectAsync);

  const callSiteInjector = inject(Injector);

  const { optional, providedWith, ...spatial } = options ?? {};

  const target = !providedWith
    ? callSiteInjector
    : providedWith instanceof InjectionToken
      ? inject(providedWith)
      : providedWith;

  const ownerDestroyRef =
    target === callSiteInjector
      ? inject(DestroyRef)
      : (target.get(DestroyRef, null) ?? inject(DestroyRef));

  // PLATFORM_ID's browser value is the stable string 'browser' (same check
  // `isPlatformBrowser` performs) — compared directly to avoid an
  // `@angular/common` dependency.
  const isBrowser = isPlatformBrowser(inject(PLATFORM_ID));

  // host destroyed mid-import
  let child: (Injector & { destroy?(): void }) | null = null;

  let ownerDestroyed = false;

  ownerDestroyRef.onDestroy(() => {
    ownerDestroyed = true;
    child?.destroy?.();
  });

  let promise: Promise<T | null> | null = null;
  const load = (): Promise<T | null> =>
    (promise ??= loader().then((loaded) => {
      // Owner gone before the import settled (e.g. navigated away). A benign
      // race, not a bug: surface it in dev, but in prod never settle rather than
      // reject — `(await getter()).x` must not run downstream against a dead
      // scope, and resolving null would only turn that into a null-deref.
      if (ownerDestroyed) {
        if (isDevMode())
          throw new Error(
            `[mmstack/di]: injectAsync's target injector was destroyed before the dependency finished loading.`,
          );
        return new Promise<never>(() => undefined);
      }

      const token = maybeUnwrapDefaultExport(loaded) as ProviderToken<T>;

      const existing = target.get(token, NOT_FOUND as unknown as T, spatial);
      if (!Object.is(existing, NOT_FOUND)) return existing; // provided already — we don't own it

      if (typeof token === 'function') {
        // `Injector.create` returns a `DestroyableInjector` in v22; the cast keeps the file portable
        child = Injector.create({
          providers: [token as Type<T>],
          parent: target,
        }) as Injector & { destroy?(): void };
        return child.get(token);
      }

      if (optional) return null;

      throw new Error(
        `[mmstack/di]: injectAsync loaded an InjectionToken that has no provider. Provide it, load a class that can be auto-provided, or pass { optional: true }.`,
      );
    }));

  // Prefetch only eagerly, only in the browser, and only on a healthy
  // connection — an explicit `await getter()` always loads regardless.
  if (isBrowser && options?.prefetch !== undefined && !hasSlowConnection())
    void normalizePrefetch(options.prefetch)().then(load);

  return load;
}

function normalizePrefetch(prefetch: Prefetch): PrefetchTrigger {
  if (typeof prefetch === 'function') return prefetch;
  if (prefetch === 'idle') return onIdle;
  return () => onIdle({ timeout: prefetch });
}

// Cloned from `@mmstack/router-core`'s preload strategy: skip prefetching when
// the user is on a metered/slow connection or has data-saver enabled.
function hasSlowConnection(): boolean {
  const connection = (
    globalThis as {
      navigator?: {
        connection?: { effectiveType?: string; saveData?: boolean };
      };
    }
  ).navigator?.connection;

  if (!connection || typeof connection !== 'object') return false;
  if (connection.effectiveType?.endsWith('2g')) return true;
  return connection.saveData === true;
}

/**
 * A {@link PrefetchTrigger} that resolves when the browser is idle — a
 * dependency-free port of Angular v22's `onIdle`. Uses `requestIdleCallback`
 * when available, falling back to `setTimeout`. On the server (no idle/timer
 * API, or used outside the browser) it resolves immediately; combined with
 * `injectAsync`'s browser-only prefetch guard, prefetch is a no-op during SSR.
 *
 * Backs the `prefetch: 'idle'` and `prefetch: <number>` options of
 * {@link injectAsync}, so most callers never use it directly. Exported for
 * advanced use and tests; intentionally not part of the package's public API.
 *
 * @param options `timeout` forwarded to `requestIdleCallback` / used as the
 *   `setTimeout` delay.
 */
export function onIdle(options?: { timeout?: number }): Promise<void> {
  const g = globalThis as {
    requestIdleCallback?: (
      cb: () => void,
      opts?: { timeout?: number },
    ) => number;
    setTimeout?: (cb: () => void, ms?: number) => unknown;
  };

  const requestIdleCallback = g.requestIdleCallback;
  if (typeof requestIdleCallback === 'function')
    return new Promise<void>((resolve) =>
      requestIdleCallback(() => resolve(), options),
    );

  const setTimeout = g.setTimeout;
  if (typeof setTimeout === 'function')
    return new Promise<void>((resolve) =>
      setTimeout(() => resolve(), options?.timeout ?? 0),
    );

  return Promise.resolve();
}
