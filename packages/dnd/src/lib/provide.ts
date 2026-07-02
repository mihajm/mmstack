import {
  inject,
  InjectionToken,
  isDevMode,
  makeEnvironmentProviders,
  runInInjectionContext,
  type EnvironmentProviders,
  type Injector,
} from '@angular/core';
import type { Input } from '@atlaskit/pragmatic-drag-and-drop/types';

import type { Edge } from './internal/types';
import type { DragEngine } from './session';

/**
 * Optional sub-libraries are wired in *structurally* so core never imports the
 * `@atlaskit/*` sub-packages — they stay out of `peerDependencies` and live in
 * `optionalDependencies`. Install the one you want and plug its functions in,
 * either globally via {@link provideDnd} or per-composable via the matching
 * option (the option always wins).
 */
export type HitboxPlugin = {
  attachClosestEdge: (
    data: Record<string | symbol, unknown>,
    args: { element: Element; input: Input; allowedEdges: Edge[] },
  ) => Record<string | symbol, unknown>;
  extractClosestEdge: (data: Record<string | symbol, unknown>) => Edge | null;
};

/** e.g. `autoScrollForElements` from `@atlaskit/pragmatic-drag-and-drop-auto-scroll/element`. Returns a cleanup. */
export type AutoScrollPlugin = (args: {
  element: Element;
  [key: string]: unknown;
}) => () => void;

/** e.g. `triggerPostMoveFlash` from `@atlaskit/pragmatic-drag-and-drop-flourish`. */
export type PostMoveFlash = (el: HTMLElement) => void;

/**
 * Screen-reader announcer. Defaults to the built-in `DndAnnouncer`; swap in
 * `@atlaskit/pragmatic-drag-and-drop-live-region`'s `announce` or your own.
 */
export type AnnouncePlugin = (
  message: string,
  politeness?: 'polite' | 'assertive',
) => void;

export type DndPlugins = {
  hitbox?: HitboxPlugin;
  autoScroll?: AutoScrollPlugin;
  postMoveFlash?: PostMoveFlash;
  announce?: AnnouncePlugin;
};

export type DndConfig = {
  plugins?: DndPlugins;
};

export const DND_CONFIG = new InjectionToken<DndConfig>('@mmstack/dnd:config');

/**
 * Registers global DnD defaults — most importantly the optional sub-library
 * plugins (hitbox / auto-scroll / flourish / live-region announce). Entirely
 * optional: every composable also works with zero config, and per-call options
 * override whatever is registered here.
 *
 * @example
 * ```ts
 * import { attachClosestEdge, extractClosestEdge } from '@atlaskit/pragmatic-drag-and-drop-hitbox/closest-edge';
 * import { autoScrollForElements } from '@atlaskit/pragmatic-drag-and-drop-auto-scroll/element';
 *
 * bootstrapApplication(App, {
 *   providers: [
 *     provideDnd({
 *       plugins: {
 *         hitbox: { attachClosestEdge, extractClosestEdge }, // enables `edges`
 *         autoScroll: autoScrollForElements,
 *       },
 *     }),
 *   ],
 * });
 * ```
 */
export function provideDnd(
  config: DndConfig | (() => DndConfig) = {},
): EnvironmentProviders {
  return makeEnvironmentProviders([
    typeof config === 'function'
      ? { provide: DND_CONFIG, useFactory: config }
      : { provide: DND_CONFIG, useValue: config },
  ]);
}

/** Reads the DI config (or `null` if `provideDnd` was never called). Injection context only. */
export function injectDndConfig(): DndConfig | null {
  return inject(DND_CONFIG, { optional: true });
}

export type OverrideOption<T extends Required<DndPlugins>[keyof DndPlugins]> =
  | T
  | null
  | undefined;

const warnedPlugins = new Set<string>();

/** @internal Testing only */
export function ɵclearWarnedPlugins() {
  warnedPlugins.clear();
}

/**
 * Dev-only, warn-once notice that a requested feature has no plugin registered —
 * the caller then no-ops (graceful degradation, never a throw). Silent in prod.
 */
function warnMissingPlugin(plugin: string): void {
  if (!isDevMode() || warnedPlugins.has(plugin)) return;
  warnedPlugins.add(plugin);
  console.warn(
    `[@mmstack/dnd] The "${plugin}" feature needs a plugin, but none is registered — skipping (no-op). ` +
      `Install the matching pragmatic plugin or use @mmstack/dnd's built-in, then register it via ` +
      `\`provideDnd({ plugins: { ${plugin}: … } })\` (or the composable option).`,
  );
}

