import { Component, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';

import { sortableGroup } from './group';
import { Reorderable, ReorderableItem, reorderable } from './reorderable';

// Mock the pragmatic element adapter so native draggable/dropTarget registration
// is observable (and the ambient monitor is inert).
const draggableMock = vi.fn();
const dropTargetMock = vi.fn();
vi.mock('@atlaskit/pragmatic-drag-and-drop/element/adapter', () => ({
  draggable: (c: unknown) => {
    draggableMock(c);
    return () => undefined;
  },
  dropTargetForElements: (c: unknown) => {
    dropTargetMock(c);
    return () => undefined;
  },
  monitorForElements: () => () => undefined,
}));

type Row = { id: number; label: string };

@Component({
  selector: 'mm-native-host',
  imports: [Reorderable, ReorderableItem],
  template: `
    <ul [mmReorderable]="list">
      @for (r of list.items(); track r.id) {
        <li [mmReorderableItem]="r">{{ r.label }}</li>
      }
    </ul>
  `,
})
class NativeHost {
  readonly data = signal<Row[]>([
    { id: 1, label: 'A' },
    { id: 2, label: 'B' },
    { id: 3, label: 'C' },
  ]);
  // no engine → defaults to 'native'
  readonly list = reorderable(this.data, { key: (r) => r.id });
}

@Component({
  selector: 'mm-custom-keys-host',
  imports: [Reorderable, ReorderableItem],
  template: `
    <ul [mmReorderable]="list">
      @for (r of list.items(); track r.id) {
        <li [mmReorderableItem]="r">{{ r.label }}</li>
      }
    </ul>
  `,
})
class CustomKeysHost {
  readonly data = signal<Row[]>([
    { id: 1, label: 'A' },
    { id: 2, label: 'B' },
    { id: 3, label: 'C' },
  ]);
  // custom keys replace the built-in arrows: j = down, k = up
  readonly list = reorderable(this.data, {
    key: (r) => r.id,
    onKeyboardKeydown: (e, { index, total, move }) => {
      if (e.key === 'j') {
        e.preventDefault();
        move(Math.min(index + 1, total - 1));
      } else if (e.key === 'k') {
        e.preventDefault();
        move(Math.max(index - 1, 0));
      }
    },
  });
}

@Component({
  selector: 'mm-silent-host',
  imports: [Reorderable, ReorderableItem],
  template: `
    <ul [mmReorderable]="list">
      @for (r of list.items(); track r.id) {
        <li [mmReorderableItem]="r">{{ r.label }}</li>
      }
    </ul>
  `,
})
class SilentHost {
  readonly data = signal<Row[]>([
    { id: 1, label: 'A' },
    { id: 2, label: 'B' },
    { id: 3, label: 'C' },
  ]);
  readonly list = reorderable(this.data, {
    key: (r) => r.id,
    announceMove: false, // a11y announcements opted out
  });
}

describe('reorderable — native engine wiring', () => {
  beforeEach(() => {
    draggableMock.mockReset();
    dropTargetMock.mockReset();
  });

  it('defaults to the native engine', () => {
    TestBed.runInInjectionContext(() => {
      const list = reorderable(signal<Row[]>([]), { key: (r) => r.id });
      expect(list.engine).toBe('native');
    });
  });

  it('renders, registers a native draggable per item + a container dropTarget, and shows indicators', () => {
    const fixture = TestBed.createComponent(NativeHost);
    fixture.detectChanges();
    TestBed.tick(); // flush the deferred (afterNextRender) native setup
    fixture.detectChanges();

    // wired through the NATIVE primitives (not the pointer engine)
    expect(dropTargetMock).toHaveBeenCalled(); // the list container
    expect(draggableMock).toHaveBeenCalledTimes(3); // one per row
    // each row hosts a drop-indicator line
    expect(
      fixture.nativeElement.querySelectorAll('mm-drop-indicator').length,
    ).toBe(3);
    // rendered without crashing (the NG0950 regression guard)
    expect(fixture.nativeElement.textContent).toContain('A');
  });

  // NOTE: this guards that a reorder fires the FLIP glide on every moved row. It
  // does NOT reproduce the first-commit / cross-list "stale baseline" timing bug:
  // happy-dom's TestBed.tick() force-flushes the render pass that primes the FLIP
  // baseline, which the real browser defers until the reorder. That timing fix
  // (re-baseline on drag start) is verified in-browser, not here.
  it('FLIP-on-commit: a reorder glides every moved row', () => {
    // position each <li> by its live DOM order so a reorder yields a real delta
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
    const animateMock = vi.fn(
      () => ({ finished: Promise.resolve() }) as unknown as Animation,
    );
    const proto = HTMLElement.prototype as { animate?: unknown };
    const origAnimate = proto.animate;
    proto.animate = animateMock;

    try {
      const fixture = TestBed.createComponent(NativeHost);
      fixture.detectChanges();
      TestBed.tick(); // connect + prime the FLIP baseline (post-layout)
      fixture.detectChanges();

      animateMock.mockClear(); // ignore any connect-time write

      // A → down one (order becomes B, A, C). Keyboard path = no drag session, so
      // no row is "source": every moved row must glide on this FIRST commit.
      const first = fixture.nativeElement.querySelector('li') as HTMLElement;
      first.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }),
      );
      fixture.detectChanges();
      TestBed.tick(); // flush the FLIP afterRenderEffect
      fixture.detectChanges();

      // Both A (0→40) and B (40→0) moved → both glide; C (80→80) stays put.
      expect(animateMock.mock.calls.length).toBeGreaterThanOrEqual(2);
    } finally {
      rectSpy.mockRestore();
      if (origAnimate === undefined) delete proto.animate;
      else proto.animate = origAnimate;
    }
  });

  it('cross-list transfer primitives: insertAt (target) + takeOut (source) with callbacks', () => {
    const group = sortableGroup<Row>();
    const listA = signal<Row[]>([
      { id: 1, label: 'A1' },
      { id: 2, label: 'A2' },
    ]);
    const listB = signal<Row[]>([{ id: 3, label: 'B1' }]);
    const arrived: unknown[] = [];
    const left: unknown[] = [];
    const a = reorderable(listA, {
      key: (r) => r.id,
      group,
      onItemLeft: (e) => left.push(e),
    });
    const b = reorderable(listB, {
      key: (r) => r.id,
      group,
      onItemArrived: (e) => arrived.push(e),
    });
    expect(a.group).toBe(group); // exposed for the same-group gate
    expect(b.group).toBe(group);

    // move A1 from A into B at slot 1 (what the cross-list onDrop does)
    const moved = listA()[0];
    b.insertAt(moved, 1);
    a.takeOut(moved, 1);

    expect(listB().map((r) => r.label)).toEqual(['B1', 'A1']);
    expect(listA().map((r) => r.label)).toEqual(['A2']);
    expect(arrived).toEqual([{ item: moved, index: 1 }]);
    expect(left).toEqual([{ item: moved, from: 0, to: 1 }]);
  });

  it('keyboard: ArrowDown moves the focused item down (native engine, default keyboard)', () => {
    const fixture = TestBed.createComponent(NativeHost);
    fixture.detectChanges();
    TestBed.tick();
    fixture.detectChanges();

    const first = fixture.nativeElement.querySelector('li') as HTMLElement;
    expect(first.getAttribute('tabindex')).toBe('0'); // focusable (keyboard on)
    first.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }),
    );
    fixture.detectChanges();

    const labels = [...fixture.nativeElement.querySelectorAll('li')].map((e) =>
      (e.textContent ?? '').trim(),
    );
    expect(labels).toEqual(['B', 'A', 'C']); // A moved down one
  });

  it('keyboard: the moved item is re-focused after a reorder (so arrow-repeat keeps working)', () => {
    const fixture = TestBed.createComponent(NativeHost);
    fixture.detectChanges();
    TestBed.tick();
    fixture.detectChanges();

    const b = fixture.nativeElement.querySelectorAll('li')[1] as HTMLElement; // 'B'
    b.focus();
    expect(document.activeElement).toBe(b);

    b.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true }),
    );
    // Simulate the reconciliation blur the real browser exhibits on a backward
    // move — the fix must restore focus after the DOM settles.
    b.blur();
    fixture.detectChanges();
    TestBed.tick(); // flush the afterNextRender → element.focus()
    fixture.detectChanges();

    const labels = [...fixture.nativeElement.querySelectorAll('li')].map((e) =>
      (e.textContent ?? '').trim(),
    );
    expect(labels).toEqual(['B', 'A', 'C']); // B moved up
    expect(document.activeElement).toBe(b); // …and B keeps focus (same node)
  });

  it('keyboard: scrolls the moved item into view (nearest, both axes — survives under a scroller)', () => {
    const fixture = TestBed.createComponent(NativeHost);
    fixture.detectChanges();
    TestBed.tick();
    fixture.detectChanges();

    const first = fixture.nativeElement.querySelector('li') as HTMLElement; // 'A'
    const scrollIntoView = vi.fn();
    first.scrollIntoView = scrollIntoView; // spy (happy-dom's is a no-op)
    first.focus();
    first.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }),
    );
    fixture.detectChanges();
    TestBed.tick(); // flush afterNextRender → focus + scrollIntoView
    fixture.detectChanges();

    // focus() only scrolls when focus MOVES; scrollIntoView keeps the item visible
    // even in the retain-focus direction, on both axes + nested scroll containers.
    expect(scrollIntoView).toHaveBeenCalledWith({
      block: 'nearest',
      inline: 'nearest',
    });
  });

  it('keyboard: onKeyboardKeydown replaces the built-in keys (custom j/k)', () => {
    const fixture = TestBed.createComponent(CustomKeysHost);
    fixture.detectChanges();
    TestBed.tick();
    fixture.detectChanges();
    const labels = () =>
      [...fixture.nativeElement.querySelectorAll('li')].map((e) =>
        (e.textContent ?? '').trim(),
      );

    const first = fixture.nativeElement.querySelector('li') as HTMLElement; // 'A'

    // built-in arrows are overridden → no-op
    first.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }),
    );
    fixture.detectChanges();
    expect(labels()).toEqual(['A', 'B', 'C']);

    // the custom 'j' moves the focused item down via api.move
    first.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'j', bubbles: true }),
    );
    fixture.detectChanges();
    expect(labels()).toEqual(['B', 'A', 'C']);
  });

  it('keyboard: announceMove:false reorders but creates no live region (a11y opt-out)', () => {
    expect(document.body.querySelector('[aria-live]')).toBeNull(); // clean slate

    const fixture = TestBed.createComponent(SilentHost);
    fixture.detectChanges();
    TestBed.tick();
    fixture.detectChanges();
    expect(fixture.componentInstance.list.announceMove).toBeNull(); // opt-out resolved

    const first = fixture.nativeElement.querySelector('li') as HTMLElement;
    first.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }),
    );
    fixture.detectChanges();
    TestBed.tick();

    const labels = [...fixture.nativeElement.querySelectorAll('li')].map((e) =>
      (e.textContent ?? '').trim(),
    );
    expect(labels).toEqual(['B', 'A', 'C']); // still reorders
    // …and the announcer was never resolved → no live region injected into the DOM
    expect(document.body.querySelector('[aria-live]')).toBeNull();
  });

  it('foreign insert: insertForeign maps the payload, inserts it, fires onItemInserted; rejects non-accepted', () => {
    const list = signal<Row[]>([{ id: 1, label: 'A' }]);
    const inserted: unknown[] = [];
    const r = reorderable(list, {
      key: (row) => row.id,
      insert: {
        accepts: (d) => typeof d === 'string',
        create: (d, i) => ({ id: 100 + i, label: d as string }),
      },
      onItemInserted: (e) => inserted.push(e),
    });

    r.insertForeign('X', 1);
    expect(list().map((x) => x.label)).toEqual(['A', 'X']);
    expect(inserted).toEqual([{ item: { id: 101, label: 'X' }, index: 1 }]);

    r.insertForeign(42, 0); // not a string → rejected by accepts
    expect(list()).toHaveLength(2);
  });
});
