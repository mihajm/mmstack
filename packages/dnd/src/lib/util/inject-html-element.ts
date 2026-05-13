import { ElementRef, inject } from '@angular/core';

function assertHTMLElement(el: unknown): asserts el is HTMLElement {
  if (!(el instanceof HTMLElement))
    throw new Error(`Expected an HTMLElement, got ${el}`);
}

export function injectHTMLElement() {
  const ref = inject(ElementRef);
  assertHTMLElement(ref.nativeElement);
  return ref.nativeElement;
}