/**
 * Builds a memoized, injector-captured resolver for an optional plugin:
 * `resolveHitbox(injector, override)` returns a `() => plugin | null` getter
 * (per-call override → DI default → `null`) that can be called LATER, outside an
 * injection context (e.g. a during-drag callback) — the injector is captured, the
 * DI read runs through it once, then caches. On the first miss it warns once
 * (calling it signals the feature is required); pass `warn: false` for callers that
 * read a plugin opportunistically (`draggable`'s `.edge`) or have a built-in
 * fallback (`announce`).
 */
function createLazyResolver<
  TPlugin extends keyof Required<Required<DndPlugins>>,
>(
  plugin: TPlugin,
): (
  injector: Injector,
  override?: OverrideOption<Required<DndPlugins>[TPlugin]>,
  warn?: boolean,
) => () => Required<DndPlugins>[TPlugin] | null {
  return (injector, override, warn = true) => {
    let attempted = false;
    let resolved: Required<DndPlugins>[TPlugin] | null = null;

    return () => {
      if (!attempted) {
        resolved =
          override ??
          runInInjectionContext(
            injector,
            () =>
              (injectDndConfig()?.plugins?.[plugin] as
                | Required<DndPlugins>[TPlugin]
                | undefined) ?? null,
          );
        attempted = true;
        if (resolved == null && warn) warnMissingPlugin(plugin);
      }
      return resolved;
    };
  };
}

/**
 * Lazy, memoized plugin resolvers: `(injector, override?, warn = true) => () => plugin | null`.
 * The getter can be called outside an injection context; on the first miss it warns
 * (dev, once) — pass `warn: false` to stay silent (opportunistic reads / built-in fallback).
 */
export const resolveHitbox = createLazyResolver('hitbox');
export const resolveAutoScroll = createLazyResolver('autoScroll');
export const resolvePostMoveFlash = createLazyResolver('postMoveFlash');
export const resolveAnnounce = createLazyResolver('announce');

/* ── Option defaults (DI) ─────────────────────────────────────────────────
 * Each primitive resolves an option as `per-call ?? DI-default ?? built-in`.
 * DI defaults layer too: a per-primitive default inherits the common one
 * (e.g. `engine`) unless it sets that key itself. All defaults are partial. */

/** A provider + a matching reader for one defaults token — see {@link createDefaultsToken}. */
export type DefaultsToken<T extends object> = {
  /** Register defaults: a value, or a factory (run in an injection context). */
  provide: (defaults: T | (() => T)) => EnvironmentProviders;
  /**
   * Read the defaults, or `null` if none registered. Accepts an explicit injector
   * (uses `.get`) so it works outside an injection context; otherwise `inject`s.
   */
  inject: (injector?: Injector) => T | null;
};

/**
 * Builds a `provideX` / `injectX` pair over a private token (the token itself is
 * never exported). `inheritFrom` layers a broader defaults reader underneath, so
 * the resolved value is `{ ...inherited, ...own }` — own keys win, and either side
 * being absent still yields the other (or `null` when both are).
 */
export function createDefaultsToken<T extends object>(
  name: string,
  inheritFrom?: (injector?: Injector) => Partial<T> | null,
): DefaultsToken<T> {
  const TOKEN = new InjectionToken<T>(name);
  return {
    provide: (defaults) =>
      makeEnvironmentProviders([
        typeof defaults === 'function'
          ? { provide: TOKEN, useFactory: defaults }
          : { provide: TOKEN, useValue: defaults },
      ]),
    inject: (injector) => {
      const own = injector
        ? injector.get(TOKEN, null, { optional: true })
        : inject(TOKEN, { optional: true });
      const inherited = inheritFrom?.(injector) ?? null;
      return own || inherited ? ({ ...inherited, ...own } as T) : null;
    },
  };
}

/** Fill option keys the caller left `undefined` from `defaults` (per-call always wins). */
export function withDefaults<T extends object>(
  opts: T,
  defaults: Partial<T> | null | undefined,
): T {
  if (!defaults) return opts;
  const out: T = { ...opts };
  for (const key in defaults) {
    const value = defaults[key];
    if (out[key] === undefined && value !== undefined) out[key] = value as T[Extract<keyof T, string>];
  }
  return out;
}

/** Cross-primitive defaults — set once, inherited by draggable / dropTarget / reorderable. */
export type DndDefaults = {
  /** Default drag engine for every primitive unless a per-primitive default or per-call option overrides. */
  engine?: DragEngine;
};

const dndDefaults = createDefaultsToken<DndDefaults>('@mmstack/dnd:defaults');

/**
 * Register cross-primitive option defaults (currently `engine`). Inherited by
 * every primitive; a per-primitive `provideXDefaults` or a per-call option wins.
 *
 * @example provideDndDefaults({ engine: 'pointer' }) // every list/draggable goes pointer-mode
 */
export const provideDndDefaults = dndDefaults.provide;
/** Read the cross-primitive defaults (or `null`). @see {@link provideDndDefaults} */
export const injectDndDefaults = dndDefaults.inject;
