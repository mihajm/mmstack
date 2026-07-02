import { Component, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';

import { Reorderable, ReorderableItem, reorderable } from './reorderable';

type Row = { id: number; label: string };

function pe(type: string, x = 0, y = 0, id = 1): Event {
  const e = new Event(type, { bubbles: true }) as Event &
    Record<string, unknown>;
  Object.assign(e, {
    pointerId: id,
    clientX: x,
    clientY: y,
    pageX: x,
    pageY: y,
    button: 0,
    pointerType: 'mouse',
    shiftKey: false,
    altKey: false,
    ctrlKey: false,
    metaKey: false,
  });
  return e;
}

@Component({
  selector: 'mm-pointer-host',
  imports: [Reorderable, ReorderableItem],
  template: `
    <ul [mmReorderable]="list">
      @for (r of list.items(); track r.id) {
        <li [mmReorderableItem]="r">{{ r.label }}</li>
      }
    </ul>
  `,
})
class PointerHost {
  readonly data = signal<Row[]>([
    { id: 1, label: 'A' },
    { id: 2, label: 'B' },
    { id: 3, label: 'C' },
  ]);
  readonly reorders: Array<{ from: number; to: number }> = [];
  readonly list = reorderable(this.data, {
    key: (r) => r.id,
    engine: 'pointer',
    onReorder: ({ from, to }) => this.reorders.push({ from, to }),
  });
}

describe('reorderable — pointer engine wiring (gesture end vs abort)', () => {
  function setup() {
    // rows stacked by live DOM order: 40px tall → centers 20 / 60 / 100
    const rectSpy = vi
      .spyOn(HTMLElement.prototype, 'getBoundingClientRect')
      .mockImplementation(function (this: HTMLElement) {
        const parent = this.parentElement;
        const idx = parent ? Array.from(parent.children).indexOf(this) : 0;
        return {
          top: idx * 40,
          bottom: idx * 40 + 40,
          left: 0,
          right: 100,
          width: 100,
          height: 40,
          x: 0,
          y: idx * 40,
          toJSON: () => ({}),
        } as DOMRect;
      });

    const fixture = TestBed.createComponent(PointerHost);
    fixture.detectChanges();
    TestBed.tick(); // flush the deferred (afterNextRender) pointer setup
    fixture.detectChanges();

    const host = fixture.componentInstance;
    const first = fixture.nativeElement.querySelector('li') as HTMLElement;
    return { fixture, host, first, rectSpy };
  }

  function dragFirstPastSecond(first: HTMLElement) {
    first.dispatchEvent(pe('pointerdown', 5, 20));
    first.dispatchEvent(pe('pointermove', 5, 70)); // past B's center (60) + deadband
    TestBed.tick(); // beginGesture + move
  }

  it('pointerup commits the reorder', () => {
    const { host, first, rectSpy } = setup();
    try {
      dragFirstPastSecond(first);
      expect(host.list.activeKey()).toBe(1);
      expect(host.list.insertIndex()).toBe(1);

      first.dispatchEvent(pe('pointerup', 5, 70));
      TestBed.tick();

      expect(host.data().map((r) => r.label)).toEqual(['B', 'A', 'C']);
      expect(host.reorders).toEqual([{ from: 0, to: 1 }]);
      expect(host.list.activeKey()).toBeNull();
    } finally {
      rectSpy.mockRestore();
    }
  });

  it('Escape aborts: nothing commits, drag state fully resets', () => {
    const { host, first, rectSpy } = setup();
    try {
      dragFirstPastSecond(first);
      expect(host.list.activeKey()).toBe(1);

      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
      TestBed.tick();

      expect(host.data().map((r) => r.label)).toEqual(['A', 'B', 'C']);
      expect(host.reorders).toEqual([]);
      expect(host.list.activeKey()).toBeNull();
      expect(host.list.insertIndex()).toBe(-1);
    } finally {
      rectSpy.mockRestore();
    }
  });

  it('pointercancel aborts too (e.g. touch scroll takeover)', () => {
    const { host, first, rectSpy } = setup();
    try {
      dragFirstPastSecond(first);
      first.dispatchEvent(pe('pointercancel', 5, 70));
      TestBed.tick();

      expect(host.data().map((r) => r.label)).toEqual(['A', 'B', 'C']);
      expect(host.reorders).toEqual([]);
      expect(host.list.activeKey()).toBeNull();
    } finally {
      rectSpy.mockRestore();
    }
  });

  it('a fresh gesture after an abort still works (cancel is not sticky)', () => {
    const { host, first, rectSpy } = setup();
    try {
      dragFirstPastSecond(first);
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
      TestBed.tick();

      first.dispatchEvent(pe('pointerdown', 5, 20, 2));
      first.dispatchEvent(pe('pointermove', 5, 70, 2));
      TestBed.tick();
      first.dispatchEvent(pe('pointerup', 5, 70, 2));
      TestBed.tick();

      expect(host.data().map((r) => r.label)).toEqual(['B', 'A', 'C']);
    } finally {
      rectSpy.mockRestore();
    }
  });
});
