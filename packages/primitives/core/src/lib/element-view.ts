import {
  ChangeDetectorRef,
  type DebugElement,
  getDebugNode,
} from '@angular/core';

export type ElementView = {
  /**
   * The component hosted on the element, else the one whose view the element was rendered
   * into. For a template rendered by another component that is the renderer, not the declarer.
   */
  readonly component: unknown;
  /**
   * Marks the view the element belongs to. On a component's host element that is the
   * component's own view.
   */
  readonly changeDetector: ChangeDetectorRef;
};

/**
 * The Angular view behind a rendered element, in development and production builds alike.
 * `null` for an element Angular did not render, and wherever there is no DOM `Node` to inspect,
 * as on a server platform without one.
 */
export function elementView(el: Element): ElementView | null {
  if (typeof Node === 'undefined') return null;
  const debug = getDebugNode(el) as DebugElement | null;
  if (!debug) return null;
  const changeDetector = debug.injector.get(ChangeDetectorRef, null);
  return changeDetector
    ? { component: debug.componentInstance, changeDetector }
    : null;
}

/**
 * The elements under `root`, found by following Angular's templates as well as the DOM. So it
 * reaches inside the shadow roots of components, and still finds elements that were moved
 * elsewhere in the document after Angular rendered them. It also returns elements Angular did not
 * render that sit under a rendered one. Not found: the children a component was given but does
 * not project. `root` itself is not included. Empty wherever there is no DOM `Node` to inspect.
 *
 * The cost grows with the number of elements times their nesting depth.
 */
export function renderedElements(root: Element): Element[] {
  if (typeof Node === 'undefined') return [];
  const debug = getDebugNode(root) as DebugElement | null;
  if (!debug) return [];
  const found = new Set<Element>();
  debug.queryAll((el) => {
    found.add(el.nativeElement as Element);
    return false;
  });
  found.delete(root);
  return [...found];
}
