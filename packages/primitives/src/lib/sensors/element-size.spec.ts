import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { elementSize } from './element-size';

describe('elementSize', () => {
  let observeMock: any;
  let disconnectMock: any;

  beforeEach(() => {
    observeMock = vi.fn();
    disconnectMock = vi.fn();

    (globalThis as any).ResizeObserver = class {
      constructor(public callback: ResizeObserverCallback) {}
      observe = observeMock;
      unobserve = vi.fn();
      disconnect = disconnectMock;
    } as any;
  });

  afterEach(() => {
    delete (globalThis as any).ResizeObserver;
  });

  it('should create observer and get element size', () => {
    TestBed.runInInjectionContext(() => {
      const el = document.createElement('div');

      el.getBoundingClientRect = vi
        .fn()
        .mockReturnValue({
          width: 100,
          height: 200,
          top: 0,
          left: 0,
          bottom: 200,
          right: 100,
        });

      const sig = elementSize(el);
      TestBed.tick();

      expect(observeMock).toHaveBeenCalledWith(
        el,
        expect.objectContaining({ box: 'border-box' }),
      );
      expect(sig()).toEqual({ width: 100, height: 200 }); // initial value loaded properly
    });
  });

  it('should respond to signal changes for target', () => {
    TestBed.runInInjectionContext(() => {
      const el = document.createElement('div');
      el.getBoundingClientRect = vi
        .fn()
        .mockReturnValue({ width: 10, height: 10 });
      const targetSig = signal<Element | null>(null);

      const sig = elementSize(targetSig);
      TestBed.tick();

      expect(observeMock).not.toHaveBeenCalled();

      targetSig.set(el);
      TestBed.tick();

      expect(observeMock).toHaveBeenCalledWith(el, expect.any(Object));
      expect(sig()).toEqual({ width: 10, height: 10 });
    });
  });
});
