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
  untracked,
  ViewContainerRef,
} from '@angular/core';
import { type ActivatedRoute, RouterOutlet } from '@angular/router';
import {
  type ForwardingTransitionScope,
  getTransitionScope,
  injectTransitionScope,
  provideForwardingTransitionScope,
  type ResourceLike,
} from '@mmstack/primitives';
import { RouterViewTransitions } from './view-transition';

/**
 * A `RouterOutlet` that turns navigation into a transition: the current route's view
 * stays mounted and visible while the incoming route mounts hidden and its resources
 * settle, then swaps in one frame — instead of flashing to a loading state. Drop-in for
 * `<router-outlet>`.
 *
 * The base `RouterOutlet` bookkeeping stays fully intact — `isActivated` /
 * `activatedRoute` reflect the live route, so `CanDeactivate` guards, `withComponentInputBinding()`
 * and custom `RouteReuseStrategy` all work normally. The outgoing view is held on screen
 * until the swap commits; `deactivateEvents` fires when it is finally destroyed.
 *
 * An interrupting navigation mid-hold re-targets the hold: the stable view stays visible
 * until the interrupting route settles.
 *
 * Set `data: { immediateTransition: true }` on a route to skip holding for it.
 *
 * Provides a forwarding transition scope: per navigation it re-points at the incoming
 * route's own scope when the route opts in (via `provideRouteData`/`provideTransitionScope()`),
 * giving per-view isolation. Routes that don't opt in share the outlet's own scope, where the
 * swap ignores the snapshotted outgoing refs.
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
  /** Scope inherited from the outlet's env injector — distinguishes "route opted in". */
  private readonly inheritedScope = getTransitionScope(
    inject(EnvironmentInjector),
  );

  private readonly routerViewTransitions = inject(RouterViewTransitions);

  /**
   * Wrap the swap in the View Transitions API (`document.startViewTransition`) for an
   * animated cross-fade. Feature-detected; unsupported browsers fall back to an instant swap.
   *
   * Tri-state: **unset** → follow the app's router-view-transitions setting (on when
   * `withViewTransitions(mmRouterViewTransitions())` is wired, off otherwise);
   * **`true`** → always animate; **`false`** → never animate.
   */
  readonly viewTransition = input(undefined, {
    transform: (v: boolean | string | undefined) =>
      v === undefined ? undefined : booleanAttribute(v),
  });

  /** Captured outgoing view, kept visible until the incoming view settles. */
  private held: ComponentRef<unknown> | null = null;
  private releaseHeldGuard: (() => void) | null = null;
  private hiddenIncoming: HTMLElement[] | null = null;
  private currentEnv: EnvironmentInjector | null = null;
  private sawPending = false;
  private armed = false;

  /** Outgoing view's resources, snapshotted so the swap ignores them. */
  private outgoingRefs = new Set<ResourceLike>();

  /** In-flight state of the incoming view only. */
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

    // Must run before super.activateWith so incoming resources register into the right scope.
    const routeScope = getTransitionScope(env);
    const usingRouteScope =
      routeScope !== null && routeScope !== this.inheritedScope;
    this.forwarder.setTarget(usingRouteScope ? routeScope : null);

    this.outgoingRefs = usingRouteScope
      ? new Set()
      : new Set(untracked(this.transitionScope.resources));

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

  /** Drop the hold if no activation follows the deactivation in the same pass. */
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
    this.swapEpoch++;
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
    this.swapEpoch++;
    this.outgoingRefs.clear();
  }

  /** Bumped on re-target/reset so a deferred `startViewTransition` from a superseded swap can't fire. */
  private swapEpoch = 0;

  private commitSwap(): void {
    if (!this.held) return;

    const useViewTransition =
      this.viewTransition() ?? this.routerViewTransitions.enabled;

    if (
      useViewTransition &&
      typeof document !== 'undefined' &&
      document.startViewTransition
    ) {
      const epoch = this.swapEpoch;
      document.startViewTransition(() => this.finishSwap(epoch));
    } else {
      this.finishSwap(this.swapEpoch);
    }
  }

  private finishSwap(epoch: number): void {
    if (epoch !== this.swapEpoch) return; // superseded while deferred
    this.dropHeld();
    if (this.hiddenIncoming) {
      this.setHidden(this.hiddenIncoming, false);
      this.hiddenIncoming = null;
    }
    this.resetArm();
  }

  /** Commit immediately if the held view's env injector is destroyed under it. */
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
      // injector already destroyed
    }
  }

  private dropHeld(): void {
    this.releaseHeldGuard?.();
    this.releaseHeldGuard = null;
    if (!this.held) return;
    const instance = this.held.instance;
    this.held.destroy();
    this.held = null;
    this.deactivateEvents.emit(instance);
  }

  private incomingRootNodes(): HTMLElement[] {
    const view = this.container.get(this.container.length - 1);
    if (!view) return [];
    return ((view as EmbeddedViewRef<unknown>).rootNodes as Node[]).filter(
      (n): n is HTMLElement =>
        (typeof HTMLElement !== 'undefined' && n instanceof HTMLElement) ||
        (typeof SVGElement !== 'undefined' && n instanceof SVGElement),
    );
  }

  private setHidden(nodes: HTMLElement[], hidden: boolean): void {
    for (const el of nodes) {
      el.style.display = hidden ? 'none' : '';
    }
  }
}
