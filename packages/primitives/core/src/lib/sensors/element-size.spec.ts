import {
  createEnvironmentInjector,
  ElementRef,
  EnvironmentInjector,
  PLATFORM_ID,
  signal,
} from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { elementSize } from './element-size';

type FakeRO = {
  callback: ResizeObserverCallback;
  observed: [Element, ResizeObserverOptions | undefined][];
  disconnected: boolean;
};

type Size = [inline: number, block: number];

function entry(
  sizes: {
    border?: Size;
    content?: Size;
    device?: Size;
    rect?: [width: number, height: number];
  },
  target: Element = document.body,
): ResizeObserverEntry {
  const box = (s?: Size) =>
    s ? [{ inlineSize: s[0], blockSize: s[1] }] : undefined;
  return {
    target,
    borderBoxSize: box(sizes.border),
    contentBoxSize: box(sizes.content),
    devicePixelContentBoxSize: box(sizes.device),
    contentRect: { width: sizes.rect?.[0] ?? 0, height: sizes.rect?.[1] ?? 0 },
  } as unknown as ResizeObserverEntry;
}

function box(width: number, height: number) {
  const el = document.createElement('div');
  el.getBoundingClientRect = () =>
    ({
      width,
      height,
      top: 0,
      left: 0,
      right: width,
      bottom: height,
    }) as DOMRect;
  document.body.appendChild(el);
  return el;
}

const ALL = { border: [130, 60], content: [100, 30], rect: [90, 20] } as {
  border: Size;
  content: Size;
  rect: [number, number];
};

