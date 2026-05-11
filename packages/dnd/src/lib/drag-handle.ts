import { Directive, ElementRef, inject } from '@angular/core';

@Directive({
  selector: '[mmDragHandle]',
  exportAs: 'mmDragHandle',
})
export class DragHandle {
  readonly elementRef = inject(ElementRef<HTMLElement>);
}
