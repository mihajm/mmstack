import { isPlatformServer } from '@angular/common';
import {
  DestroyRef,
  Directive,
  ElementRef,
  inject,
  PLATFORM_ID,
  signal,
} from '@angular/core';
import { draggable } from '@atlaskit/pragmatic-drag-and-drop/element/adapter';

@Directive({
  selector: '[mmDraggable]',
  exportAs: 'mmDraggable',
})
export class Draggable {
  readonly dragging = signal(false);

  constructor() {
    if (isPlatformServer(inject(PLATFORM_ID))) return;
    const ref = inject(ElementRef);

    const cleanup = draggable({
      element: ref.nativeElement,
      onDragStart: () => this.dragging.set(true),
      onDrop: () => this.dragging.set(false),
    });

    inject(DestroyRef).onDestroy(cleanup);
  }
}
