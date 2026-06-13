import { computed, isSignal, type Signal } from '@angular/core';
import {
  type ActivatedRouteSnapshot,
  createUrlTreeFromSnapshot,
  type IsActiveMatchOptions,
  type Router,
  UrlTree,
} from '@angular/router';

/**
 * Description of a single navigation item.
 *
 * Reactive fields accept either a static value or a zero-arg function — the function
 * form is wrapped in a `computed` so reading signals inside it produces a reactive value.
 *
 * @typeParam TMeta Arbitrary consumer-defined metadata round-tripped to {@link NavItem.meta}.
 *
 * @see createNavItems
 * @see NavItem
 */
export type CreateNavItem<TMeta = Record<string, unknown>> = {
  /** Visible text. */
  label: string | (() => string);
  /**
   * The navigation target. Resolved relative to the route the resolver is attached to —
   * the same convention as Angular's `routerLink`:
   *
   * - `'a'` / `'a/b'` / `['a', 'b']` — relative segments, resolve to `${mount}/a` etc.
   * - `'/foo'` / `['/foo', 'bar']` — absolute, leading-slash escape hatch.
   * - A pre-built `UrlTree` is passed through unchanged.
   *
   * Omit (or return `null`) for a pure grouping header — `active` will then fall through
   * to the children-active check.
   */
  link?: string | any[] | (() => string | any[] | null) | null;
  /** Accessible label. Defaults to `label`. */
  ariaLabel?: string | (() => string);
  /** When true, the item is rendered but non-interactive. Cascades to descendants. */
  disabled?: boolean | (() => boolean);
  /** When true, the item (and its subtree) is filtered out of the consumer-facing array. */
  hidden?: boolean | (() => boolean);
  /** Arbitrary metadata round-tripped on the resulting `NavItem`. */
  meta?: TMeta | (() => TMeta);
  /**
   * Override the match options used to compute `active`. Merged on top of the global default
   * from `provideNavConfig`, which is in turn merged on top of `@angular/router`'s
   * `subsetMatchOptions` defaults.
   *
   * Setting this also implicitly disables the default child-active OR — see
   * {@link matchesWhenChildActive} to opt back in.
   */
  activeMatch?: Partial<IsActiveMatchOptions>;
  /**
   * Controls whether `active` ORs with descendant `active`.
   *
   * Default: `true` when `activeMatch` is omitted, `false` when `activeMatch` is set.
   * Explicit values override the default.
   */
  matchesWhenChildActive?: boolean;
  /** Optional stable id. Defaults to the serialized link when present. */
  id?: string | (() => string);
  /** Nested items. */
  children?: CreateNavItem<TMeta>[];
};

/**
 * A navigation item exposed by `injectNavItems`. All fields are signals so consumers can
 * read reactively without caring whether the source was static or signal-derived.
 *
 * @typeParam TMeta Same as the corresponding {@link CreateNavItem}.
 */
export type NavItem<TMeta = Record<string, unknown>> = {
  id: Signal<string>;
  label: Signal<string>;
  ariaLabel: Signal<string>;
  /** Serialized URL, or `null` for pure grouping items with no link. */
  link: Signal<string | null>;
  active: Signal<boolean>;
  disabled: Signal<boolean>;
  meta: Signal<TMeta>;
  /** Children that survive the hidden filter. */
  children: Signal<NavItem<TMeta>[]>;
};

/** @internal */
export type InternalNavItem<TMeta = Record<string, unknown>> =
  NavItem<TMeta> & {
    hidden: Signal<boolean>;
  };

/** @internal */
export const NEVER_TRUE: Signal<boolean> = computed(() => false);

function wrap<T>(): Signal<T | undefined>;
function wrap<T>(value: T | (() => T)): Signal<T>;
function wrap<T>(
  value: T | (() => T) | undefined,
  fallback: Signal<T>,
): Signal<T>;

function wrap<T>(
  value?: T | (() => T) | undefined,
  fallback?: Signal<T>,
): Signal<T | undefined> {
  if (value === undefined)
    return fallback ? fallback : computed(() => undefined);
  if (typeof value === 'function')
    return isSignal(value) ? (value as Signal<T>) : computed(value as () => T);
  return computed(() => value);
}

