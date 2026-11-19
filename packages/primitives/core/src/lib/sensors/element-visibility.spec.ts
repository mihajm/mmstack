import {
  createEnvironmentInjector,
  ElementRef,
  EnvironmentInjector,
  PLATFORM_ID,
  signal,
} from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { elementVisibility } from './element-visibility';

type FakeIO = {
  callback: IntersectionObserverCallback;
  init?: IntersectionObserverInit;
  observed: Element[];
  disconnected: boolean;
};

type EntryInit = {
  target: Element;
  isIntersecting?: boolean;
  intersectionRatio?: number;
  top?: number;
  left?: number;
  width?: number;
  height?: number;
};

function entry(e: EntryInit): IntersectionObserverEntry {
  return {
    target: e.target,
    isIntersecting: e.isIntersecting ?? false,
    intersectionRatio: e.intersectionRatio ?? 0,
    boundingClientRect: {
      top: e.top ?? 0,
      left: e.left ?? 0,
      width: e.width ?? 10,
      height: e.height ?? 10,
    },
  } as unknown as IntersectionObserverEntry;
}

describe('elementVisibility', () => {
  const original = Object.getOwnPropertyDescriptor(
    globalThis,
    'IntersectionObserver',
  );
  let observers: FakeIO[];

  const live = () => observers.filter((o) => !o.disconnected);
  const deliver = (e: IntersectionObserverEntry) => {
    for (const o of live()) o.callback([e], {} as IntersectionObserver);
  };

  beforeEach(() => {
    observers = [];
    (globalThis as any).IntersectionObserver = class {
      private readonly rec: FakeIO;
      constructor(
        callback: IntersectionObserverCallback,
        init?: IntersectionObserverInit,
      ) {
        this.rec = { callback, init, observed: [], disconnected: false };
        observers.push(this.rec);
      }
      observe(el: Element) {
        this.rec.observed.push(el);
      }
      unobserve() {}
      disconnect() {
        this.rec.disconnected = true;
      }
    };
  });

  afterEach(() => {
    if (original)
      Object.defineProperty(globalThis, 'IntersectionObserver', original);
    else delete (globalThis as any).IntersectionObserver;
  });

  it('starts undefined and not visible, observing the target with the given init', () => {
    const el = document.createElement('div');
    const sig = TestBed.runInInjectionContext(() =>
      elementVisibility(el, { threshold: [0, 0.5] }),
    );
    TestBed.tick();
    expect(sig()).toBeUndefined();
    expect(sig.visible()).toBe(false);
    expect(live()).toHaveLength(1);
    expect(live()[0].observed).toEqual([el]);
    expect(live()[0].init?.threshold).toEqual([0, 0.5]);
  });

  it('surfaces each delivered entry and derives visible from it', () => {
    const el = document.createElement('div');
    const sig = TestBed.runInInjectionContext(() => elementVisibility(el));
    TestBed.tick();

    const shown = entry({
      target: el,
      isIntersecting: true,
      intersectionRatio: 1,
    });
    deliver(shown);
    expect(sig()).toBe(shown);
    expect(sig.visible()).toBe(true);

    const hidden = entry({ target: el });
    deliver(hidden);
    expect(sig()).toBe(hidden);
    expect(sig.visible()).toBe(false);
  });

  it.each<[string, Partial<EntryInit>]>([
    ['isIntersecting', { isIntersecting: true }],
    ['intersectionRatio', { intersectionRatio: 0.5 }],
    ['top', { top: 5 }],
    ['left', { left: 5 }],
    ['width', { width: 11 }],
    ['height', { height: 11 }],
  ])('keeps the latest entry when only %s changes', (_, change) => {
    const el = document.createElement('div');
    const sig = TestBed.runInInjectionContext(() => elementVisibility(el));
    TestBed.tick();
    deliver(entry({ target: el }));
    const next = entry({ target: el, ...change });
    deliver(next);
    expect(sig()).toBe(next);
  });

  it('keeps the latest entry when only the target changes', () => {
    const a = document.createElement('div');
    const b = document.createElement('div');
    const sig = TestBed.runInInjectionContext(() => elementVisibility(a));
    TestBed.tick();
    deliver(entry({ target: a }));
    const next = entry({ target: b });
    deliver(next);
    expect(sig()).toBe(next);
  });

  it('resets to undefined and disconnects when the target becomes null', () => {
    const el = document.createElement('div');
    const target = signal<ElementRef<Element> | null>(new ElementRef(el));
    const sig = TestBed.runInInjectionContext(() => elementVisibility(target));
    TestBed.tick();
    deliver(entry({ target: el, isIntersecting: true }));
    const [first] = observers;

    target.set(null);
    TestBed.tick();
    expect(sig()).toBeUndefined();
    expect(sig.visible()).toBe(false);
    expect(first.disconnected).toBe(true);
  });

  it("drops the old element's entry when the target swaps", () => {
    const a = document.createElement('div');
    const b = document.createElement('div');
    const target = signal<Element | null>(a);
    const sig = TestBed.runInInjectionContext(() => elementVisibility(target));
    TestBed.tick();
    deliver(entry({ target: a, isIntersecting: true }));
    expect(sig.visible()).toBe(true);

    target.set(b);
    TestBed.tick();
    expect(observers[0].disconnected).toBe(true);
    expect(live()[0].observed).toEqual([b]);
    expect(sig()).toBeUndefined();
    expect(sig.visible()).toBe(false);
  });

  it('disconnects on destroy', () => {
    const child = createEnvironmentInjector(
      [],
      TestBed.inject(EnvironmentInjector),
    );
    elementVisibility(document.createElement('div'), { injector: child });
    TestBed.tick();
    expect(live()).toHaveLength(1);
    child.destroy();
    expect(live()).toHaveLength(0);
  });

  it('is undefined and not visible without IntersectionObserver', () => {
    delete (globalThis as any).IntersectionObserver;
    const sig = TestBed.runInInjectionContext(() =>
      elementVisibility(document.createElement('div')),
    );
    expect(() => TestBed.tick()).not.toThrow();
    expect(sig()).toBeUndefined();
    expect(sig.visible()).toBe(false);
  });

  it('observes nothing on the server', () => {
    TestBed.configureTestingModule({
      providers: [{ provide: PLATFORM_ID, useValue: 'server' }],
    });
    const sig = TestBed.runInInjectionContext(() =>
      elementVisibility(document.createElement('div')),
    );
    TestBed.tick();
    expect(observers).toHaveLength(0);
    expect(sig()).toBeUndefined();
    expect(sig.visible()).toBe(false);
  });
});
