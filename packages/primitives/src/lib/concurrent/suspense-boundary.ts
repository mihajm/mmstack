import {
  type AfterViewInit,
  Component,
  computed,
  Directive,
  input,
} from '@angular/core';
import {
  injectRevealSlot,
  injectTransitionScope,
  provideTransitionScope,
  severReveal,
  type SuspendType,
} from '@mmstack/primitives/core';

/**
 * Shared **suspense** (readiness) boundary behaviour: reads the *nearest* transition scope and exposes
 * its `pending`/`suspended` state. This is the readiness gate — distinct from the hold-stale *swap*
 * primitives (`TransitionRouterOutlet`, `ab-transition`), which are the actual "transitions". The two
 * concrete components below differ only by whether they provide their own scope, so the logic (and
 * template) live here once.
 *
 *  - **First load** (`suspended()`): no value yet → show the `[placeholder]` fallback.
 *  - **Reload** (`pending()` but a value is held via `keepPrevious`): keep the real content mounted and
 *    surface a busy indicator (`aria-busy`, and an optional `[busy]` slot) instead of flashing back to
 *    the placeholder.
 *
 * `type` selects what "not ready" means: `'value'` (default) suspends only until a first value lands
 * then holds through reloads; `'loading'` suspends on every in-flight load (strict suspense).
 *
 * Failure, checked before suspense:
 *  - **Failed with nothing to show** (`scope.failed()`): the `[error]` slot replaces placeholder and
 *    content. Its default is one line of text.
 *  - **Failed with content held** (`scope.errored()` not empty): content stays, the optional
 *    `[failed]` slot renders beside it, and the host carries `data-failed`.
 *
 * Projected content cannot receive template context, so error content reaches the failures by DI:
 * anything inside the boundary that calls `injectTransitionScope()` gets this boundary's scope
 * (`errored()`, `retryAll()`, `dismiss()`). `mmRetryFailed` and `*mmSuspenseError` wrap that.
 *
 * Inside an `<mm-reveal>`, a boundary with no other boundary between it and the reveal is one of
 * its slots: while the reveal holds it back it shows its placeholder (or nothing when collapsed).
 * When the reveal has `[items]`, bind the boundary's row to `[item]` so it takes its place in the
 * data. Every boundary hides the reveal from its own content.
 *
 * SSR: the server serializes whatever the scope reports at stabilization, so a registered resource
 * must keep the app unstable until it settles or the placeholder is what gets serialized (then
 * flashes/mismatches on hydration). HttpClient-backed resources, httpResource & all of `@mmstack/resource`
 * do this automatically via the HTTP layer's `PendingTasks` + transfer cache. A custom loader (raw
 * `fetch`/promise/timer) must opt in itself: wrap it with `inject(PendingTasks).run(() => promise)`.
 */
@Directive()
export abstract class SuspenseBoundaryBase implements AfterViewInit {
  protected readonly scope = injectTransitionScope();

  /** What counts as "not ready" for the first-load placeholder. Defaults to value-presence. */
  readonly type = input<SuspendType>('value');
  /** The row this boundary shows, for a reveal ordered by `[items]`. Its key is the reveal's `track` of it. */
  readonly item = input<unknown>();

  protected readonly pending = this.scope.pending;
  protected readonly suspended = computed(() =>
    this.scope.suspended(this.type()),
  );
  protected readonly failed = this.scope.failed;
  protected readonly hasErrored = computed(
    () => this.scope.errored().length > 0,
  );

  private readonly revealSlot = injectRevealSlot(
    () => (this.failed() ? 'failed' : this.suspended() ? 'pending' : 'ready'),
    { item: () => this.item() },
  );
  protected readonly view = computed(() => {
    const slot = this.revealSlot;
    if (slot?.gated()) return slot.collapsed() ? 'none' : 'placeholder';
    if (this.failed()) return 'error';
    return this.suspended() ? 'placeholder' : 'content';
  });

  // by now the host's bindings and embedded views have run, so the state is real
  ngAfterViewInit(): void {
    this.revealSlot?.mount();
  }
}

const SUSPENSE_TEMPLATE = `
  @switch (view()) {
    @case ('error') {
      <ng-content select="[error]"><span>Failed to load.</span></ng-content>
    }
    @case ('placeholder') {
      <ng-content select="[placeholder]"><span>Loading…</span></ng-content>
    }
    @case ('content') {
      @if (pending()) {
        <ng-content select="[busy]" />
      }
      <ng-content />
      @if (hasErrored()) {
        <ng-content select="[failed]" />
      }
    }
  }
`;

// `display: contents` so the boundary adds no box of its own.
const SUSPENSE_STYLES = `
  :host {
    display: contents;
  }
`;

const SUSPENSE_HOST = {
  '[attr.aria-busy]': 'pending() ? true : null',
  '[attr.data-failed]': 'hasErrored() ? "" : null',
};

/**
 * Standalone suspense boundary — **provides its own scope**, so dropping a `<mm-suspense>` anywhere
 * just works: the resources created in its subtree register into it without any extra
 * `provideTransitionScope()`. The common case.
 */
@Component({
  selector: 'mm-suspense',
  template: SUSPENSE_TEMPLATE,
  host: SUSPENSE_HOST,
  styles: SUSPENSE_STYLES,
  providers: [provideTransitionScope(), severReveal()],
})
export class SuspenseBoundary extends SuspenseBoundaryBase {}

/**
 * Unscoped suspense boundary — **reads the ambient scope** instead of providing one. For cases where
 * the resources to coordinate are registered *above* the boundary so the boundary observes that outer scope
 * rather than opening a fresh one. Pair with a `provideTransitionScope()` (or another boundary) in an
 * ancestor.
 */
@Component({
  selector: 'mm-unscoped-suspense',
  template: SUSPENSE_TEMPLATE,
  host: SUSPENSE_HOST,
  styles: SUSPENSE_STYLES,
  providers: [severReveal()],
})
export class UnscopedSuspenseBoundary extends SuspenseBoundaryBase {}
