// inspired by SolidJS 2.0's Errored reset — https://github.com/solidjs/solid
import {
  ChangeDetectorRef,
  computed,
  DestroyRef,
  Directive,
  type EmbeddedViewRef,
  ErrorHandler,
  type ErrorDetails,
  inject,
  Injector,
  input,
  type OnInit,
  signal,
  type Signal,
  TemplateRef,
  type Type,
  untracked,
  ViewContainerRef,
} from '@angular/core';
import {
  type CensusError,
  elementView,
  getTransitionScope,
  isBrowser,
  memberId,
  renderedElements,
} from '@mmstack/primitives/core';

export type MmErroredRetryOptions = {
  /**
   * Destroy the faulted content and build it again from the template, with new instances. For
   * state that would fault in a loop. Defaults to `false`: render the kept content again.
   */
  readonly rebuild?: boolean;
};

export type MmErroredContext = {
  /** The error that put the boundary on its fallback. */
  readonly $implicit: Error;
  readonly error: Error;
  /**
   * Render the kept content again, or with `{ rebuild: true }` build it anew. A fault in that
   * render lands on the fallback again.
   */
  readonly retry: (options?: MmErroredRetryOptions) => void;
};

type WritableContext = {
  -readonly [K in keyof MmErroredContext]: MmErroredContext[K];
};

type Fault = {
  readonly error: Error;
  /** `update`: the view is kept and resumes on retry. `creation`: retry builds a new view. */
  readonly kind: 'update' | 'creation';
  /** The census name as it was when this fault was entered. */
  readonly displayName: string;
};

type Saved =
  | { readonly kind: 'element'; readonly display: string }
  | { readonly kind: 'text'; readonly data: string };

type StyledNode = Node & { style: CSSStyleDeclaration };

let ordinal = 0;

const OPTED_IN = new WeakMap<object, Set<ChangeDetectorRef>>();

/** Whether `node` sits under `root`, looking through shadow roots. */
const holds = (root: Node, node: Node): boolean => {
  for (
    let n: Node | null = node;
    n;
    n = n.parentNode ?? (n as ShadowRoot).host ?? null
  )
    if (n === root) return true;
  return false;
};

const NEVER = signal(false).asReadonly();

const asError = (e: unknown): Error =>
  e instanceof Error
    ? e
    : new Error(typeof e === 'string' ? e : 'Non-error thrown', { cause: e });