describe('elementSize', () => {
  const original = Object.getOwnPropertyDescriptor(
    globalThis,
    'ResizeObserver',
  );
  let observers: FakeRO[];

  const live = () => observers.filter((o) => !o.disconnected);
  const resize = (e: ResizeObserverEntry) => {
    for (const o of live()) o.callback([e], {} as ResizeObserver);
  };

  beforeEach(() => {
    observers = [];
    (globalThis as any).ResizeObserver = class {
      private readonly rec: FakeRO;
      constructor(callback: ResizeObserverCallback) {
        this.rec = { callback, observed: [], disconnected: false };
        observers.push(this.rec);
      }
      observe(el: Element, opt?: ResizeObserverOptions) {
        this.rec.observed.push([el, opt]);
      }
      unobserve() {}
      disconnect() {
        this.rec.disconnected = true;
      }
    };
  });

  afterEach(() => {
    if (original) Object.defineProperty(globalThis, 'ResizeObserver', original);
    else delete (globalThis as any).ResizeObserver;
    document.body.innerHTML = '';
  });

  const create = (...args: Parameters<typeof elementSize>) =>
    TestBed.runInInjectionContext(() => elementSize(...args));

  it('observes the border box by default', () => {
    const el = box(100, 200);
    const sig = create(el);
    TestBed.tick();
    expect(live()[0].observed).toEqual([[el, { box: 'border-box' }]]);
    expect(sig()).toEqual({ width: 100, height: 200 });
  });

  it.each<[string, (el: Element) => Parameters<typeof elementSize>[0]]>([
    ['an element', (el) => el],
    ['an ElementRef', (el) => new ElementRef(el)],
    ['a signal holding an element', (el) => signal<Element | null>(el)],
    ['a signal holding an ElementRef', (el) => signal(new ElementRef(el))],
  ])('has a synchronous initial value for %s', (_, wrap) => {
    const sig = create(wrap(box(40, 30)));
    expect(sig()).toEqual({ width: 40, height: 30 });
  });

  it('is undefined at creation for a signal holding null', () => {
    expect(create(signal<Element | null>(null))()).toBeUndefined();
  });

  it('reports the border box size by default', () => {
    const sig = create(box(1, 1));
    TestBed.tick();
    resize(entry(ALL));
    expect(sig()).toEqual({ width: 130, height: 60 });
  });

  it('reports the content box size for box: content-box', () => {
    const sig = create(box(1, 1), { box: 'content-box' });
    TestBed.tick();
    resize(entry(ALL));
    expect(sig()).toEqual({ width: 100, height: 30 });
  });

  it('reports device pixels for box: device-pixel-content-box', () => {
    const sig = create(box(1, 1), { box: 'device-pixel-content-box' });
    TestBed.tick();
    expect(live()[0].observed[0][1]).toEqual({
      box: 'device-pixel-content-box',
    });
    resize(entry({ ...ALL, device: [200, 60] }));
    expect(sig()).toEqual({ width: 200, height: 60 });
  });

  it('surfaces a width-only and then a height-only resize', () => {
    const sig = create(box(1, 1));
    TestBed.tick();
    const seen: unknown[] = [];
    for (const border of [
      [100, 50],
      [120, 50],
      [120, 80],
    ] as Size[]) {
      resize(entry({ border }));
      seen.push(sig());
    }
    expect(seen).toEqual([
      { width: 100, height: 50 },
      { width: 120, height: 50 },
      { width: 120, height: 80 },
    ]);
  });

  it.each(['vertical-rl', 'vertical-lr', 'sideways-rl'])(
    'maps logical sizes to width and height under writing-mode %s',
    (mode) => {
      const el = box(100, 300);
      el.style.writingMode = mode;
      const border = create(el);
      const content = create(el, { box: 'content-box' });
      TestBed.tick();
      resize(
        entry({ border: [300, 100], content: [280, 80], rect: [80, 280] }),
      );
      expect(border()).toEqual({ width: 100, height: 300 });
      expect(content()).toEqual({ width: 80, height: 280 });
    },
  );

  it('subtracts padding and border from the initial value for box: content-box', () => {
    const el = box(130, 60);
    el.style.padding = '10px';
    el.style.border = '5px solid';
    const sig = create(el, { box: 'content-box' });
    expect(sig()).toEqual({ width: 100, height: 30 });
    TestBed.tick();
    expect(sig()).toEqual({ width: 100, height: 30 });
  });

  it('measures the new element and stops the old observer when the target swaps', () => {
    const a = box(10, 10);
    const b = box(20, 20);
    const target = signal<Element | null>(a);
    const sig = create(target);
    TestBed.tick();
    const [first] = observers;

    target.set(b);
    TestBed.tick();
    expect(first.disconnected).toBe(true);
    expect(live()[0].observed[0][0]).toBe(b);
    expect(sig()).toEqual({ width: 20, height: 20 });
  });

  it('resets to undefined and disconnects when the target becomes null', () => {
    const target = signal<Element | null>(box(10, 10));
    const sig = create(target);
    TestBed.tick();
    resize(entry({ border: [50, 50] }));
    expect(sig()).toEqual({ width: 50, height: 50 });

    target.set(null);
    TestBed.tick();
    expect(sig()).toBeUndefined();
    expect(live()).toHaveLength(0);
  });

  it('disconnects on destroy', () => {
    const child = createEnvironmentInjector(
      [],
      TestBed.inject(EnvironmentInjector),
    );
    elementSize(box(10, 10), { injector: child });
    TestBed.tick();
    expect(live()).toHaveLength(1);
    child.destroy();
    expect(live()).toHaveLength(0);
  });

  it('falls back to a one-time measurement without ResizeObserver', () => {
    delete (globalThis as any).ResizeObserver;
    const sig = create(box(40, 30));
    expect(sig()).toEqual({ width: 40, height: 30 });
    expect(() => TestBed.tick()).not.toThrow();
    expect(sig()).toEqual({ width: 40, height: 30 });
  });

  it('observes nothing on the server, even without options', () => {
    TestBed.configureTestingModule({
      providers: [{ provide: PLATFORM_ID, useValue: 'server' }],
    });
    expect(() => create(box(10, 10))).not.toThrow();
    TestBed.tick();
    expect(observers).toHaveLength(0);
  });
});
