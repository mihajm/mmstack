import { inject, InjectionToken, Provider } from '@angular/core';

/**
 * Title configuration interface.
 * Defines how createTitle should behave
 * @see {createTitle}
 */
export type TitleConfig = {
  /**
   * The base title to fallback to, by default Title.getTitle() is called on instantiation and that is used as a fallback,
   * which in most cases should resolve to what is in index.html, unless you specifically call Title.setTitle() before any routes,
   * are initialized.
   */
  initialTitle?: string;
  /**
   * Transforms every resolved title before it's applied. A string is treated as
   * a literal prefix (`'My App – '` → `'My App – Dashboard'`); a function
   * receives the resolved title and returns the final document title
   * (e.g. `` (title) => `${title} • My App` `` for a suffix).
   * @default '' (titles pass through unchanged)
   */
  prefix?: string | ((title: string) => string);
  /**
   * When `true` (default), navigating to a route without a registered title keeps
   * the previous title. When `false`, the title falls back to `initialTitle`
   * (or the `<title>` from `index.html`) instead.
   * @default true
   */
  keepLastKnownTitle?: boolean;
};

/**
 * @internal
 */
export type InternalTitleConfig = {
  initialTitle: string;
  parser: (title: string) => string;
  keepLastKnown: boolean;
};

const token = new InjectionToken<InternalTitleConfig>(
  '@mmstack/router-core:title-config',
);

/**
 * Provide application-wide configuration for the title subsystem. The config
 * is only consumed when at least one route uses a {@link createTitle} resolver;
 * routes without `createTitle` are unaffected.
 *
 * @param config Optional {@link TitleConfig}. All fields are optional — pass
 *   `prefix` to namespace titles (e.g. `"My App – "`), `initialTitle` to
 *   override the fallback (defaults to the `<title>` from `index.html`), and
 *   `keepLastKnownTitle: false` to clear the title on navigations to routes
 *   without a title (the default keeps the previous one).
 * @returns A `Provider` to add to your app's providers array.
 *
 * @example
 * ```ts
 * bootstrapApplication(AppComponent, {
 *   providers: [
 *     provideRouter(routes),
 *     provideTitleConfig({
 *       prefix: (title) => `${title} • My App`,
 *       keepLastKnownTitle: true,
 *     }),
 *   ],
 * });
 * ```
 */
export function provideTitleConfig(config?: TitleConfig): Provider {
  const prefix = config?.prefix ?? '';

  const prefixFn =
    typeof prefix === 'function'
      ? prefix
      : (title: string) => `${prefix}${title}`;

  return {
    provide: token,
    useValue: {
      initialTitle: config?.initialTitle ?? '',
      parser: prefixFn,
      keepLastKnown: config?.keepLastKnownTitle ?? true,
    } satisfies InternalTitleConfig,
  };
}

function identity(str: string) {
  return str;
}

export function injectTitleConfig(): InternalTitleConfig {
  return (
    inject(token, {
      optional: true,
    }) ?? {
      initialTitle: '',
      parser: identity,
      keepLastKnown: true,
    }
  );
}