/**
 * An error boundary that keeps what it guards. The content renders from this directive's
 * template; when rendering it throws, the content view is kept (detached and hidden, so its
 * component instances and their state survive) and the fallback template bound to `mmErrored`
 * renders in its place with the error and a `retry` in context. `retry()` re-attaches the kept
 * view and renders it again with the same instances, so a form mid-edit keeps what the user typed.
 *
 * ```html
 * <form *mmErrored="failed; name: 'profile form'">...</form>
 * <ng-template #failed let-error let-retry="retry">
 *   <p>{{ error.message }} <button (click)="retry()">Retry</button></p>
 * </ng-template>
 * ```
 *
 * Angular's `@boundary` destroys its block on a throw and builds it again on `$reset()`. Use it for
 * stateless widgets; use this one when the subtree holds state worth keeping.
 *
 * Behaviour:
 *  - **Update-pass throw** (a binding, a lifecycle hook or a view effect during change detection,
 *    including the first pass after creation): the view is detached and its root nodes hidden.
 *    They are hidden, not left on screen, because the DOM is whatever the throwing pass had
 *    written up to the throw, a mix of new and old bindings. Element roots get `display: none`,
 *    text roots are blanked; both are restored when a retry renders clean.
 *  - **Creation throw** while the content itself is being built (a constructor, or an instruction
 *    that builds the DOM): Angular leaves no view to keep. The fallback shows and `retry()` builds
 *    the content anew, with new instances. Anything the partly built view registered outside
 *    itself before the throw is not cleaned up, as with `@boundary`.
 *  - **Retry** re-attaches and renders the kept view synchronously. A `computed` that cached the
 *    throw throws again until one of its dependencies changes, so a retry before the fix lands on
 *    the fallback again. The content stays hidden until a render completes without a throw.
 *    A retry renders the kept content again, OnPush components with nothing changed included,
 *    inside shadow roots and for elements moved elsewhere in the document too. Two kinds of
 *    component it does not reach by itself: one that detached itself from change detection, and
 *    a child its parent was given but does not project. Have such a component call
 *    `injectRenderOnRetry()`. Without that, a retry rebuilds when the unprojected child's own
 *    template threw, and leaves a detached component as it was. A retry also rebuilds off the
 *    browser, and when a template that threw was declared by a component that is neither under
 *    the content nor one the boundary sits in. Content rendered into another document, such as
 *    an iframe's, cannot be found, so a retry of it always rebuilds. Init hooks (`ngOnInit` and
 *    friends) that already ran, or started and threw, are not run again. A block (`@if`, `@for`,
 *    `@switch`) whose new branch threw while being built has already taken its new condition,
 *    so after a retry that branch stays empty until the condition changes again.
 *  - **Rebuild**: `retry({ rebuild: true })` destroys the faulted content view and builds it anew
 *    from the template, as `@boundary` does, so the state and the instances are new. Use the
 *    default retry for transient faults (a failed load, a value fixed since). Use a rebuild when
 *    the kept state itself is what throws and would fault again on every retry, and to recover a
 *    block left empty by the limit above. A creation throw always rebuilds.
 *  - **Reporting**: each caught throw goes to the `ErrorHandler` once, through `onViewError` when
 *    it has one, else `handleError`. Angular does not report errors a custom interceptor
 *    catches, so this directive does.
 *  - **Census**: inside a transition scope each fault registers a non-readiness member in the
 *    scope's census, so the scope's `errored()` lists it (its `retry` is this boundary's retry)
 *    and `failed()` stays false. The member leaves when a retry renders clean.
 *  - **Nesting**: the nearest boundary catches, so an inner `@boundary` or `*mmErrored` wins. A
 *    fallback that throws is caught by the next boundary out.
 *
 * Not caught: errors in event listeners, root effects, `afterRender` callbacks, promises and
 * `@defer` loads. A view effect that threw does not run again on retry until one of its
 * dependencies changes. On Angular before 22.2.4, a view effect that runs while its view is only
 * traversed (not refreshed) throws past this boundary, to the nearest ancestor boundary whose
 * view is refreshing in that pass.
 *
 * Inside `*mmTransition`, put the boundary in the branch template: a faulting incoming branch shows
 * its fallback and still commits.
 */
@Directive({
  selector: '[mmErrored]',
  exportAs: 'mmErrored',
})
export class MmErrored implements OnInit {
  private readonly tpl = inject(TemplateRef) as TemplateRef<unknown>;
  private readonly vcr = inject(ViewContainerRef);
  private readonly errorHandler = inject(ErrorHandler, { optional: true });
  private readonly injector = inject(Injector);
  private readonly census = getTransitionScope(this.injector)?.census ?? null;
  private readonly hostInstance = (
    inject(ChangeDetectorRef) as Partial<EmbeddedViewRef<unknown>>
  ).context;
  private readonly browser = isBrowser();

  /** Rendered while the content is faulted, with `MmErroredContext`. Without one, nothing shows. */
  readonly fallback = input<
    TemplateRef<MmErroredContext> | null | undefined | ''
  >(null, { alias: 'mmErrored' });

  /** What the census calls this boundary's failure. Defaults to `'view'`. */
  readonly name = input('view', { alias: 'mmErroredName' });

  // A retry that throws the same cached error again is the same fault: nothing it projects moves.
  private readonly fault = signal<Fault | null>(null, {
    equal: (a, b) =>
      a === b || (!!a && !!b && a.error === b.error && a.kind === b.kind),
  });
  /** The error currently shown by the fallback, or `undefined` while the content renders. */
  readonly error: Signal<Error | undefined> = computed(
    () => this.fault()?.error,
  );

  private readonly id = memberId('mmErrored', (ordinal += 1));
  private content: EmbeddedViewRef<unknown> | null = null;
  private fallbackView: EmbeddedViewRef<WritableContext> | null = null;
  private readonly hidden = new Map<Node, Saved>();
  private retrying = false;
  /** Set for the first fault of a retry, whose error replaces the one shown. */
  private adopting = false;
  /** Bumped by every fault, so a retry can tell whether its render threw. */
  private faults = 0;
  private destroyed = false;
  private leave: (() => void) | null = null;
  private readonly failure = computed<CensusError | undefined>(() => {
    const f = this.fault();
    return f
      ? { id: this.id, displayName: f.displayName, message: f.error.message }
      : undefined;
  });
  /** The components whose templates threw since the last retry. */
  private readonly faulted = new Set<unknown>();

