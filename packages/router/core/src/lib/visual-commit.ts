import { isPlatformBrowser } from '@angular/common';
import {
  afterNextRender,
  inject,
  Injectable,
  Injector,
  PLATFORM_ID,
  signal,
  type Signal,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import {
  type Event,
  EventType,
  NavigationCancellationCode,
  Router,
} from '@angular/router';

/**
 * Where a navigation is between "the router says it is done" and "the user can see it".
 *
 * `navigationId` is the navigation the status belongs to — the router's own
 * `NavigationStart.id`, so it can be correlated with router events.
 */
export type VisualCommitState = {
  readonly status: 'idle' | 'pending' | 'committed';
  readonly navigationId: number | null;
};

/**
 * Tracks when the navigation is visually committed — every {@link TransitionRouterOutlet} that
 * held or swapped for it has finished, so the screen finally shows the new route.
 *
 * Angular's `NavigationEnd` fires as soon as the router has activated the components, which under
 * a held transition is *before* anything changed on screen, and with several (or nested) outlets
 * there is no single moment `NavigationEnd` could stand in for. Read this instead when work has
 * to line up with what the user sees: scroll restoration, focus moves, announcements, analytics.
 *
 * - `pending` from `NavigationStart` until every outlet that armed for this navigation has
 *   committed (or swapped in immediately). A navigation where no outlet armed commits one render
 *   after `NavigationEnd`.
 * - `committed` once the swap is on screen.
 * - `idle` after a cancelled or failed navigation that no successor navigation follows and that
 *   left no swap outstanding.
 *
 * An interrupting navigation re-enters `pending` under its own id; outlets whose hold it
 * superseded re-arm under it. A navigation that dies without a successor while an earlier
 * navigation's hold is still on its way to the screen goes back to `pending` under that earlier
 * navigation and commits when it finally swaps — the status tracks outstanding visual work, not
 * the router's bookkeeping.
 *
 * @example
 * ```ts
 * private readonly commit = injectVisualCommit();
 *
 * constructor() {
 *   effect(() => {
 *     if (this.commit().status === 'committed') this.analytics.pageView();
 *   });
 * }
 * ```
 */
export function injectVisualCommit(): Signal<VisualCommitState> {
  return inject(VisualCommitCoordinator).state;
}

const IDLE: VisualCommitState = { status: 'idle', navigationId: null };

/**
 * @internal
 * The registry behind {@link injectVisualCommit}. Outlets arm when they activate and settle when
 * their swap reaches the screen; the coordinator owns the navigation-level view of that.
 */
@Injectable({ providedIn: 'root' })
export class VisualCommitCoordinator {
  private readonly injector = inject(Injector);
  /**
   * There is no visual commit off the browser: nothing paints, and `afterNextRender` never runs,
   * so on the server `NavigationEnd` IS the commit and outlet arms are ignored.
   */
  private readonly isBrowser = isPlatformBrowser(inject(PLATFORM_ID));
  private readonly current = signal<VisualCommitState>(IDLE);

  readonly state = this.current.asReadonly();

  /**
   * Outlets that owe a terminal swap, against the navigation they armed under. An arm outlives
   * the navigation that made it: a hold an interrupting navigation never touched is still
   * outstanding visual work, and the coordinator falls back to it if the interruption dies.
   */
  private readonly arms = new Map<object, number>();
  /** Navigations that reached `NavigationEnd` and can therefore still commit. */
  private readonly ended = new Set<number>();
  /** View roots that swapped in, against the navigation they swapped in for. */
  private roots: { navigationId: number; el: HTMLElement }[] = [];
  /** The roots of the navigation that last committed, snapshotted so later swaps can't blur it. */
  private committedRoots: HTMLElement[] = [];
  /** The navigation the state currently reflects. */
  private navigationId: number | null = null;

  constructor() {
    inject(Router)
      .events.pipe(takeUntilDestroyed())
      .subscribe((e: Event) => this.onEvent(e));
  }

  /** An outlet is activating for the current navigation and owes a terminal swap. */
  arm(outlet: object): void {
    if (!this.isBrowser || this.navigationId === null) return;
    this.arms.set(outlet, this.navigationId);
  }

  /**
   * The outlet's swap reached the screen (committed or immediate). `root` is the first root
   * element of the view that swapped in, if the outlet has one.
   */
  settle(outlet: object, root: HTMLElement | null = null): void {
    const armedFor = this.arms.get(outlet) ?? this.navigationId;
    if (root && armedFor !== null)
      this.roots.push({ navigationId: armedFor, el: root });
    this.drop(outlet);
  }

  /**
   * The outermost view root that swapped in for the navigation that committed — the region a
   * focus move or an announcement should be about. `null` when nothing swapped.
   */
  committedRoot(): HTMLElement | null {
    let outermost: HTMLElement | null = null;
    for (const root of this.committedRoots) {
      const contains =
        outermost !== null &&
        (root.compareDocumentPosition(outermost) &
          Node.DOCUMENT_POSITION_CONTAINED_BY) !==
          0;
      if (outermost === null || contains) outermost = root;
    }
    return outermost;
  }

  /** The outlet's arm ended without reaching the screen (superseded, or the outlet went away). */
  release(outlet: object): void {
    this.drop(outlet);
  }

  /**
   * Whether a navigation that already ended still owes a swap — visual work that is on its way to
   * the screen no matter what the navigation asking is about to do.
   */
  outstandingCommit(): boolean {
    return this.newestOutstanding() !== null;
  }

  private drop(outlet: object): void {
    const armedFor = this.arms.get(outlet);
    if (armedFor === undefined) return;
    this.arms.delete(outlet);
    this.commitIfSettled(armedFor);
  }

  private onEvent(e: Event): void {
    switch (e.type) {
      case EventType.NavigationStart:
        this.navigationId = e.id;
        this.prune();
        this.current.set({ status: 'pending', navigationId: e.id });
        break;
      case EventType.NavigationEnd:
        if (e.id !== this.navigationId) return;
        this.ended.add(e.id);
        if (!this.isBrowser) this.commitIfSettled(e.id);
        else if (this.outstanding(e.id) === 0) this.commitAfterRender(e.id);
        break;
      case EventType.NavigationCancel:
        // A redirect or a supersession is followed by another navigation that takes over.
        if (
          e.id !== this.navigationId ||
          e.code === NavigationCancellationCode.Redirect ||
          e.code === NavigationCancellationCode.SupersededByNewNavigation
        )
          return;
        this.terminated(e.id);
        break;
      case EventType.NavigationError:
        if (e.id === this.navigationId) this.terminated(e.id);
        break;
    }
  }

  /**
   * A navigation ended without a successor. That settles the coordinator only if nothing is
   * outstanding: an earlier navigation's hold that this one never took over is still on its way
   * to the screen, so the status falls back to it and commits when it finally swaps.
   */
  private terminated(id: number): void {
    this.forget(id);
    const fallback = this.newestOutstanding();
    if (fallback === null) {
      this.reset();
      return;
    }
    this.navigationId = fallback;
    this.prune();
    this.current.set({ status: 'pending', navigationId: fallback });
  }

  /** The most recent navigation that ended and still owes a swap. */
  private newestOutstanding(): number | null {
    let newest: number | null = null;
    for (const armedFor of this.arms.values()) {
      if (!this.ended.has(armedFor)) continue;
      if (newest === null || armedFor > newest) newest = armedFor;
    }
    return newest;
  }

  private outstanding(id: number): number {
    let count = 0;
    for (const armedFor of this.arms.values()) if (armedFor === id) count++;
    return count;
  }

  /** Nothing held, so the commit is simply the next render of the activated view. */
  private commitAfterRender(id: number): void {
    afterNextRender(() => this.commitIfSettled(id), {
      injector: this.injector,
    });
  }

  private commitIfSettled(id: number): void {
    // The status tracks one navigation at a time: an older arm that settles after a newer
    // navigation took over is a real swap for its outlet, but it must not walk the status back.
    if (
      id !== this.navigationId ||
      !this.ended.has(id) ||
      this.outstanding(id) > 0
    )
      return;
    this.committedRoots = this.roots
      .filter((r) => r.navigationId === id)
      .map((r) => r.el);
    this.current.set({ status: 'committed', navigationId: id });
  }

  /** Drop everything recorded for a navigation that can no longer commit. */
  private forget(id: number): void {
    this.ended.delete(id);
    this.roots = this.roots.filter((r) => r.navigationId !== id);
    for (const [outlet, armedFor] of this.arms)
      if (armedFor === id) this.arms.delete(outlet);
  }

  /** Keep only what the current navigation or an outstanding arm still refers to. */
  private prune(): void {
    const live = new Set(this.arms.values());
    if (this.navigationId !== null) live.add(this.navigationId);
    for (const id of this.ended) if (!live.has(id)) this.ended.delete(id);
    this.roots = this.roots.filter((r) => live.has(r.navigationId));
  }

  private reset(): void {
    this.arms.clear();
    this.ended.clear();
    this.roots = [];
    this.navigationId = null;
    this.current.set(IDLE);
  }
}
