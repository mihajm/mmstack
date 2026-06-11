import {
  afterNextRender,
  type ComponentRef,
  Directive,
  effect,
  type EnvironmentInjector,
  inject,
  Injector,
  untracked,
  ViewContainerRef,
} from '@angular/core';
import { type ActivatedRoute, RouterOutlet } from '@angular/router';
import {
  injectTransitionScope,
  provideTransitionScope,
} from '@mmstack/primitives';

/**
 * A `RouterOutlet` that turns navigation into a transition: the current route's view
 * stays mounted and visible while the incoming route mounts hidden and its resources
 * settle, then swaps in one frame — instead of flashing to a loading state.
 *
 * Provides its own transition scope, so the incoming route's connectors register HERE and
 * we can tell when it's ready. Drop-in for `<router-outlet>`
 *
 * The outgoing route is destroyed on swap — navigation respects "tree = f(URL)".
 *
 */
@Directive({
  // eslint-disable-next-line @angular-eslint/directive-selector
  selector: 'mm-transition-outlet',
  providers: [provideTransitionScope()],
})
export class TransitionRouterOutlet extends RouterOutlet {
  private readonly transitionScope = injectTransitionScope();
  private readonly container = inject(ViewContainerRef);
  private readonly injector = inject(Injector);

  private current: ComponentRef<unknown> | null = null;
  private incoming: ComponentRef<unknown> | null = null;
  private sawPending = false;
  private armed = false;

  constructor() {
    super();
    // Swap once the incoming's requests have gone in flight and then settled.
    effect(() => {
      const pending = this.transitionScope.pending();
      untracked(() => {
        if (!this.armed) return;
        if (pending) this.sawPending = true;
        if (this.sawPending && !pending) this.commitSwap();
      });
    });
  }

  override activateWith(route: ActivatedRoute, env: EnvironmentInjector): void {
    super.activateWith(route, env);

    const ref = super.detach();
    this.container.insert(ref.hostView);

    if (
      !this.current ||
      route.snapshot.data?.['immediateTransition'] === true
    ) {
      this.current?.destroy();
      this.disposeIncoming();
      this.current = ref;
      return;
    }

    // Transition: keep `current` on screen, hold the incoming hidden until it settles.
    this.disposeIncoming();
    this.incoming = ref;
    this.setHidden(ref, true);
    this.arm();
  }

  override deactivate(): void {
    if (!this.current && !this.incoming) super.deactivate();
  }

  override ngOnDestroy(): void {
    this.current?.destroy();
    this.current = null;
    this.disposeIncoming();
    super.ngOnDestroy();
  }

  private arm(): void {
    this.armed = true;
    this.sawPending = untracked(this.transitionScope.pending);
    // Fallback for an incoming route that loads nothing.
    afterNextRender(
      () => {
        if (
          this.armed &&
          !this.sawPending &&
          !untracked(this.transitionScope.pending)
        ) {
          this.commitSwap();
        }
      },
      { injector: this.injector },
    );
  }

  private commitSwap(): void {
    if (!this.incoming) return;
    this.current?.destroy(); // drop the route we're leaving
    this.current = this.incoming;
    this.incoming = null;
    this.setHidden(this.current, false);
    this.armed = false;
    this.sawPending = false;
  }

  private setHidden(ref: ComponentRef<unknown>, hidden: boolean): void {
    const el = ref.location.nativeElement as HTMLElement;
    el.style.display = hidden ? 'none' : '';
  }

  private disposeIncoming(): void {
    this.incoming?.destroy();
    this.incoming = null;
  }
}
