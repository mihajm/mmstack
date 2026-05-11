import { isPlatformServer } from '@angular/common';
import {
  booleanAttribute,
  Directive,
  effect,
  ElementRef,
  inject,
  input,
  PLATFORM_ID,
  signal,
} from '@angular/core';
import { dropTargetForElements } from '@atlaskit/pragmatic-drag-and-drop/element/adapter';

@Directive({
  selector: '[mmDropTarget]',
  exportAs: 'mmDropTarget',
})
export class DropTarget {
  readonly dropDisabled = input(false, {
    transform: booleanAttribute,
  });
  readonly isDragOver = signal(false);

  constructor() {
    if (isPlatformServer(inject(PLATFORM_ID))) return;
    const ref = inject(ElementRef);

    effect((registerCleanup) => {
      if (this.dropDisabled()) return;

      const cleanup = dropTargetForElements({
        element: ref.nativeElement,
        onDragEnter: () => this.isDragOver.set(true),
        onDragLeave: () => this.isDragOver.set(false),
        onDrop: () => this.isDragOver.set(false),
      });

      return registerCleanup(cleanup);
    });
  }
}
