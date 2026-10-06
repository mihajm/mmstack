import {
  computed,
  DestroyRef,
  Directive,
  effect,
  type EmbeddedViewRef,
  inject,
  Injector,
  input,
  type OnChanges,
  signal,
  type Signal,
  TemplateRef,
  untracked,
  ViewContainerRef,
} from '@angular/core';
import {
  type CensusError,
  type CensusMember,
  type CensusRegistry,
  getTransitionScope,
  isDone,
  memberId,
  ordinalOf,
  outcomeOf,
  type ResourceLike,
  type Result,
  settle,
  type UseSource,
} from '@mmstack/primitives/core';

/**
 * What `*mmOutcome` reads: a resource (an `@mmstack/resource` ref, an Angular `ResourceRef`) or a
 * `latest()` derivation. The directive reads its `outcome()` when it has one, else derives it.
 */
export type MmOutcomeSource<T> = ResourceLike & UseSource<T>;

export type MmOutcomeContext<T> = {
  /** The value. `undefined` when nothing was requested. */
  readonly $implicit: T | undefined;
  readonly mmOutcome: T | undefined;
};

export type MmOutcomeErrorContext = {
  /** The resource's error. */
  readonly $implicit: unknown;
  /** Reloads the resource, when it can reload. */
  readonly retry: (() => void) | undefined;
};

/** The read as a `Result`, or `null` for a `done` outcome: settled with nothing to render. */
type Shown = Result<unknown> | null;

const MEMBER_SITE = 'outcome-view';
const NEVER_PAUSED: Signal<boolean> = signal(false).asReadonly();

function readShown(src: MmOutcomeSource<unknown>): Shown {
  const out = src.outcome ? src.outcome() : outcomeOf(src)();
  return isDone(out) ? null : settle(out);
}

function messageOf(error: unknown): string | undefined {
  if (error instanceof Error) return error.message;
  const message = (error as { message?: unknown } | null | undefined)?.message;
  return typeof message === 'string' ? message : undefined;
}

function readerMember(
  src: MmOutcomeSource<unknown>,
  id: CensusMember['id'],
  displayName: string,
): CensusMember {
  const kind = computed(() => readShown(src)?.kind);
  const loading = computed(() => kind() === 'pending');
  return {
    id,
    displayName,
    readiness: true,
    paused: NEVER_PAUSED,
    pending: loading,
    inFlight: loading,
    failure: computed<CensusError | undefined>(() =>
      kind() === 'error'
        ? { id, displayName, message: messageOf(src.error?.()) }
        : undefined,
    ),
    retry: src.reload ? { retry: () => void src.reload?.() } : undefined,
    source: src,
    content: computed(() => src.hasContent?.() ?? src.hasValue()),
  };
}

/**
 * Renders its template with a resource's value, and makes the nearest boundary wait on that read.
 *
 * The input is the resource itself, not its value. While the outcome is a value the template
 * renders with it. While it is loading or failed, the template is removed, the optional `loading`
 * or `error` template renders instead, and the directive reports to the nearest boundary's census
 * as a member of its own: `pending` while loading (the boundary suspends), a failure while failed
 * (`retry` reloads the resource when it can). While the outcome is a value the member reports
 * nothing. A `done` outcome renders nothing and is not pending. The member leaves on destroy.
 *
 * A resource that is also registered in the same boundary is one incident there: one member in
 * the fold and one retry per round. Registered in an outer boundary and read under an inner one,
 * both boundaries hold.
 *
 * ```html
 * <mm-suspense>
 *   <p *mmOutcome="user; let u; error: failedTpl">{{ u?.name }}</p>
 *   <ng-template #failedTpl let-err let-retry="retry">
 *     Could not load. <button (click)="retry?.()">Retry</button>
 *   </ng-template>
 * </mm-suspense>
 * ```
 */
@Directive({
  selector: '[mmOutcome]',
})
export class MmOutcome<T> implements OnChanges {
  /** The resource (or `latest()`) to read. */
  readonly mmOutcome = input.required<MmOutcomeSource<T>>();
  /** Rendered while the outcome is loading. */
  readonly mmOutcomeLoading = input<TemplateRef<unknown> | null | undefined>();
  /** Rendered while the outcome is an error. */
  readonly mmOutcomeError = input<
    TemplateRef<MmOutcomeErrorContext> | null | undefined
  >();
  /** What the boundary calls this read when it fails. Defaults to `'resource'`. */
  readonly mmOutcomeName = input<string>('resource');

  private readonly tpl = inject(TemplateRef) as TemplateRef<
    MmOutcomeContext<T>
  >;
  private readonly vcr = inject(ViewContainerRef);
  private readonly census: CensusRegistry | null =
    getTransitionScope(inject(Injector))?.census ?? null;
  private readonly id = memberId(MEMBER_SITE, ordinalOf(this));
  private attached: MmOutcomeSource<T> | undefined;
  private leave: (() => void) | undefined;
  private shownTpl: TemplateRef<unknown> | null = null;
  private view: EmbeddedViewRef<Record<string, unknown>> | null = null;

  static ngTemplateContextGuard<T>(
    dir: MmOutcome<T>,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    ctx: unknown,
  ): ctx is MmOutcomeContext<T> {
    return true;
  }

  constructor() {
    inject(DestroyRef).onDestroy(() => {
      this.leave?.();
      this.leave = undefined;
    });
    effect(() => {
      const src = this.mmOutcome();
      const shown = readShown(src as MmOutcomeSource<unknown>);
      const loadingTpl = this.mmOutcomeLoading() ?? null;
      const errorTpl = this.mmOutcomeError() ?? null;
      untracked(() => this.render(src, shown, loadingTpl, errorTpl));
    });
  }

  // Joining the census here (not in an effect) puts the member in place during the declaring
  // view's update, before the boundary that reads the census renders.
  ngOnChanges(): void {
    const src = this.mmOutcome();
    if (src === this.attached) return;
    this.leave?.();
    this.leave = undefined;
    this.attached = src;
    if (this.census === null) return;
    this.leave = this.census.register(
      readerMember(
        src as MmOutcomeSource<unknown>,
        this.id,
        this.mmOutcomeName(),
      ),
    );
  }

  private render(
    src: MmOutcomeSource<T>,
    shown: Shown,
    loadingTpl: TemplateRef<unknown> | null,
    errorTpl: TemplateRef<MmOutcomeErrorContext> | null,
  ): void {
    if (shown === null) return this.show(null, {});
    switch (shown.kind) {
      case 'value':
        return this.show(this.tpl as TemplateRef<unknown>, {
          $implicit: shown.value,
          mmOutcome: shown.value,
        });
      case 'pending':
        return this.show(loadingTpl, {});
      case 'error':
        // The resource's own error, never the sentinel `settle` falls back to.
        return this.show(errorTpl as TemplateRef<unknown> | null, {
          $implicit: src.error?.(),
          retry: src.reload ? () => void src.reload?.() : undefined,
        });
    }
  }

  private show(
    tpl: TemplateRef<unknown> | null,
    context: Record<string, unknown>,
  ): void {
    if (tpl !== null && tpl === this.shownTpl && this.view) {
      Object.assign(this.view.context, context);
      this.view.markForCheck();
      return;
    }
    this.vcr.clear();
    this.view = null;
    this.shownTpl = tpl;
    if (tpl === null) return;
    this.view = this.vcr.createEmbeddedView(tpl, context) as EmbeddedViewRef<
      Record<string, unknown>
    >;
  }
}
