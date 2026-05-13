import { ElementRef } from '@angular/core';
import { TestBed } from '@angular/core/testing';

import { DragHandle } from './drag-handle';
import { resolveElement } from './internal';

describe('DragHandle directive', () => {
  it('captures its host element via ElementRef', () => {
    const host = document.createElement('span');
    TestBed.configureTestingModule({
      providers: [{ provide: ElementRef, useValue: new ElementRef(host) }],
    });
    const dir = TestBed.runInInjectionContext(() => new DragHandle());
    expect(dir.elementRef.nativeElement).toBe(host);
  });
});

describe('resolveElement', () => {
  it('returns undefined for undefined input', () => {
    expect(resolveElement(undefined)).toBeUndefined();
  });

  it('passes HTMLElement through', () => {
    const el = document.createElement('div');
    expect(resolveElement(el)).toBe(el);
  });

  it('unwraps ElementRef', () => {
    const el = document.createElement('div');
    expect(resolveElement(new ElementRef(el))).toBe(el);
  });

  it('unwraps DragHandle (structural)', () => {
    const el = document.createElement('div');
    const fake = { elementRef: new ElementRef(el) };
    expect(resolveElement(fake)).toBe(el);
  });
});
