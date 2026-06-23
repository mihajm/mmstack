import {
  afterNextRender,
  booleanAttribute,
  type ComponentRef,
  computed,
  DestroyRef,
  Directive,
  effect,
  type EmbeddedViewRef,
  EnvironmentInjector,
  inject,
  Injector,
  input,
  type ResourceRef,
  untracked,
  ViewContainerRef,
} from '@angular/core';
import { type ActivatedRoute, RouterOutlet } from '@angular/router';
import {
  type ForwardingTransitionScope,
  getTransitionScope,
  injectTransitionScope,
  provideForwardingTransitionScope,
} from '@mmstack/primitives';
import { RouterViewTransitions } from './view-transition';

/**
 * A `RouterOutlet` that turns navigation into a transition: the current route's view
 * stays mounted and visible while the incoming route mounts hidden and its resources
 * settle, then swaps in one frame — instead of flashing to a loading state.
 *
 * Provides its own transition scope, so the incoming route's connectors register HERE and
 * we can tell when it's ready. Drop-in for `<router-outlet>`.
 *
 * The base `RouterOutlet` bookkeeping is kept fully intact — `isActivated` /
 * `activatedRoute` always reflect the LIVE route, so `CanDeactivate` guards receive the
 * real component, `withComponentInputBinding()` keeps re-binding on param changes, and
 * custom `RouteReuseStrategy` detach/attach work normally. Only the *outgoing* view is
 * captured (via the public detach contract) and held on screen until the swap commits;
 * `deactivateEvents` fires when the held view is finally destroyed.
 *
 * The outgoing route is destroyed on swap — navigation respects "tree = f(URL)".
 *
 * An interrupting navigation mid-hold destroys the half-loaded (still hidden) incoming
 * view and RE-TARGETS the hold: the stable view stays visible until the interrupting
 * route settles.
 *
 * Set `data: { immediateTransition: true }` on a route to skip holding for it.
 *
 * The outlet provides a *forwarding* transition scope: per navigation it re-points at the
 * incoming route's own scope when the route opts in (via `provideRouteData`/
 * `provideTransitionScope()` in its `providers`), giving true per-view isolation — the
 * held view's resources live in the outgoing route's scope and can't delay the swap. Routes
 * that don't opt in share the outlet's own scope, where the swap is attributed to the
 * incoming view by snapshotting the outgoing refs.
 */
@Directive({
  // eslint-disable-next-line @angular-eslint/directive-selector
  selector: 'mm-transition-outlet',
  providers: [provideForwardingTransitionScope()],
})
export class TransitionRouterOutlet extends RouterOutlet {
  private readonly forwarder =
    injectTransitionScope() as ForwardingTransitionScope;
  private readonly transitionScope = this.forwarder;
  private readonly container = inject(ViewContainerRef);
  private readonly outletInjector = inject(Injector);
  /** Scope inherited from the outlet's own env injector — used to tell "route opted in" from "inherited". */
  private readonly inheritedScope = getTransitionScope(
    inject(EnvironmentInjector),
  );

  private readonly routerViewTransitions = inject(RouterViewTransitions);

  /**
   * Wrap the swap in the View Transitions API (`document.startViewTransition`) for an
   * animated cross-fade between the outgoing and incoming views. Feature-detected —
   * browsers without support (pre-Chrome 111 / Safari 18 / Firefox 139) fall back to the
   * instant swap.
   *
   * Tri-state: **unset** → follow the app's router-view-transitions setting (on when
   * `withViewTransitions(mmRouterViewTransitions())` is wired, off otherwise);
   * **`true`** → always animate; **`false`** → never animate (force a specific outlet
   * off even when router view transitions are enabled app-wide).
   *
   * So it "just works" alongside Angular's router view transitions — the outlet owns the
   * transition for held routes, Angular owns it for non-held ones — without needing the
   * attribute at all.
   */
  readonly viewTransition = input(undefined, {
    transform: (v: boolean | string | undefined) =>
      v === undefined ? undefined : booleanAttribute(v),
  });

  /** The captured outgoing view, kept visible until the incoming view settles. */
  private held: ComponentRef<unknown> | null = null;
  private releaseHeldGuard: (() => void) | null = null;
  /** Host nodes of the live (incoming) view while it is hidden during a hold. */
  private hiddenIncoming: HTMLElement[] | null = null;
  /** Environment injector of the CURRENT activation — becomes the held view's on capture. */
  private currentEnv: EnvironmentInjector | null = null;
  private sawPending = false;
  private armed = false;

  /** Resources held by the OUTGOING view, snapshotted at activation so the swap ignores them. */
  private outgoingRefs = new Set<ResourceRef<any>>();

  /** In-flight state of the INCOMING view only — what the swap waits on, so outgoing background work can't block it. */
  private readonly incomingPending = computed(() => {
    for (const ref of this.transitionScope.resources()) {
      if (this.outgoingRefs.has(ref)) continue;
      const s = ref.status();
      if (s === 'loading' || s === 'reloading') return true;
    }
    return false;
  });

  constructor() {
    super();
    // Swap once the incoming view's requests have gone in flight and then settled.
    effect(() => {
      const pending = this.incomingPending();
      untracked(() => {
        if (!this.armed) return;
        if (pending) this.sawPending = true;
        if (this.sawPending && !pending) this.commitSwap();
      });
    });
  }