function isAbsoluteCommandArray(commands: readonly unknown[]): boolean {
  return (
    commands.length > 0 &&
    typeof commands[0] === 'string' &&
    (commands[0] as string).startsWith('/')
  );
}

function resolveLinkTree(
  input: CreateNavItem['link'],
  router: Router,
  relativeTo: ActivatedRouteSnapshot,
): UrlTree | null {
  const raw = typeof input === 'function' ? input() : input;
  if (raw === undefined || raw === null) return null;
  if (raw instanceof UrlTree) return raw;

  if (typeof raw === 'string') {
    if (raw.startsWith('/')) return router.parseUrl(raw);
    const parsed = router.parseUrl('/' + raw);
    const primary = parsed.root.children['primary'];
    const segments = primary ? primary.segments.map((s) => s.path) : [];
    return createUrlTreeFromSnapshot(
      relativeTo,
      segments,
      parsed.queryParams,
      parsed.fragment,
    );
  }

  if (isAbsoluteCommandArray(raw)) return router.createUrlTree(raw);
  return createUrlTreeFromSnapshot(relativeTo, raw);
}

function resolveMeta<TMeta>(input: CreateNavItem<TMeta>['meta']): TMeta {
  if (input === undefined) return {} as TMeta;
  return typeof input === 'function' ? (input as () => TMeta)() : input;
}

/**
 * @internal
 * Recursively builds an {@link InternalNavItem} tree from {@link CreateNavItem} input.
 * Cascades parent `disabled`/`hidden` to descendants and computes `active` against the
 * current router URL using `Router.isActive`.
 */
export function createInternalNavItem<TMeta = Record<string, unknown>>(
  input: CreateNavItem<TMeta>,
  router: Router,
  relativeTo: ActivatedRouteSnapshot,
  configActiveMatch: Partial<IsActiveMatchOptions> | undefined,
  parentDisabled: Signal<boolean>,
  parentHidden: Signal<boolean>,
  fallbackId: string,
  trackNavigation: Signal<unknown>,
): InternalNavItem<TMeta> {
  const label = wrap(input.label);
  const ariaLabel = input.ariaLabel ? wrap(input.ariaLabel) : label;

  const linkTree = computed(() =>
    resolveLinkTree(input.link, router, relativeTo),
  );
  const link: Signal<string | null> = computed(() => {
    const tree = linkTree();
    return tree ? router.serializeUrl(tree) : null;
  });

  const ownDisabled = wrap(input.disabled, NEVER_TRUE);
  const ownHidden = wrap(input.hidden, NEVER_TRUE);

  const disabled = computed(() => parentDisabled() || ownDisabled());
  const hidden = computed(() => parentHidden() || ownHidden());

  const metaInput = input.meta;
  const meta: Signal<TMeta> = computed(() => resolveMeta<TMeta>(metaInput));

  const id: Signal<string> =
    input.id !== undefined
      ? wrap(input.id)
      : computed(() => link() ?? fallbackId);

  const childItems: InternalNavItem<TMeta>[] = (input.children ?? []).map(
    (childInput, i) =>
      createInternalNavItem<TMeta>(
        childInput,
        router,
        relativeTo,
        configActiveMatch,
        disabled,
        hidden,
        `${fallbackId}.${i}`,
        trackNavigation,
      ),
  );

  const children: Signal<NavItem<TMeta>[]> = computed(() =>
    childItems.filter((c) => !c.hidden()),
  );

  const mergedActiveMatch: Partial<IsActiveMatchOptions> = {
    ...configActiveMatch,
    ...input.activeMatch,
  };

  const finalOptions: IsActiveMatchOptions = {
    paths: 'subset',
    fragment: 'ignored',
    matrixParams: 'ignored',
    queryParams: 'subset',
    ...mergedActiveMatch,
  };

  const ownActive = computed(() => {
    trackNavigation();
    const tree = linkTree();
    return tree ? router.isActive(tree, finalOptions) : false;
  });

  const orWithChildren =
    input.matchesWhenChildActive ?? input.activeMatch === undefined;

  const active = computed(
    () =>
      ownActive() ||
      (orWithChildren &&
        !!childItems.length &&
        childItems.some((c) => c.active())),
  );

  return {
    id,
    label,
    ariaLabel,
    link,
    active,
    disabled,
    hidden,
    meta,
    children,
  };
}
