import { ElementRef } from '@angular/core';

import { resolveElement } from './resolve';

describe('resolveElement', () => {
  const el = document.createElement('div');

  it.each([
    ['an element', el],
    ['an ElementRef', new ElementRef(el)],
    ['an { elementRef } holder', { elementRef: new ElementRef(el) }],
  ])('resolves %s to the element', (_label, value) => {
    expect(resolveElement(value)).toBe(el);
  });

  it('resolves undefined to undefined', () => {
    expect(resolveElement(undefined)).toBeUndefined();
  });
});
