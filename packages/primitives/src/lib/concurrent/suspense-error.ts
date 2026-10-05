import {
  Directive,
  effect,
  type EmbeddedViewRef,
  inject,
  TemplateRef,
  untracked,
  ViewContainerRef,
} from '@angular/core';
import {
  type ErroredEntry,
  injectTransitionScope,
  type RetryRound,
} from '@mmstack/primitives/core';

/**
 * Retries every failed member of the nearest transition scope on click, as one round
 * (`retryAll()`). A second click while the first round is still in flight dispatches nothing.
 *
 * ```html
 * <mm-suspense>
 *   <p error>Could not load. <button mmRetryFailed>Retry</button></p>
 *   ...
 * </mm-suspense>
 * ```
 */
@Directive({
  selector: '[mmRetryFailed]',
  host: { '(click)': 'retry()' },
})
export class MmRetryFailed {
  private readonly scope = injectTransitionScope();

  protected retry(): void {
    this.scope.retryAll();
  }
}

export type MmSuspenseErrorContext = {
  /** The presented failures (`scope.errored()`), never empty while the view exists. */
  readonly $implicit: readonly ErroredEntry[];
  /** Retry every failed member as one round. */
  readonly retry: () => RetryRound;
  /** Hide one failure until its member fails again (only members without a retry). */
  readonly dismiss: (entry: ErroredEntry) => void;
  /** Dismiss every dismissable failure. */
  readonly dismissAll: () => void;
};

type WritableContext = {
  -readonly [K in keyof MmSuspenseErrorContext]: MmSuspenseErrorContext[K];
};

/**
 * Renders its template while the nearest transition scope has presented failures, with the
 * entries and the scope's retry and dismiss as template context. Put it in a boundary's `[error]`
 * slot (nothing to show) or `[failed]` slot (content held).
 *
 * ```html
 * <ul error *mmSuspenseError="let entries; retry as retry; dismiss as dismiss">
 *   @for (e of entries; track e.member.id) {
 *     <li>{{ e.failure.displayName }}: {{ e.failure.message }}</li>
 *   }
 *   <button (click)="retry()">Retry</button>
 * </ul>
 * ```
 */
@Directive({
  selector: '[mmSuspenseError]',
})
export class MmSuspenseError {
  private readonly tpl = inject(
    TemplateRef,
  ) as TemplateRef<MmSuspenseErrorContext>;
  private readonly vcr = inject(ViewContainerRef);
  private readonly scope = injectTransitionScope();
  private view: EmbeddedViewRef<WritableContext> | null = null;

  static ngTemplateContextGuard(
    dir: MmSuspenseError,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    ctx: unknown,
  ): ctx is MmSuspenseErrorContext {
    return true;
  }

  constructor() {
    const scope = this.scope;
    effect(() => {
      const entries = scope.errored();
      untracked(() => {
        if (entries.length === 0) {
          this.vcr.clear();
          this.view = null;
          return;
        }
        if (this.view) {
          this.view.context.$implicit = entries;
          this.view.markForCheck();
          return;
        }
        this.view = this.vcr.createEmbeddedView(this.tpl, {
          $implicit: entries,
          retry: () => scope.retryAll(),
          dismiss: (entry) => scope.dismiss(entry),
          dismissAll: () => scope.dismissAll(),
        });
      });
    });
  }
}
