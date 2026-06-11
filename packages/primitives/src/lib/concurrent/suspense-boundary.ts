import { Component, computed, Directive, input } from '@angular/core';
import {
  injectTransitionScope,
  provideTransitionScope,
  type SuspendType,
} from './transition-scope';

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
 */
@Directive()
export abstract class SuspenseBoundaryBase {
  protected readonly scope = injectTransitionScope();

  /** What counts as "not ready" for the first-load placeholder. Defaults to value-presence. */
  readonly type = input<SuspendType>('value');

  protected readonly pending = this.scope.pending;
  protected readonly suspended = computed(() =>
    this.scope.suspended(this.type()),
  );
}

const SUSPENSE_TEMPLATE = `
  @if (suspended()) {
    <ng-content select="[placeholder]"><span>Loading…</span></ng-content>
  } @else {
    @if (pending()) {
      <ng-content select="[busy]" />
    }
    <ng-content />
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
  providers: [provideTransitionScope()],
})
export class SuspenseBoundary extends SuspenseBoundaryBase {}

/**
 * Unscoped suspense boundary — **reads the ambient scope** instead of providing one. For cases where
 * the resources to coordinate are registered *above* the boundary (e.g. an app-builder page whose
 * manifests/connectors register at a higher injector), so the boundary observes that outer scope
 * rather than opening a fresh one. Pair with a `provideTransitionScope()` (or another boundary) in an
 * ancestor.
 */
@Component({
  selector: 'mm-unscoped-suspense',
  template: SUSPENSE_TEMPLATE,
  host: SUSPENSE_HOST,
  styles: SUSPENSE_STYLES,
})
export class UnscopedSuspenseBoundary extends SuspenseBoundaryBase {}
