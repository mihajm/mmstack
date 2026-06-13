import {
  booleanAttribute,
  computed,
  DestroyRef,
  Directive,
  effect,
  ElementRef,
  HostListener,
  inject,
  InjectionToken,
  input,
  output,
  type Provider,
  untracked,
} from '@angular/core';
import {
  type ActivatedRoute,
  type Params,
  Router,
  RouterLink,
  RouterLinkWithHref,
  UrlTree,
} from '@angular/router';
import { elementVisibility } from '@mmstack/primitives';
import { PreloadRequester } from './preloading';

function inputToUrlTree(
  router: Router,
  link: string | any[] | UrlTree | null,
  relativeTo?: ActivatedRoute,
  queryParams?: Params,
  fragment?: string,
  queryParamsHandling?: 'merge' | 'preserve' | '',
  routerLinkUrlTree?: UrlTree | null,
): UrlTree | null {
  if (!link) return null;
  if (routerLinkUrlTree) return routerLinkUrlTree;

  if (link instanceof UrlTree) return link;

  const arr = Array.isArray(link) ? link : [link];

  return router.createUrlTree(arr, {
    relativeTo,
    queryParams,
    fragment,
    queryParamsHandling,
  });
}

function treeToSerializedUrl(
  router: Router,
  urlTree: UrlTree | null,
): string | null {
  if (!urlTree) return null;
  return router.serializeUrl(urlTree);
}

/**
 * Returns an imperative function that triggers preloading for an arbitrary link, using
 * the same path resolution and {@link PreloadStrategy} pipeline as the {@link Link}
 * (`mmLink`) directive.
 *
 * Use this when the `Link` directive isn't a fit — for example, preloading a route from
 * an effect when a user opens a menu, hovers a non-link element, or reacts to a signal
 * change — and you don't want to render an `<a [mmLink]>` just to request the preload.
 *
 * Requires {@link PreloadStrategy} to be wired up via `provideRouter(routes, withPreloading(PreloadStrategy))`,
 * just like the directive.
 *
 * @returns A function accepting the same link descriptor shape as `mmLink` (`string`,
 * commands array, `UrlTree`, or `null`). Passing `null` or an unresolvable link is a no-op.
 *
 * @example
 * ```typescript
 * @Component({ ... })
 * export class CommandPaletteComponent {
 *   private readonly triggerPreload = injectTriggerPreload();
 *
 *   protected readonly highlighted = signal<string | null>(null);
 *
 *   constructor() {
 *     effect(() => {
 *       const target = this.highlighted();
 *       if (target) this.triggerPreload(target);
 *     });
 *   }
 * }
 * ```
 */
export function injectTriggerPreload() {
  const req = inject(PreloadRequester);
  const router = inject(Router);

  return (
    link: string | any[] | UrlTree | null,
    relativeTo?: ActivatedRoute,
    queryParams?: Params,
    fragment?: string,
    queryParamsHandling?: 'merge' | 'preserve' | '',
  ) => {
    const urlTree = inputToUrlTree(
      router,
      link,
      relativeTo,
      queryParams,
      fragment,
      queryParamsHandling,
    );
    const fullPath = treeToSerializedUrl(router, urlTree);
    if (!fullPath) return;

    req.startPreload(fullPath);
  };
}

/**
 * Configuration for the `mmLink` directive.
 *
 * @see provideMMLinkDefaultConfig
 */
export type MMLinkConfig = {
  /**
   * The default preload behavior for links.
   * Can be 'hover', 'visible', or null (no preloading).
   * @default 'hover'
   */
  preloadOn: 'hover' | 'visible' | null;
  /**
   * Whether to use mouse down events for preloading.
   * @default false
   */
  useMouseDown: boolean;
};

const configToken = new InjectionToken<MMLinkConfig>('MMSTACK_LINK_CONFIG');

