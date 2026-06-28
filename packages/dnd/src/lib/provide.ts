import {
  inject,
  InjectionToken,
  makeEnvironmentProviders,
  type EnvironmentProviders,
} from '@angular/core';
import type { Input } from '@atlaskit/pragmatic-drag-and-drop/types';

import type { Edge } from './internal/types';

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

/** Resolution order for any plugin/default: per-call override → DI default → `null`. */
export function resolveHitbox(override?: HitboxPlugin): HitboxPlugin | null {
  return override ?? injectDndConfig()?.plugins?.hitbox ?? null;
}

export function resolveAutoScroll(
  override?: AutoScrollPlugin,
): AutoScrollPlugin | null {
  return override ?? injectDndConfig()?.plugins?.autoScroll ?? null;
}

export function resolvePostMoveFlash(
  override?: PostMoveFlash,
): PostMoveFlash | null {
  return override ?? injectDndConfig()?.plugins?.postMoveFlash ?? null;
}

/** Resolves a registered announce plugin (option → DI → `null`). See `injectAnnounce`. */
export function resolveAnnounce(
  override?: AnnouncePlugin,
): AnnouncePlugin | null {
  return override ?? injectDndConfig()?.plugins?.announce ?? null;
}

export function missingPluginError(plugin: string, npmPackage: string): Error {
  return new Error(
    `[@mmstack/dnd] This feature needs the "${plugin}" plugin. Install \`${npmPackage}\` and register it via \`provideDnd({ plugins: { ${plugin}: ... } })\` (or pass it directly in the composable's options).`,
  );
}
