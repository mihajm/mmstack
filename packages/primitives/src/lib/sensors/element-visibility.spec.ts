import { ElementRef, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { elementVisibility } from './element-visibility';

describe('elementVisibility', () => {
  let observeMock: any;
  let disconnectMock: any;

  beforeEach(() => {
    observeMock = vi.fn();
    disconnectMock = vi.fn();

    (globalThis as any).IntersectionObserver = class {
      constructor(public callback: IntersectionObserverCallback) {}
      observe = observeMock;
      unobserve = vi.fn();
      disconnect = disconnectMock;
    } as any;
  });

  afterEach(() => {
    delete (globalThis as any).IntersectionObserver;
  });

  it('should create observer and react to intersections', () => {
    TestBed.runInInjectionContext(() => {
      const el = document.createElement('div');
      const sig = elementVisibility(el);

      TestBed.tick();

      expect(observeMock).toHaveBeenCalledWith(el);
      expect(sig()?.isIntersecting).toBeUndefined(); // initial undefined state
      expect(sig.visible()).toBe(false);
    });
  });

  it('should support signal target resolution', () => {
    TestBed.runInInjectionContext(() => {
      const el = document.createElement('div');
      const targetSig = signal<ElementRef<Element> | null>(null);

      elementVisibility(targetSig);
      TestBed.tick();

      expect(observeMock).not.toHaveBeenCalled();

      targetSig.set(new ElementRef(el));
      TestBed.tick();

      expect(observeMock).toHaveBeenCalledWith(el);
    });
  });
});