  override activateWith(route: ActivatedRoute, env: EnvironmentInjector): void {
    const hadHeld = !!this.held;
    this.currentEnv = env;

    // Must run before super.activateWith so the incoming view's resources register into the right scope.
    const routeScope = getTransitionScope(env);
    const usingRouteScope =
      routeScope !== null && routeScope !== this.inheritedScope;
    this.forwarder.setTarget(usingRouteScope ? routeScope : null);

    // A per-route scope already isolates the incoming view; the shared scope needs the
    // outgoing refs snapshotted so the swap ignores them.
    this.outgoingRefs = usingRouteScope
      ? new Set()
      : new Set(untracked(this.transitionScope.resources));

    // base bookkeeping stays INTACT: isActivated/activatedRoute now reflect this route
    super.activateWith(route, env);

    if (!hadHeld || route.snapshot.data?.['immediateTransition'] === true) {
      this.dropHeld();
      this.resetArm();
      return;
    }

    this.routerViewTransitions.active?.skipTransition?.();
    this.hiddenIncoming = this.incomingRootNodes();
    this.setHidden(this.hiddenIncoming, true);
    this.arm();
  }

  override deactivate(): void {
    if (!this.isActivated) {
      super.deactivate();
      return;
    }

    if (this.held) {
      this.hiddenIncoming = null;
      this.resetArm();
      super.deactivate();
      this.scheduleOrphanCheck(this.held);
      return;
    }

    const env = this.currentEnv;
    const ref = super.detach();
    this.container.insert(ref.hostView);
    this.held = ref;
    this.guardHeldInjector(env, ref);
    this.scheduleOrphanCheck(ref);
  }

  /**
   * If a new activation follows a deactivation, it does so SYNCHRONOUSLY within the
   * same router activation pass (and arms the hold). If none arrives (e.g.
   * /parent/child → /parent, the outlet has no route in the new tree), the view is
   * simply gone — drop the hold.
   */
  private scheduleOrphanCheck(ref: ComponentRef<unknown>): void {
    queueMicrotask(() => {
      if (this.held === ref && !this.armed) {
        this.dropHeld();
      }
    });
  }

  override attach(ref: ComponentRef<unknown>, route: ActivatedRoute): void {
    // RouteReuseStrategy re-attachment: stored views reappear without a transition.
    this.dropHeld();
    this.resetArm();
    super.attach(ref, route);
  }

  override ngOnDestroy(): void {
    this.dropHeld();
    super.ngOnDestroy();
  }

  private arm(): void {
    this.armed = true;
    this.sawPending = untracked(this.incomingPending);
    // Fallback for an incoming route that loads nothing.
    afterNextRender(
      () => {
        if (
          this.armed &&
          !this.sawPending &&
          !untracked(this.incomingPending)
        ) {
          this.commitSwap();
        }
      },
      { injector: this.outletInjector },
    );
  }

  private resetArm(): void {
    this.armed = false;
    this.sawPending = false;
    this.outgoingRefs.clear();
  }

  private commitSwap(): void {
    if (!this.held) return;

    const useViewTransition =
      this.viewTransition() ?? this.routerViewTransitions.enabled;

    if (
      useViewTransition &&
      typeof document !== 'undefined' &&
      document.startViewTransition
    ) {
      document.startViewTransition(() => this.finishSwap());
    } else {
      this.finishSwap();
    }
  }

  /** The actual swap: destroy the held view, reveal the incoming one. Always instant. */
  private finishSwap(): void {
    this.dropHeld(); // drop the route we're leaving
    if (this.hiddenIncoming) {
      this.setHidden(this.hiddenIncoming, false);
      this.hiddenIncoming = null;
    }
    this.resetArm();
  }

  /**
   * Under `withExperimentalAutoCleanupInjectors` the outgoing route's environment
   * injector can be destroyed while we still display its view — commit immediately
   * instead of going zombie (route-provided services dead under a visible view).
   */
  private guardHeldInjector(
    env: EnvironmentInjector | null,
    ref: ComponentRef<unknown>,
  ): void {
    if (!env) return;
    try {
      const destroyRef = env.get(DestroyRef, null);
      if (!destroyRef) return;
      this.releaseHeldGuard = destroyRef.onDestroy(() => {
        this.releaseHeldGuard = null;
        if (this.held === ref) this.commitSwap();
      });
    } catch {
      // injector already destroyed — nothing to guard
    }
  }

  private dropHeld(): void {
    this.releaseHeldGuard?.();
    this.releaseHeldGuard = null;
    if (!this.held) return;
    const instance = this.held.instance;
    this.held.destroy();
    this.held = null;
    // the outgoing component is ACTUALLY gone now — notify like deactivate() would
    this.deactivateEvents.emit(instance);
  }

  /** Host nodes of the most recently created view in the container — the incoming one. */
  private incomingRootNodes(): HTMLElement[] {
    const view = this.container.get(this.container.length - 1);
    if (!view) return [];
    return ((view as EmbeddedViewRef<unknown>).rootNodes as Node[]).filter(
      (n): n is HTMLElement =>
        n instanceof HTMLElement ||
        (typeof SVGElement !== 'undefined' && n instanceof SVGElement),
    );
  }

  private setHidden(nodes: HTMLElement[], hidden: boolean): void {
    for (const el of nodes) {
      el.style.display = hidden ? 'none' : '';
    }
  }
}
