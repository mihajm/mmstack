import { isPlatformServer } from '@angular/common';
import {
  afterNextRender,
  DestroyRef,
  Directive,
  effect,
  type EffectRef,
  type EmbeddedViewRef,
  inject,
  Injector,
  input,
  PLATFORM_ID,
  signal,
  type Signal,
  TemplateRef,
  untracked,
  ViewContainerRef,
} from '@angular/core';
import {
  getTransitionScope,
  provideTransitionScope,
  type TransitionScope,
} from './transition-scope';

export type MmTransitionContext<T> = {
  readonly $implicit: T;
  readonly mmTransition: T;
};

type Incoming<T> = {
  readonly view: EmbeddedViewRef<MmTransitionContext<T>>;
  readonly watcher: EffectRef;
};

/**
 * Generic hold-and-swap: the non-router `TransitionRouterOutlet`. When the bound value changes,
 * the OLD view stays mounted and visible (it keeps its old context value — that's the hold) while
 * the NEW view mounts hidden with its **own transition scope**; resources created in the incoming
 * subtree register into that scope just by existing, and once they've gone in flight and settled
 * the views swap in one frame. Tabs, wizard steps, master-detail — any branch change that would
 * otherwise flash a loading state.
 *
 * ```html
 * <div *mmTransition="selectedTab(); let tab">
 *   @switch (tab) { ... }
 * </div>
 * ```
 *
 * Distinct from `<mm-suspense>` (the readiness gate): suspense decides placeholder-vs-content
 * *within* one branch, but can't stop an `@switch` from unmounting the old branch the instant the
 * value flips. This directive is the swap itself — the old branch survives until the new one is
 * ready. Compose them freely: suspense inside a transitioned branch handles its first load.
 *
 * Semantics mirror the outlet: the first render is immediate (nothing to hold); an interrupting
 * value change mid-hold destroys the half-ready hidden view and re-targets; a branch that loads
 * nothing swaps right after its first render. Per-view scopes mean the outgoing branch's
 * background work can never delay the swap. Set `mmTransitionImmediate` to skip holding, and
 * `mmTransitionViewTransition` to wrap the swap in `document.startViewTransition` (feature
 * detected). On the server every change swaps immediately.
 */
@Directive({
  selector: '[mmTransition]',
  exportAs: 'mmTransition',
})
export class MmTransition<T> {
  private readonly tpl = inject(TemplateRef) as TemplateRef<
    MmTransitionContext<T>
  >;
  private readonly vcr = inject(ViewContainerRef);
  private readonly parent = inject(Injector);
  private readonly onServer = isPlatformServer(
    inject(PLATFORM_ID, { optional: true }) ?? 'browser',
  );

  /** The value whose changes are transitioned. Each view keeps the value it was created with. */
  readonly value = input.required<T>({ alias: 'mmTransition' });

  /** Skip holding entirely — every change swaps at once (the plain re-render behavior). */
  readonly immediate = input(false, { alias: 'mmTransitionImmediate' });

  /** Wrap the swap in the View Transitions API for an animated cross-fade (feature detected). */
  readonly viewTransition = input(false, {
    alias: 'mmTransitionViewTransition',
  });

  private current: EmbeddedViewRef<MmTransitionContext<T>> | null = null;
  private incoming: Incoming<T> | null = null;
  /** Bumped on every re-target/teardown so a superseded (possibly deferred) swap can't commit. */
  private swapEpoch = 0;

  private readonly holding = signal(false);
  /** True while an incoming view is mounted hidden, waiting to settle. */
  readonly pending: Signal<boolean> = this.holding.asReadonly();

  static ngTemplateContextGuard<T>(
    dir: MmTransition<T>,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    ctx: unknown,
  ): ctx is MmTransitionContext<T> {
    return true;
  }

  constructor() {
    effect(() => {
      const v = this.value();
      untracked(() => this.onValue(v));
    });
    inject(DestroyRef).onDestroy(() => {
      this.swapEpoch++; // a deferred view-transition callback must not touch destroyed state
      this.dropIncoming();
      // `current` is destroyed with the container
    });
  }

  private onValue(v: T): void {
    if (!this.current) {
      // first render: nothing to hold yet — show immediately (also what SSR serializes)
      this.current = this.createView(v).view;
      return;
    }

    this.dropIncoming(); // an interrupting change supersedes the previous hold
    this.swapEpoch++;
    const epoch = this.swapEpoch;

    if (this.onServer || this.immediate()) {
      this.finishSwap(epoch, this.createView(v).view);
      return;
    }

    const { view, scope } = this.createView(v);
    this.setHidden(view, true);
    this.holding.set(true);

    // Registration happens synchronously during view creation, so a resource already in
    // flight counts from the start; later kickoffs are caught by the watcher.
    let sawPending = untracked(scope.pending);

    const watcher = effect(
      () => {
        const pending = scope.pending();
        untracked(() => {
          if (epoch !== this.swapEpoch) return;
          if (pending) sawPending = true;
          if (sawPending && !pending) this.commitSwap(epoch, view);
        });
      },
      { injector: this.parent },
    );
    this.incoming = { view, watcher };

    // Fallback for a branch that loads nothing.
    afterNextRender(
      () => {
        if (
          epoch === this.swapEpoch &&
          !sawPending &&
          !untracked(scope.pending)
        ) {
          this.commitSwap(epoch, view);
        }
      },
      { injector: this.parent },
    );
  }

  private commitSwap(
    epoch: number,
    view: EmbeddedViewRef<MmTransitionContext<T>>,
  ): void {
    if (epoch !== this.swapEpoch) return;
    if (
      this.viewTransition() &&
      typeof document !== 'undefined' &&
      document.startViewTransition
    ) {
      // the browser snapshots the old frame first; the epoch guard covers the deferral
      document.startViewTransition(() => this.finishSwap(epoch, view));
    } else {
      this.finishSwap(epoch, view);
    }
  }

  /** The actual swap: destroy the old view, reveal the new one. Always instant. */
  private finishSwap(
    epoch: number,
    view: EmbeddedViewRef<MmTransitionContext<T>>,
  ): void {
    if (epoch !== this.swapEpoch) return; // superseded while deferred — not ours to commit
    this.swapEpoch++; // consume: the watcher and the render fallback can both fire, one commits
    this.current?.destroy();
    this.setHidden(view, false);
    this.current = view;
    this.incoming?.watcher.destroy();
    this.incoming = null;
    this.holding.set(false);
  }

  private dropIncoming(): void {
    if (!this.incoming) return;
    this.incoming.watcher.destroy();
    this.incoming.view.destroy();
    this.incoming = null;
    this.holding.set(false);
  }

  private createView(v: T): {
    view: EmbeddedViewRef<MmTransitionContext<T>>;
    scope: TransitionScope;
  } {
    // Each view gets its own scope, so its subtree's resources register here by existing —
    // and the outgoing view's background work can't block the swap (per-view isolation).
    const injector = Injector.create({
      parent: this.parent,
      providers: [provideTransitionScope()],
    });
    const scope = getTransitionScope(injector) as TransitionScope;
    const view = this.vcr.createEmbeddedView(
      this.tpl,
      { $implicit: v, mmTransition: v },
      { injector },
    );
    return { view, scope };
  }

  private setHidden(view: EmbeddedViewRef<unknown>, hidden: boolean): void {
    for (const node of view.rootNodes) {
      // covers HTML and SVG roots; text/comment roots can't be styled — prefer an element root
      if (node instanceof HTMLElement || node instanceof SVGElement)
        node.style.display = hidden ? 'none' : '';
    }
  }
}