/**
 * Provide application-wide defaults for the `mmLink` directive. Each `[mmLink]`
 * instance can still override per-link via its own `preloadOn` / `useMouseDown`
 * inputs; this just shifts the default.
 *
 * @param config Partial override of `MMLinkConfig`. Unset keys fall back to:
 *   - `preloadOn: 'hover'` — preload triggered when the user hovers a link
 *   - `useMouseDown: false` — navigation triggered on click (not mousedown)
 * @returns A `Provider` to add to your app's providers array.
 *
 * @example
 * ```ts
 * bootstrapApplication(AppComponent, {
 *   providers: [
 *     provideMMLinkDefaultConfig({ preloadOn: 'visible', useMouseDown: true }),
 *   ],
 * });
 * ```
 */
export function provideMMLinkDefaultConfig(
  config: Partial<MMLinkConfig>,
): Provider {
  const cfg: MMLinkConfig = {
    preloadOn: 'hover',
    useMouseDown: false,
    ...config,
  };

  return {
    provide: configToken,
    useValue: cfg,
  };
}

function injectConfig() {
  const cfg = inject(configToken, { optional: true });
  return {
    preloadOn: 'hover' as const,
    useMouseDown: false,
    ...cfg,
  };
}

/**
 * Drop-in replacement for `[routerLink]` that adds preloading on hover or
 * visibility, optional mousedown-triggered navigation, and a `beforeNavigate`
 * hook. Composes with Angular's `RouterLink` via `hostDirectives`, so every
 * `RouterLink` input (`target`, `queryParams`, `fragment`, etc.) is forwarded.
 *
 * Preload behavior:
 * - `preloadOn: 'hover'` (default) — preload when the user hovers the link
 * - `preloadOn: 'visible'` — preload when the link scrolls into view
 * - `preloadOn: null` — disable preloading on this link
 *
 * Navigation timing:
 * - `useMouseDown: false` (default) — navigate on click
 * - `useMouseDown: true` — navigate on mousedown (shaves ~50ms but breaks if the user
 *   moves off the link before mouseup); the press's own click event is swallowed so
 *   the navigation runs exactly once
 *
 * `beforeNavigate` fires only for clicks that actually result in an SPA navigation —
 * modified/middle clicks and `target="_blank"` links are left to the browser.
 *
 * Requires {@link PreloadStrategy} to be wired via `provideRouter(routes, withComponentInputBinding(), withPreloading(PreloadStrategy))`.
 * Set app-wide defaults with {@link provideMMLinkDefaultConfig}.
 *
 * @example
 * ```html
 * <a [mmLink]="['/users', userId()]">View profile</a>
 *
 * <!-- Override per-link -->
 * <a [mmLink]="'/heavy-page'" preloadOn="visible" useMouseDown>Heavy page</a>
 *
 * <!-- React to the preload starting -->
 * <a [mmLink]="'/checkout'" (preloading)="onPreload()">Checkout</a>
 * ```
 */
@Directive({
  selector: '[mmLink]',
  exportAs: 'mmLink',
  host: {
    '(mouseenter)': 'onHover()',
  },
  hostDirectives: [
    {
      directive: RouterLink,
      // Every RouterLink input is forwarded so mmLink stays a drop-in replacement.
      // Parity is enforced by link.parity.spec.ts — if that test fails, Angular
      // changed RouterLink's inputs and this list (+ docs) needs updating.
      inputs: [
        'routerLink: mmLink',
        'target',
        'queryParams',
        'fragment',
        'queryParamsHandling',
        'preserveFragment',
        'state',
        'info',
        'relativeTo',
        'skipLocationChange',
        'replaceUrl',
      ],
    },
  ],
})
export class Link {
  private readonly routerLink =
    inject(RouterLink, {
      self: true,
      optional: true,
    }) ?? inject(RouterLinkWithHref, { self: true, optional: true });

  private readonly req = inject(PreloadRequester);
  private readonly router = inject(Router);
  private readonly el: HTMLElement = inject(ElementRef).nativeElement;

