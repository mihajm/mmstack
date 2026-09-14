import { TestBed } from '@angular/core/testing';
import { scrollPosition } from './scroll-position';
import { ElementRef, Injector, signal } from '@angular/core';

describe('scrollPosition', () => {
  let fakeScrollX = 0;
  let fakeScrollY = 0;

  beforeEach(() => {
    vi.useFakeTimers();
    fakeScrollX = 0;
    fakeScrollY = 0;
    Object.defineProperty(window, 'scrollX', { get: () => fakeScrollX, configurable: true });
    Object.defineProperty(window, 'scrollY', { get: () => fakeScrollY, configurable: true });
  });

  afterEach(() => {
    vi.useRealTimers();
    delete (window as any).scrollX;
    delete (window as any).scrollY;
  });

  it('should track window scroll with throttle delay', () => {
    TestBed.runInInjectionContext(() => {
      const scroll = scrollPosition({ throttle: 50 });
      
      expect(scroll()).toEqual({ x: 0, y: 0 });

      fakeScrollX = 100;
      fakeScrollY = 200;
      window.dispatchEvent(new Event('scroll'));

      expect(scroll.unthrottled()).toEqual({ x: 100, y: 200 });
      expect(scroll()).toEqual({ x: 0, y: 0 }); 

      vi.advanceTimersByTime(50);
      expect(scroll()).toEqual({ x: 100, y: 200 }); 
    });
  });

  it('should track element scroll', () => {
    TestBed.runInInjectionContext(() => {
      const el = document.createElement('div');
      Object.assign(el, { scrollLeft: 0, scrollTop: 0 });

      const scroll = scrollPosition({ target: new ElementRef(el), throttle: 0 });

      expect(scroll()).toEqual({ x: 0, y: 0 });

      Object.assign(el, { scrollLeft: 50, scrollTop: 150 });
      el.dispatchEvent(new Event('scroll'));

      vi.advanceTimersByTime(0);

      expect(scroll()).toEqual({ x: 50, y: 150 });
    });
  });

  it('should support creation outside an injection context via the injector option', () => {
    const injector = TestBed.inject(Injector);

    // no runInInjectionContext wrapper — would previously throw NG0203
    const scroll = scrollPosition({ injector, throttle: 0 });

    expect(scroll()).toEqual({ x: 0, y: 0 });

    fakeScrollX = 10;
    fakeScrollY = 20;
    window.dispatchEvent(new Event('scroll'));
    vi.advanceTimersByTime(0);

    expect(scroll()).toEqual({ x: 10, y: 20 });
  });

  it('should attach to a signal target once it resolves (viewChild pattern)', () => {
    TestBed.runInInjectionContext(() => {
      const el = document.createElement('div');
      Object.assign(el, { scrollLeft: 0, scrollTop: 0 });

      const target = signal<ElementRef<HTMLDivElement> | null>(null);
      const scroll = scrollPosition({ target, throttle: 0 });

      // element not resolved yet — nothing tracked
      expect(scroll()).toEqual({ x: 0, y: 0 });

      target.set(new ElementRef(el));
      TestBed.tick(); // run the attach effect

      Object.assign(el, { scrollLeft: 5, scrollTop: 15 });
      el.dispatchEvent(new Event('scroll'));
      vi.advanceTimersByTime(0);

      expect(scroll()).toEqual({ x: 5, y: 15 });
    });
  });
});
