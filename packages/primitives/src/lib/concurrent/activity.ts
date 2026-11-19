import {
  computed,
  Directive,
  effect,
  type EmbeddedViewRef,
  inject,
  Injector,
  input,
  isDevMode,
  TemplateRef,
  untracked,
  ViewContainerRef,
} from '@angular/core';
import { isServer, providePaused } from '@mmstack/primitives/core';

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
 *
 * Hiding works on the template's root elements, so use one element as the root, as above. With an
 * `ng-container` root, its elements are hidden but text at the root stays visible; change detection
 * is paused for the whole subtree either way. In dev mode the directive warns once about text roots.
 */
@Directive({
  selector: '[mmActivity]',
})
export class MmActivity {
  private readonly tpl = inject(TemplateRef);
  private readonly vcr = inject(ViewContainerRef);
  private readonly parent = inject(Injector);
  private readonly onServer = isServer();

  /** When false, keep the content mounted but hidden + CD-detached. */
  readonly visible = input.required<boolean>({ alias: 'mmActivity' });

  /** Paused == not visible — handed to the kept subtree as PAUSED_CONTEXT. */
  private readonly paused = computed(() => !this.visible());

  private view: EmbeddedViewRef<unknown> | null = null;
  private warnedTextRoots = false;

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
    if (this.onServer) return;
    for (const node of this.view.rootNodes) {
      if (node instanceof HTMLElement || node instanceof SVGElement)
        node.style.display = visible ? '' : 'none';
    }
    if (!visible && isDevMode()) this.warnTextRoots(this.view);
    if (visible) this.view.reattach();
    else this.view.detach();
  }

  private warnTextRoots(view: EmbeddedViewRef<unknown>): void {
    if (this.warnedTextRoots) return;
    const text = view.rootNodes.some(
      (n: Node) => n.nodeType === Node.TEXT_NODE && !!n.textContent?.trim(),
    );
    if (!text) return;
    this.warnedTextRoots = true;
    console.warn(
      '*mmActivity: text at the template root stays visible while the content is hidden. Use one element as the template root.',
    );
  }
}