  readonly target = input<string>();
  readonly queryParams = input<Params>();
  readonly fragment = input<string>();
  readonly queryParamsHandling = input<'merge' | 'preserve' | ''>();
  readonly state = input<object>();
  readonly relativeTo = input<ActivatedRoute>();
  readonly skipLocationChange = input(false, { transform: booleanAttribute });
  readonly replaceUrl = input(false, { transform: booleanAttribute });
  readonly mmLink = input<string | any[] | UrlTree | null>(null);
  readonly preloadOn = input<'hover' | 'visible' | null>(
    injectConfig().preloadOn,
  );
  readonly useMouseDown = input(injectConfig().useMouseDown, {
    transform: booleanAttribute,
  });
  readonly beforeNavigate = input<() => void>();

  readonly preloading = output<void>();

  private readonly urlTree = computed(() => {
    return inputToUrlTree(
      this.router,
      this.mmLink(),
      this.relativeTo(),
      this.queryParams(),
      this.fragment(),
      this.queryParamsHandling(),
      this.routerLink?.urlTree,
    );
  });

  private readonly fullPath = computed(() => {
    return treeToSerializedUrl(this.router, this.urlTree());
  });

  /** Set after a mousedown-triggered navigation so the press's own click is swallowed. */
  private suppressNextClick = false;

  onHover() {
    if (untracked(this.preloadOn) !== 'hover') return;
    this.requestPreload();
  }

  @HostListener('mousedown', ['$event'])
  onMouseDown(event: MouseEvent) {
    if (!untracked(this.useMouseDown)) return;
    // modified/middle clicks (and target=_blank etc.) fall through to the browser's
    // default click handling — RouterLink's own listener applies the same gating
    if (!this.isSpaNavigation(event)) return;

    untracked(this.beforeNavigate)?.();
    this.routerLink?.onClick(
      event.button,
      event.ctrlKey,
      event.shiftKey,
      event.altKey,
      event.metaKey,
    );

    this.suppressNextClick = true;
    // safety: if the resulting click lands elsewhere (pointer dragged off the
    // element before mouseup), clear the flag so the next real click isn't eaten
    document.addEventListener('click', () => (this.suppressNextClick = false), {
      once: true,
    });
  }

  constructor() {
    const intersection = elementVisibility();

    effect(() => {
      if (this.preloadOn() !== 'visible') return;
      if (intersection.visible()) this.requestPreload();
    });

    // Capture-phase click listener — fires before RouterLink's own (bubble-phase)
    // host listener, which is what actually performs click navigation. We never
    // call `routerLink.onClick` from a click ourselves: doing so on top of
    // RouterLink's own listener used to navigate twice per click.
    const el = this.el;
    const onClickCapture = (event: MouseEvent) => {
      if (this.suppressNextClick) {
        this.suppressNextClick = false;
        // already navigated on mousedown — stop the anchor's default page load
        // AND RouterLink's bubble-phase listener (second SPA navigation)
        event.preventDefault();
        event.stopImmediatePropagation();
        return;
      }

      // RouterLink is about to handle this click — fire the hook only for real
      // SPA navigations (not modified/middle clicks or external targets)
      if (this.isSpaNavigation(event)) untracked(this.beforeNavigate)?.();
    };
    el.addEventListener('click', onClickCapture, { capture: true });
    inject(DestroyRef).onDestroy(() =>
      el.removeEventListener('click', onClickCapture, { capture: true }),
    );
  }

  private requestPreload() {
    const fp = untracked(this.fullPath);
    if (!this.routerLink || !fp) return;
    this.req.startPreload(fp);
    this.preloading.emit();
  }

  /**
   * Mirrors `RouterLink.onClick`'s decision: would this event result in an SPA
   * navigation (as opposed to no-op / browser default)?
   */
  private isSpaNavigation(event: MouseEvent): boolean {
    if (!untracked(this.urlTree)) return false;

    const tag = this.el.tagName;
    // RouterLink only applies the modifier/target gating to anchor-like hosts;
    // for other elements it navigates on any click
    if (tag !== 'A' && tag !== 'AREA') return true;

    if (
      event.button !== 0 ||
      event.ctrlKey ||
      event.shiftKey ||
      event.altKey ||
      event.metaKey
    )
      return false;

    const target = untracked(this.target);
    return !(typeof target === 'string' && target !== '_self');
  }
}