  constructor() {
    inject(DestroyRef).onDestroy(() => {
      this.destroyed = true;
      this.leaveCensus();
    });
  }

  ngOnInit(): void {
    untracked(() => this.mount());
  }

  /**
   * Render the kept content again, or build it anew after a creation throw or when `rebuild` is
   * set. Does nothing while the content renders without a fault.
   */
  retry(options?: MmErroredRetryOptions): void {
    untracked(() => {
      const fault = this.fault();
      if (!fault || this.retrying || this.destroyed) return;
      this.retrying = true;
      this.adopting = true;
      const before = this.faults;
      try {
        const faulted = [...this.faulted];
        this.faulted.clear();
        if (options?.rebuild || !this.markContent(faulted))
          this.discardContent();
        if (fault.kind === 'creation' || !this.content) {
          if (!this.mount()) return;
        }
        const content = this.content;
        if (!content) return;
        this.unhide();
        content.reattach();
        content.markForCheck();
        try {
          content.detectChanges();
          // opted-in views render by themselves: nothing else reaches one that is detached
          for (const ref of OPTED_IN.get(this) ?? []) {
            if (this.faults !== before) break;
            ref.detectChanges();
          }
        } catch (e) {
          if (content === this.content && this.faults === before) {
            content.detach();
            this.hide(content);
          }
          throw e;
        }
      } finally {
        this.retrying = false;
        this.adopting = false;
      }
      if (this.faults === before) this.settle();
    });
  }

  /**
   * Marks every view found under the kept content for check, so the retry renders it again,
   * OnPush components with nothing changed included. False when that cannot be relied on: off
   * the browser, or when a template that threw belongs to a component that is neither found
   * under the content nor one of the components the boundary sits in.
   */
  private markContent(faulted: readonly unknown[]): boolean {
    const content = this.content;
    if (!content) return true;
    if (!this.browser) return false;
    const seen = new Set<unknown>([this.hostInstance]);
    for (const ref of OPTED_IN.get(this) ?? [])
      seen.add((ref as Partial<EmbeddedViewRef<unknown>>).context);
    for (const root of content.rootNodes as Node[]) {
      if (root.nodeType !== 1) continue;
      for (const el of [
        root as Element,
        ...renderedElements(root as Element),
      ]) {
        const view = elementView(el);
        if (!view) continue;
        seen.add(view.component);
        view.changeDetector.markForCheck();
      }
    }
    return faulted.every(
      (component) => seen.has(component) || this.sitsIn(component),
    );
  }

  /** A template declared above the content is rendered in it by a component that is not its declarer. */
  private sitsIn(component: unknown): boolean {
    const type = (component as object | null | undefined)?.constructor;
    return (
      !!type &&
      this.injector.get(type as Type<unknown>, null, { optional: true }) ===
        component
    );
  }

  private discardContent(): void {
    const content = this.content;
    this.content = null;
    this.faulted.clear();
    this.hidden.clear();
    if (!content) return;
    try {
      content.destroy();
    } catch (e) {
      this.report(asError(e), {
        declarationInstance: this.hostInstance,
        declarationType: this.hostType(),
      });
    }
  }

  private mount(): boolean {
    let view: EmbeddedViewRef<unknown> | null = null;
    try {
      view = this.vcr.createEmbeddedView(
        this.tpl,
        {},
        {
          index: 0,
          onError: (error, details) => this.onViewError(view, error, details),
        },
      );
    } catch (e) {
      const error = asError(e);
      this.report(error, {
        declarationInstance: this.hostInstance,
        declarationType: this.hostType(),
      });
      this.enterFault(error, 'creation');
      return false;
    }
    this.content = view;
    return true;
  }

  private onViewError(
    view: EmbeddedViewRef<unknown> | null,
    error: Error,
    details: ErrorDetails,
  ): void {
    untracked(() => {
      if (view !== this.content || this.destroyed) return;
      this.faulted.add(details.declarationInstance);
      this.report(error, details);
      this.enterFault(error, 'update');
    });
  }

