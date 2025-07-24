import { inject, InjectionToken, Provider } from '@angular/core';

/**
 * Title configuration interface.
 * Defines how createTitle should behave
 * @see {createTitle}
 */
export type TitleConfig = {
  /**
   * The title to be used when no title is set.
   * If not provided it defaults to an empty string
   * @default ''
   */
  prefix?: string | ((title: string) => string);
  /**
   * if false, the title will change to the url, otherwise default to true as that is standard behavior
   * @default true
   */
  keepLastKnownTitle?: boolean;
};

/**
 * @internal
 */
export type InternalTitleConfig = {
  parser: (title: string) => string;
  keepLastKnown: boolean;
};

const token = new InjectionToken<InternalTitleConfig>('MMSTACK_TITLE_CONFIG');

/**
 * used to provide the title configuration, will not be applied unless a `createTitle` resolver is used
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
      parser: prefixFn,
      keepLastKnown: config?.keepLastKnownTitle ?? true,
    },
  };
}

export function injectTitleConfig(): InternalTitleConfig {
  return inject(token);
}
