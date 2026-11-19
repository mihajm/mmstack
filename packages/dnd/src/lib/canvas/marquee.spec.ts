import { ElementRef, PLATFORM_ID, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';

import { marquee, type MarqueeItem } from './marquee';

function pe(type: string, x: number, y: number): Event {
  const e = new Event(type, { bubbles: true }) as Event &
    Record<string, unknown>;
  e['pointerId'] = 1;
  e['clientX'] = x;
  e['clientY'] = y;
  e['pageX'] = x;
  e['pageY'] = y;
  e['button'] = 0;
  e['shiftKey'] = e['altKey'] = e['ctrlKey'] = e['metaKey'] = false;
  return e;
}

function stubRect(el: HTMLElement, left: number, top: number) {
  el.getBoundingClientRect = () =>
    ({
      left,
      top,
      x: left,
      y: top,
      right: left,
      bottom: top,
      width: 0,
      height: 0,
      toJSON: () => ({}),
    }) as DOMRect;
}

function setup(items: MarqueeItem<string>[], origin = { left: 0, top: 0 }) {
  const el = document.createElement('div');
  stubRect(el, origin.left, origin.top);
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({
    providers: [{ provide: ElementRef, useValue: new ElementRef(el) }],
  });
  const sig = signal<readonly MarqueeItem<string>[]>(items);
  const ref = TestBed.runInInjectionContext(() =>
    marquee(sig, { activationThreshold: 4 }),
  );
  return { el, ref };
}

const items: MarqueeItem<string>[] = [
  { id: 1, box: { x: 10, y: 10, width: 10, height: 10 }, value: 'a' },
  { id: 2, box: { x: 100, y: 100, width: 10, height: 10 }, value: 'b' },
];

describe('marquee (pure derivation)', () => {
  it('exposes no rectangle while idle', () => {
    const { ref } = setup(items);
    expect(ref.selecting()).toBe(false);
    expect(ref.rect()).toBeNull();
    expect(ref.selected()).toEqual([]);
  });

  it('derives the rubber-band rect and intersecting items', () => {
    const { el, ref } = setup(items);
    el.dispatchEvent(pe('pointerdown', 0, 0));
    el.dispatchEvent(pe('pointermove', 50, 40));

    expect(ref.selecting()).toBe(true);
    expect(ref.rect()).toEqual({ x: 0, y: 0, width: 50, height: 40 });
    expect(ref.selected()).toEqual(['a']); // only item 1 overlaps
  });

  it('selects multiple items as the rect grows', () => {
    const { el, ref } = setup(items);
    el.dispatchEvent(pe('pointerdown', 0, 0));
    el.dispatchEvent(pe('pointermove', 200, 200));
    expect(ref.selected()).toEqual(['a', 'b']);
  });

  it('projects the rect into host-local space using the origin', () => {
    const { el, ref } = setup(items, { left: 5, top: 5 });
    el.dispatchEvent(pe('pointerdown', 5, 5)); // local (0,0)
    el.dispatchEvent(pe('pointermove', 30, 25)); // local (25,20)
    expect(ref.rect()).toEqual({ x: 0, y: 0, width: 25, height: 20 });
  });

  it('re-measures the host origin for every press, even with the same pointer id', () => {
    const { el, ref } = setup(items, { left: 0, top: 0 });
    el.dispatchEvent(pe('pointerdown', 0, 0));
    el.dispatchEvent(pe('pointermove', 50, 40));
    expect(ref.rect()).toEqual({ x: 0, y: 0, width: 50, height: 40 });
    el.dispatchEvent(pe('pointerup', 50, 40));

    stubRect(el, 0, -200); // the page scrolled between the two presses
    el.dispatchEvent(pe('pointerdown', 0, 0));
    el.dispatchEvent(pe('pointermove', 50, 40));
    expect(ref.rect()).toEqual({ x: 0, y: 200, width: 50, height: 40 });
  });

  it('measures the host origin once per press, not per pointer frame', () => {
    const { el, ref } = setup(items);
    const measure = vi.spyOn(el, 'getBoundingClientRect');
    el.dispatchEvent(pe('pointerdown', 0, 0));
    for (let x = 10; x <= 60; x += 10) {
      el.dispatchEvent(pe('pointermove', x, x));
      ref.rect();
    }
    expect(measure).toHaveBeenCalledTimes(1);
  });

  it('honours a custom activation threshold and button list', () => {
    const el = document.createElement('div');
    stubRect(el, 0, 0);
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      providers: [{ provide: ElementRef, useValue: new ElementRef(el) }],
    });
    const ref = TestBed.runInInjectionContext(() =>
      marquee(signal(items), { activationThreshold: 20, buttons: [2] }),
    );
    el.dispatchEvent(pe('pointerdown', 0, 0));
    el.dispatchEvent(pe('pointermove', 30, 0));
    expect(ref.selecting()).toBe(false); // button 0 is not in the list
    el.dispatchEvent(pe('pointerup', 30, 0));

    const down = pe('pointerdown', 0, 0) as Event & Record<string, unknown>;
    down['button'] = 2;
    el.dispatchEvent(down);
    el.dispatchEvent(pe('pointermove', 10, 0));
    expect(ref.selecting()).toBe(false); // under the 20px threshold
    el.dispatchEvent(pe('pointermove', 30, 0));
    expect(ref.selecting()).toBe(true);
  });

  it('defaults the activation threshold to 4px', () => {
    const el = document.createElement('div');
    stubRect(el, 0, 0);
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      providers: [{ provide: ElementRef, useValue: new ElementRef(el) }],
    });
    const ref = TestBed.runInInjectionContext(() => marquee(signal(items)));
    el.dispatchEvent(pe('pointerdown', 0, 0));
    el.dispatchEvent(pe('pointermove', 3, 0));
    expect(ref.selecting()).toBe(false);
    el.dispatchEvent(pe('pointermove', 5, 0));
    expect(ref.selecting()).toBe(true);
  });

  it('clears on pointerup', () => {
    const { el, ref } = setup(items);
    el.dispatchEvent(pe('pointerdown', 0, 0));
    el.dispatchEvent(pe('pointermove', 50, 40));
    expect(ref.selecting()).toBe(true);
    el.dispatchEvent(pe('pointerup', 50, 40));
    expect(ref.selecting()).toBe(false);
    expect(ref.rect()).toBeNull();
    expect(ref.selected()).toEqual([]);
  });

  it('is inert on the server', () => {
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      providers: [
        {
          provide: ElementRef,
          useValue: new ElementRef(document.createElement('div')),
        },
        { provide: PLATFORM_ID, useValue: 'server' },
      ],
    });
    const sig = signal<readonly MarqueeItem<string>[]>(items);
    const ref = TestBed.runInInjectionContext(() => marquee(sig));
    expect(ref.selecting()).toBe(false);
    expect(ref.rect()).toBeNull();
    expect(ref.selected()).toEqual([]);
  });
});