  private enterFault(error: Error, kind: Fault['kind']): void {
    this.faults += 1;
    if (kind === 'update' && this.content) {
      this.content.detach();
      this.hide(this.content);
    }
    if (this.fault() === null || this.adopting)
      this.fault.set({ error, kind, displayName: untracked(this.name) });
    this.adopting = false;
    const shown = this.fault() as Fault;
    this.joinCensus();
    this.showFallback(shown.error);
  }

  private settle(): void {
    this.fallbackView?.destroy();
    this.fallbackView = null;
    this.fault.set(null);
    this.leaveCensus();
  }

  private showFallback(error: Error): void {
    const existing = this.fallbackView;
    if (existing) {
      existing.context.$implicit = error;
      existing.context.error = error;
      existing.markForCheck();
      return;
    }
    const tpl = untracked(this.fallback);
    if (!tpl) return;
    this.fallbackView = this.vcr.createEmbeddedView(
      tpl as TemplateRef<WritableContext>,
      {
        $implicit: error,
        error,
        retry: (options?: MmErroredRetryOptions) => this.retry(options),
      },
    );
  }

  private report(error: Error, details: ErrorDetails): void {
    const handler = this.errorHandler;
    if (!handler) return;
    const full: ErrorDetails = {
      ...details,
      boundary: { type: this.hostType(), reset: () => this.retry() },
    };
    if (handler.onViewError) handler.onViewError(error, full);
    else handler.handleError(error);
  }

  private hostType(): Type<unknown> {
    return (this.hostInstance as object | undefined)
      ?.constructor as Type<unknown>;
  }

  private hide(view: EmbeddedViewRef<unknown>): void {
    const roots = view.rootNodes as Node[];
    for (const node of [...roots, ...this.movedOut(roots)]) {
      if (this.hidden.has(node)) continue;
      if (node.nodeType === 1 && 'style' in node) {
        const el = node as StyledNode;
        this.hidden.set(node, { kind: 'element', display: el.style.display });
        el.style.display = 'none';
      } else if (node.nodeType === 3) {
        const text = node as Text;
        this.hidden.set(node, { kind: 'text', data: text.data });
        text.data = '';
      }
    }
  }

  /** Rendered elements that no longer sit under a root: the topmost of each moved subtree. */
  private movedOut(roots: readonly Node[]): Element[] {
    if (!this.browser) return [];
    const outside = new Set<Element>();
    for (const root of roots) {
      if (root.nodeType !== 1) continue;
      for (const el of renderedElements(root as Element))
        if (!roots.some((r) => holds(r, el))) outside.add(el);
    }
    return [...outside].filter(
      (el) => !el.parentElement || !outside.has(el.parentElement),
    );
  }

  private unhide(): void {
    for (const [node, saved] of this.hidden) {
      if (saved.kind === 'element')
        (node as StyledNode).style.display = saved.display;
      else (node as Text).data = saved.data;
    }
    this.hidden.clear();
  }

  private joinCensus(): void {
    if (this.leave || !this.census) return;
    this.leave = this.census.register({
      id: this.id,
      displayName: untracked(this.name),
      readiness: false,
      paused: NEVER,
      pending: NEVER,
      inFlight: NEVER,
      failure: this.failure,
      retry: { retry: () => this.retry() },
    });
  }

  private leaveCensus(): void {
    this.leave?.();
    this.leave = null;
  }
}

/**
 * Has the nearest `*mmErrored` above render this component again on every retry, by running its
 * change detection directly. The boundary finds the components under it through their elements
 * and marks them for check, which misses two kinds: a component that detached itself from change
 * detection, and a child its parent was given but does not project. Call this in those.
 *
 * Call it in an injection context, such as the component's constructor. Does nothing when there
 * is no `*mmErrored` above.
 */
export function injectRenderOnRetry(): void {
  const boundary = inject(MmErrored, { optional: true });
  if (!boundary) return;
  const ref = inject(ChangeDetectorRef);
  let refs = OPTED_IN.get(boundary);
  if (!refs) OPTED_IN.set(boundary, (refs = new Set()));
  refs.add(ref);
  inject(DestroyRef).onDestroy(() => refs.delete(ref));
}
