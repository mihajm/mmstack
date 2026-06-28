import { isPlatformServer } from '@angular/common';
import {
  afterNextRender,
  DestroyRef,
  Directive,
  ElementRef,
  inject,
  Injector,
  PLATFORM_ID,
  runInInjectionContext,
} from '@angular/core';

import {
  missingPluginError,
  resolveAutoScroll,
  type AutoScrollPlugin,
} from '../provide';

export type AutoScrollOptions = {
  /** Defaults to the host element. */
  element?: HTMLElement | ElementRef<HTMLElement>;
  /** Override the registered auto-scroll plugin. */
  autoScroll?: AutoScrollPlugin;
  /** Injector to run in; defaults to the current injection context. */
  injector?: Injector;
  [key: string]: unknown;
};

/**
 * Enables auto-scrolling of a container while dragging near its edges. Requires
 * the auto-scroll plugin (install `@atlaskit/pragmatic-drag-and-drop-auto-scroll`
 * and register `autoScrollForElements` via {@link provideDnd}, or pass it here).
 *
 * @example
 * ```ts
 * // a scrollable list that auto-scrolls during a drag
 * @Component({ selector: 'app-list', host: { style: 'overflow:auto;max-height:300px' } })
 * export class ListComponent {
 *   constructor() { autoScroll(); } // scrolls the host element
 * }
 * // or in a template: <div mmAutoScroll style="overflow:auto">…</div>
 * ```
 */
export function autoScroll(opts: AutoScrollOptions = {}): void {
  const injector = opts.injector ?? inject(Injector);
  runInInjectionContext(injector, () => {
    if (isPlatformServer(inject(PLATFORM_ID))) return;

    const plugin = resolveAutoScroll(opts.autoScroll);
    if (!plugin)
      throw missingPluginError(
        'autoScroll',
        '@atlaskit/pragmatic-drag-and-drop-auto-scroll',
      );

    const host = inject<ElementRef<HTMLElement>>(ElementRef);
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { element, autoScroll: _ignored, injector: _inj, ...rest } = opts;
    const el =
      element instanceof ElementRef
        ? element.nativeElement
        : (element ?? host.nativeElement);

    const destroyRef = inject(DestroyRef);
    afterNextRender(
      () => {
        const cleanup = plugin({ element: el, ...rest });
        destroyRef.onDestroy(cleanup);
      },
      { injector },
    );
  });
}

/** Directive form of {@link autoScroll}: `<div mmAutoScroll style="overflow:auto">`. */
@Directive({
  selector: '[mmAutoScroll]',
  exportAs: 'mmAutoScroll',
})
export class AutoScroll {
  constructor() {
    autoScroll();
  }
}
