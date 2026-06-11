import { isPlatformServer } from '@angular/common';
import {
  computed,
  Directive,
  effect,
  type EmbeddedViewRef,
  inject,
  InjectionToken,
  Injector,
  input,
  PLATFORM_ID,
  type Provider,
  signal,
  type Signal,
  TemplateRef,
  untracked,
  ViewContainerRef,
} from '@angular/core';

/**
 * Whether the subtree a resource/component lives in is currently PAUSED, for Activity / keep-alive.
 * Provided by an Activity boundary (`MmActivity`, or the app-builder's per-branch injector) and read
 * — only at instantiation — by anything that should pause its background work while paused (a resource
 * returning its `paused` token, a `<video>` pausing playback, the pausable primitives, …). Absent
 * unless an Activity boundary provides one — read it via `injectPaused()`, which falls back to a
 * never-paused signal, so code that isn't inside an Activity boundary is unaffected.
 */
export const PAUSED_CONTEXT = new InjectionToken<Signal<boolean>>(
  '@mmstack/primitives:paused-context',
);

/**
 * Keep-alive (the Angular analog of React's `<Activity>` / Vue's `<keep-alive>`): the wrapped
 * subtree is mounted ONCE and kept — when `[mmActivity]` is false it's hidden (`display:none`) and
 * its change detection is paused, preserving state (scroll, inputs, a video's position, loaded
 * data); when true it's shown and CD resumes. It is never destroyed until the directive is.
 *
 * It also provides {@link PAUSED_CONTEXT} to the content (= the negation of `visible`), so descendants
 * can pause *effect-driven* or *Observable* work while hidden (CD-detach alone pauses pull-based/template work, not
 * effects/polling). If you're using the pausable primitives this is done automatically
 *
 * ```html
 * <section *mmActivity="tab() === 'editor'"> ...heavy stateful editor... </section>
 * ```
 */
@Directive({
  selector: '[mmActivity]',
})
export class MmActivity {
  private readonly tpl = inject(TemplateRef);
  private readonly vcr = inject(ViewContainerRef);
  private readonly parent = inject(Injector);

  /** When false, keep the content mounted but hidden + CD-detached. */
  readonly visible = input.required<boolean>({ alias: 'mmActivity' });

  /** Paused == not visible — handed to the kept subtree as PAUSED_CONTEXT. */
  private readonly paused = computed(() => !this.visible());

  private view: EmbeddedViewRef<unknown> | null = null;

  constructor() {
    effect(() => {
      const visible = this.visible();
      untracked(() => this.apply(visible));
    });
  }

  private apply(visible: boolean): void {
    if (!this.view) {
      // Created once, kept for the directive's lifetime. The content gets PAUSED_CONTEXT = !visible,
      // so resources/components inside can pause their effect-driven work while hidden.
      this.view = this.vcr.createEmbeddedView(
        this.tpl,
        {},
        {
          injector: Injector.create({
            parent: this.parent,
            providers: [providePaused(this.paused)],
          }),
        },
      );
    }
    for (const node of this.view.rootNodes) {
      if (node instanceof HTMLElement)
        node.style.display = visible ? '' : 'none';
    }
    if (visible) this.view.reattach();
    else this.view.detach();
  }
}

// Shared never-paused signal returned outside a boundary / on the server (SSR renders the full tree,
// nothing is paused). Readonly so a consumer can't cast-and-`.set()` the shared default for everyone.
const NEVER_PAUSED: Signal<boolean> = signal(false).asReadonly();

/**
 * Inject the nearest paused-state signal — `true` while the surrounding subtree is paused (hidden by
 * an Activity boundary). Defaults to a never-paused signal, so callers outside an Activity are
 * unaffected; on the server it is always never-paused, so server-side work (e.g. connector fetches)
 * isn't suppressed. This is the public way to read pause state; the underlying token is intentionally
 * not exported.
 */
export function injectPaused(): Signal<boolean> {
  if (isPlatformServer(inject(PLATFORM_ID, { optional: true }) ?? 'browser'))
    return NEVER_PAUSED;
  return inject(PAUSED_CONTEXT, { optional: true }) ?? NEVER_PAUSED;
}

/**
 * Build a provider that supplies a paused-state signal to a subtree — the public way to set up an
 * Activity-style pause boundary (used by `MmActivity` and the app-builder's per-branch injectors).
 */
export function providePaused(source: Signal<boolean>): Provider {
  return { provide: PAUSED_CONTEXT, useValue: source };
}
