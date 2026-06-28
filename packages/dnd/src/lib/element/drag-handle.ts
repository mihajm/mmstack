import { Directive, ElementRef, inject } from '@angular/core';

/**
 * Restricts drag initiation to a specific child element. Capture it with a
 * template ref and pass it to a draggable's `dragHandle`:
 *
 * ```html
 * <li mmDraggable [data]="item" [dragHandle]="grip">
 *   <span mmDragHandle #grip="mmDragHandle">⋮⋮</span>
 * </li>
 * ```
 */
@Directive({
  selector: '[mmDragHandle]',
  exportAs: 'mmDragHandle',
})
export class DragHandle {
  /** The host element, passed to a draggable's `dragHandle` to scope drag initiation. */
  readonly elementRef = inject<ElementRef<HTMLElement>>(ElementRef);
}
