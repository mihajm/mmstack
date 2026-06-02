import { isPlatformServer } from '@angular/common';
import {
  computed,
  DestroyRef,
  effect,
  ElementRef,
  inject,
  isSignal,
  PLATFORM_ID,
  signal,
  type Signal,
} from '@angular/core';

type FocusWithinTarget =
  | ElementRef<Element>
  | Element
  | Signal<ElementRef<Element> | Element | null>;

function unwrap(target: ElementRef<Element> | Element | null): Element | null {
  if (!target) return null;
  return target instanceof ElementRef ? target.nativeElement : target;
}

/**
 * Creates a read-only signal that tracks whether the focused element is the
 * target or a descendant of it. Mirrors the CSS `:focus-within` pseudo-class.
 *
 * Defaults `target` to the current `ElementRef` so it can be used inline in a
 * component's `class` field. SSR-safe — returns a constant `false` signal on
 * the server.
 *
 * @example
 * ```ts
 * @Component({ ... })
 * class MenuComponent {
 *   // Defaults to the host element — flips true when focus is inside.
 *   readonly hasFocus = focusWithin();
 * }
 * ```
 */
export function focusWithin(
  target: FocusWithinTarget = inject(ElementRef),
): Signal<boolean> {
  if (isPlatformServer(inject(PLATFORM_ID))) {
    return computed(() => false, { debugName: 'focusWithin' });
  }

  const state = signal(false, { debugName: 'focusWithin' });

  const attach = (el: Element) => {
    state.set(el.contains(document.activeElement));

    const abortController = new AbortController();

    el.addEventListener('focusin', () => state.set(true), {
      signal: abortController.signal,
    });
    el.addEventListener(
      'focusout',
      () => {
        // Defer so `document.activeElement` reflects the focus move.
        queueMicrotask(() => state.set(el.contains(document.activeElement)));
      },
      { signal: abortController.signal },
    );

    return () => abortController.abort();
  };

  if (isSignal(target)) {
    const targetSig = target;
    effect((cleanup) => {
      const el = unwrap(targetSig());
      if (!el) {
        state.set(false);
        return;
      }
      cleanup(attach(el));
    });
  } else {
    const el = unwrap(target);
    if (el) {
      const detach = attach(el);
      inject(DestroyRef).onDestroy(detach);
    }
  }

  return state.asReadonly();
}
