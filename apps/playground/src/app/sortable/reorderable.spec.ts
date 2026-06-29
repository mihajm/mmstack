import { Component, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { By } from '@angular/platform-browser';

import {
  boxData,
  injectDndSession,
  provideDnd,
  type DragSession,
  type DropTargetHit,
  type Edge,
  type HitboxPlugin,
} from '@mmstack/dnd';
import {
  computeInsertIndex,
  handleCrossListArrival,
  handleExternalInsert,
  handleSameListReorder,
  insertIndexFromCenters,
  moveWithin,
  Reorderable,
  ReorderableItem,
  reorderable,
  type ItemInsertedEvent,
  type ReorderEvent,
} from './reorderable';

vi.mock('@atlaskit/pragmatic-drag-and-drop/element/adapter', () => ({
  draggable: vi.fn(() => () => undefined),
  dropTargetForElements: vi.fn(() => () => undefined),
  monitorForElements: vi.fn(() => () => undefined),
}));

type Card = { id: number };
const isCard = (d: unknown): d is Card =>
  !!d && typeof d === 'object' && 'id' in (d as object);

const stubHitbox: HitboxPlugin = {
  attachClosestEdge: (d) => d,
  extractClosestEdge: () => 'top',
};

describe('reorderable — pure ops', () => {
  it('reorderable() builds a ref over the writable signal', () => {
    const items = signal<Card[]>([{ id: 1 }]);
    const ref = reorderable(items, { accepts: isCard, key: (c) => c.id, group: 'g' });
    expect(ref.items()).toEqual([{ id: 1 }]);
    expect(ref.key({ id: 1 })).toBe(1);
    expect(ref._meta.group).toBe('g');
    expect(typeof ref._meta.id).toBe('symbol');
    expect(ref._items).toBe(items);
  });

  it('computeInsertIndex shifts only for bottom/right edges', () => {
    expect(computeInsertIndex(2, 'top')).toBe(2);
    expect(computeInsertIndex(2, 'left')).toBe(2);
    expect(computeInsertIndex(2, null)).toBe(2);
    expect(computeInsertIndex(2, 'bottom')).toBe(3);
    expect(computeInsertIndex(2, 'right')).toBe(3);
  });

  it('insertIndexFromCenters counts the centers the pointer has passed', () => {
    const centers = [10, 30, 50]; // 3 items, ascending centers
    expect(insertIndexFromCenters(centers, 5)).toBe(0); // above all
    expect(insertIndexFromCenters(centers, 20)).toBe(1); // between 0 and 1
    expect(insertIndexFromCenters(centers, 40)).toBe(2); // between 1 and 2
    expect(insertIndexFromCenters(centers, 60)).toBe(3); // past all → end
    expect(insertIndexFromCenters([], 99)).toBe(0); // empty list
  });

  it('handleSameListReorder moves an item and reports from/to', () => {
    const items = signal<Card[]>([{ id: 1 }, { id: 2 }, { id: 3 }]);
    const events: ReorderEvent<Card>[] = [];
    const ref = reorderable(items, {
      accepts: isCard,
      key: (c) => c.id,
      onReorder: (e) => events.push(e),
    });
    handleSameListReorder(ref, { id: 1 }, 2);
    expect(items().map((c) => c.id)).toEqual([2, 1, 3]);
    expect(events).toEqual([{ item: { id: 1 }, from: 0, to: 1 }]);
  });

  it('handleSameListReorder is a no-op when position is unchanged', () => {
    const items = signal<Card[]>([{ id: 1 }, { id: 2 }]);
    const events: ReorderEvent<Card>[] = [];
    const ref = reorderable(items, {
      accepts: isCard,
      key: (c) => c.id,
      onReorder: (e) => events.push(e),
    });
    handleSameListReorder(ref, { id: 1 }, 0);
    expect(items().map((c) => c.id)).toEqual([1, 2]);
    expect(events).toHaveLength(0);
  });

  it('handleSameListReorder ignores items not in the list', () => {
    const items = signal<Card[]>([{ id: 1 }]);
    const ref = reorderable(items, { accepts: isCard, key: (c) => c.id });
    handleSameListReorder(ref, { id: 99 }, 0);
    expect(items()).toEqual([{ id: 1 }]);
  });

  it('moveWithin relocates an item to a final index', () => {
    expect(moveWithin([1, 2, 3, 4], 0, 2)).toEqual([2, 3, 1, 4]);
    expect(moveWithin([1, 2, 3, 4], 3, 0)).toEqual([4, 1, 2, 3]);
    expect(moveWithin([1, 2, 3], 1, 99)).toEqual([1, 3, 2]);
  });

  it('handleCrossListArrival inserts (clamped) and reports to', () => {
    const items = signal<Card[]>([{ id: 1 }, { id: 2 }]);
    const arrived: { item: Card; to: number }[] = [];
    const ref = reorderable(items, {
      accepts: isCard,
      key: (c) => c.id,
      onItemArrived: (e) => arrived.push(e),
    });
    handleCrossListArrival(ref, { id: 9 }, 1);
    expect(items().map((c) => c.id)).toEqual([1, 9, 2]);
    expect(arrived).toEqual([{ item: { id: 9 }, to: 1 }]);

    handleCrossListArrival(ref, { id: 10 }, 999);
    expect(items().at(-1)).toEqual({ id: 10 });
  });

  it('handleExternalInsert maps a foreign payload via create() and inserts at index', () => {
    const items = signal<Card[]>([{ id: 1 }, { id: 2 }]);
    const inserted: ItemInsertedEvent<Card>[] = [];
    const ref = reorderable(items, {
      accepts: isCard,
      key: (c) => c.id,
      insert: {
        accepts: (d): boolean => !!d && typeof d === 'object' && 'rmType' in d,
        create: (d) => ({ id: (d as { rmType: number }).rmType }),
      },
      onItemInserted: (e) => inserted.push(e),
    });

    handleExternalInsert(ref, { rmType: 7 }, 1);
    expect(items().map((c) => c.id)).toEqual([1, 7, 2]);
    expect(inserted).toEqual([{ item: { id: 7 }, to: 1, source: { rmType: 7 } }]);
  });

  it('handleExternalInsert clamps the index and is a no-op for non-qualifying / missing insert', () => {
    const items = signal<Card[]>([{ id: 1 }]);
    const withInsert = reorderable(items, {
      accepts: isCard,
      key: (c) => c.id,
      insert: {
        accepts: (d): boolean => !!d && typeof d === 'object' && 'rmType' in d,
        create: (d) => ({ id: (d as { rmType: number }).rmType }),
      },
    });
    handleExternalInsert(withInsert, { rmType: 9 }, 999); // clamped to end
    expect(items().map((c) => c.id)).toEqual([1, 9]);
    handleExternalInsert(withInsert, { nope: true }, 0); // accepts() false
    expect(items().map((c) => c.id)).toEqual([1, 9]);

    const noInsert = reorderable(signal<Card[]>([{ id: 1 }]), {
      accepts: isCard,
      key: (c) => c.id,
    });
    handleExternalInsert(noInsert, { rmType: 5 }, 0); // no insert config → no-op
    expect(noInsert.items().map((c) => c.id)).toEqual([1]);
  });
});

@Component({
  selector: 'mm-reorderable-host',
  imports: [Reorderable, ReorderableItem],
  template: `
    <ul [mmReorderable]="list">
      @for (c of list.items(); track c.id) {
        <li [mmReorderableItem]="c"></li>
      }
    </ul>
  `,
})
class Host {
  readonly cards = signal<Card[]>([{ id: 1 }, { id: 2 }, { id: 3 }]);
  readonly list = reorderable(this.cards, { accepts: isCard, key: (c) => c.id });
}

function renderHost() {
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({
    providers: [provideDnd({ plugins: { hitbox: stubHitbox } })],
  });
  const fixture = TestBed.createComponent(Host);
  fixture.detectChanges();
  const items = fixture.debugElement
    .queryAll(By.directive(ReorderableItem))
    .map((de) => de.injector.get(ReorderableItem));
  return { fixture, items };
}

describe('reorderable — directive derivation', () => {
  it('derives each item index from the parent key→index map', () => {
    const { fixture, items } = renderHost();
    expect(items.map((i) => i.index())).toEqual([0, 1, 2]);

    // reorder the underlying data → indices re-derive
    fixture.componentInstance.cards.set([{ id: 3 }, { id: 1 }, { id: 2 }]);
    fixture.detectChanges();
    const reread = fixture.debugElement
      .queryAll(By.directive(ReorderableItem))
      .map((de) => de.injector.get(ReorderableItem));
    expect(reread.map((i) => i.index())).toEqual([0, 1, 2]);
    // the item with id 1 is now at index 1
    const id1 = reread.find((i) => (i.item() as Card).id === 1);
    expect(id1?.index()).toBe(1);
  });

  it('renders a single folded indicator at the active insert index', async () => {
    const { fixture } = renderHost();
    await fixture.whenStable(); // indicators are created in afterNextRender
    const session = TestBed.runInInjectionContext(() => injectDndSession());
    const els = fixture.debugElement
      .queryAll(By.directive(ReorderableItem))
      .map((de) => de.nativeElement as HTMLElement);
    // item centers at 10 / 30 / 50
    els.forEach((el, i) => {
      el.getBoundingClientRect = () =>
        ({ top: i * 20, height: 20, bottom: i * 20 + 20, left: 0, width: 100, right: 100, x: 0, y: i * 20, toJSON: () => ({}) }) as DOMRect;
    });
    const id = fixture.componentInstance.list._meta.id;
    const drag = (pointerY: number): DragSession => ({
      sourceEl: document.createElement('div'),
      sourceData: boxData<Card>({ id: 99 }),
      // any slot of this list → this list owns the hover; pointer drives the index
      targets: [{ element: els[0], data: boxData({ reorderableId: id, group: undefined, index: 0 }) }],
      pointer: { x: 0, y: pointerY },
      kind: 'transfer',
    });

    // pointer between centers 10 and 30 → insert 1 → item[1] shows the line, exactly one
    session.set(drag(20));
    fixture.detectChanges();
    expect(els[1].querySelector('.line')?.getAttribute('data-edge')).toBe('top');
    expect(fixture.nativeElement.querySelectorAll('.line').length).toBe(1);

    // pointer past all centers → insert at end → last item shows the trailing line
    session.set(drag(60));
    fixture.detectChanges();
    expect(els[2].querySelector('.line')?.getAttribute('data-edge')).toBe('bottom');
    expect(fixture.nativeElement.querySelectorAll('.line').length).toBe(1);

    session.set(null);
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelectorAll('.line').length).toBe(0);
  });
});

@Component({
  selector: 'mm-reorderable-kb-host',
  imports: [Reorderable, ReorderableItem],
  template: `
    <ul [mmReorderable]="list">
      @for (c of list.items(); track c.id) {
        <li [mmReorderableItem]="c"></li>
      }
    </ul>
  `,
})
class KbHost {
  readonly cards = signal<Card[]>([{ id: 1 }, { id: 2 }, { id: 3 }]);
  readonly list = reorderable(this.cards, {
    accepts: isCard,
    key: (c) => c.id,
    keyboard: true,
  });
}

describe('reorderable — keyboard', () => {
  function render() {
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      providers: [provideDnd({ plugins: { hitbox: stubHitbox } })],
    });
    const fixture = TestBed.createComponent(KbHost);
    fixture.detectChanges();
    const els = fixture.debugElement
      .queryAll(By.directive(ReorderableItem))
      .map((de) => de.nativeElement as HTMLElement);
    return { fixture, els };
  }

  it('moves an item one step with the arrow key', () => {
    const { fixture, els } = render();
    els[0].dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
    expect(fixture.componentInstance.cards().map((c) => c.id)).toEqual([2, 1, 3]);
  });

  it('jumps to the end with Ctrl+Arrow', () => {
    const { fixture, els } = render();
    els[0].dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', ctrlKey: true, bubbles: true }));
    expect(fixture.componentInstance.cards().map((c) => c.id)).toEqual([2, 3, 1]);
  });

  it('makes items focusable', () => {
    const { els } = render();
    expect(els[0].getAttribute('tabindex')).toBe('0');
  });

  it('flashes + announces on keyboard move when plugins/announceItem are set', () => {
    const flashed: HTMLElement[] = [];
    const announced: string[] = [];

    @Component({
      selector: 'mm-reorderable-a11y-host',
      imports: [Reorderable, ReorderableItem],
      template: `
        <ul [mmReorderable]="list">
          @for (c of list.items(); track c.id) {
            <li [mmReorderableItem]="c"></li>
          }
        </ul>
      `,
    })
    class A11yHost {
      readonly cards = signal<Card[]>([{ id: 1 }, { id: 2 }]);
      readonly list = reorderable(this.cards, {
        accepts: isCard,
        key: (c) => c.id,
        keyboard: true,
        announceItem: (c) => `Card ${c.id}`,
      });
    }

    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      providers: [
        provideDnd({
          plugins: {
            hitbox: stubHitbox,
            postMoveFlash: (el) => flashed.push(el),
            announce: (m) => announced.push(m),
          },
        }),
      ],
    });
    const fixture = TestBed.createComponent(A11yHost);
    fixture.detectChanges();
    const els = fixture.debugElement
      .queryAll(By.directive(ReorderableItem))
      .map((de) => de.nativeElement as HTMLElement);

    els[0].dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
    expect(flashed).toHaveLength(1);
    expect(announced[0]).toBe('Card 1 moved to position 2 of 2');
  });

  it('animate:true reorders without error (FLIP path)', () => {
    @Component({
      selector: 'mm-reorderable-anim-host',
      imports: [Reorderable, ReorderableItem],
      template: `
        <ul [mmReorderable]="list">
          @for (c of list.items(); track c.id) {
            <li [mmReorderableItem]="c"></li>
          }
        </ul>
      `,
    })
    class AnimHost {
      readonly cards = signal<Card[]>([{ id: 1 }, { id: 2 }, { id: 3 }]);
      readonly list = reorderable(this.cards, {
        accepts: isCard,
        key: (c) => c.id,
        keyboard: true,
        animate: { duration: 120 },
      });
    }
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      providers: [provideDnd({ plugins: { hitbox: stubHitbox } })],
    });
    const fixture = TestBed.createComponent(AnimHost);
    fixture.detectChanges();
    const els = fixture.debugElement
      .queryAll(By.directive(ReorderableItem))
      .map((de) => de.nativeElement as HTMLElement);
    expect(() =>
      els[0].dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true })),
    ).not.toThrow();
    expect(fixture.componentInstance.cards().map((c) => c.id)).toEqual([2, 1, 3]);
  });
});

describe('reorderable — zero-config & keyboard edge cases', () => {
  it('renders and reorders with NO provideDnd hitbox registration (#3)', () => {
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({ providers: [] }); // deliberately no provideDnd
    const fixture = TestBed.createComponent(Host);
    expect(() => fixture.detectChanges()).not.toThrow();
    const items = fixture.debugElement
      .queryAll(By.directive(ReorderableItem))
      .map((de) => de.injector.get(ReorderableItem));
    expect(items.map((i) => i.index())).toEqual([0, 1, 2]);
  });

  it('does not hijack arrow keys fired from a child input (#1)', () => {
    @Component({
      selector: 'mm-reorderable-edit-host',
      imports: [Reorderable, ReorderableItem],
      template: `
        <ul [mmReorderable]="list">
          @for (c of list.items(); track c.id) {
            <li [mmReorderableItem]="c"><input /></li>
          }
        </ul>
      `,
    })
    class EditHost {
      readonly cards = signal<Card[]>([{ id: 1 }, { id: 2 }, { id: 3 }]);
      readonly list = reorderable(this.cards, {
        accepts: isCard,
        key: (c) => c.id,
        keyboard: true,
      });
    }
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({ providers: [] });
    const fixture = TestBed.createComponent(EditHost);
    fixture.detectChanges();
    const lis = fixture.debugElement
      .queryAll(By.directive(ReorderableItem))
      .map((de) => de.nativeElement as HTMLElement);

    // arrow from inside the input → caret move, NOT reorder
    const input = fixture.debugElement.query(By.css('li input'))
      .nativeElement as HTMLInputElement;
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
    expect(fixture.componentInstance.cards().map((c) => c.id)).toEqual([1, 2, 3]);

    // arrow on the bare host → reorder
    lis[0].dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
    expect(fixture.componentInstance.cards().map((c) => c.id)).toEqual([2, 1, 3]);
  });

  it('a mixed edge set keeps BOTH keyboard axes live (#11)', () => {
    @Component({
      selector: 'mm-reorderable-mixed-host',
      imports: [Reorderable, ReorderableItem],
      template: `
        <ul [mmReorderable]="list">
          @for (c of list.items(); track c.id) {
            <li [mmReorderableItem]="c"></li>
          }
        </ul>
      `,
    })
    class MixedHost {
      readonly cards = signal<Card[]>([{ id: 1 }, { id: 2 }, { id: 3 }]);
      readonly list = reorderable(this.cards, {
        accepts: isCard,
        key: (c) => c.id,
        keyboard: true,
        edges: ['top', 'left'],
      });
    }
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({ providers: [] });
    const fixture = TestBed.createComponent(MixedHost);
    fixture.detectChanges();
    const lis = fixture.debugElement
      .queryAll(By.directive(ReorderableItem))
      .map((de) => de.nativeElement as HTMLElement);

    lis[0].dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
    expect(fixture.componentInstance.cards().map((c) => c.id)).toEqual([2, 1, 3]);
    fixture.detectChanges(); // reflect the reorder in the DOM before re-querying

    const firstNow = fixture.debugElement
      .queryAll(By.directive(ReorderableItem))[0]
      .nativeElement as HTMLElement; // now card 2, at index 0
    firstNow.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    expect(fixture.componentInstance.cards().map((c) => c.id)).toEqual([1, 2, 3]);
  });
});

// extractClosestEdge reads `__edge` off the target data so tests can drive any edge.
const gapEdgeStub: HitboxPlugin = {
  attachClosestEdge: (d) => d,
  extractClosestEdge: (d) =>
    ((d as Record<string, unknown>)['__edge'] as Edge) ?? null,
};

@Component({
  selector: 'mm-reorderable-gap-host',
  imports: [Reorderable, ReorderableItem],
  template: `
    <ul [mmReorderable]="list">
      @for (c of list.items(); track c.id) {
        <li [mmReorderableItem]="c"></li>
      }
    </ul>
  `,
})
class GapHost {
  readonly cards = signal<Card[]>([{ id: 1 }, { id: 2 }, { id: 3 }]);
  readonly list = reorderable(this.cards, {
    accepts: isCard,
    key: (c) => c.id,
    placeholder: 'gap',
  });
}

describe('reorderable — gap placeholder (#27)', () => {
  function render() {
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      providers: [provideDnd({ plugins: { hitbox: gapEdgeStub } })],
    });
    const fixture = TestBed.createComponent(GapHost);
    fixture.detectChanges();
    const parent = fixture.debugElement
      .query(By.directive(Reorderable))
      .injector.get(Reorderable);
    const els = fixture.debugElement
      .queryAll(By.directive(ReorderableItem))
      .map((de) => de.nativeElement as HTMLElement);
    const session = TestBed.runInInjectionContext(() => injectDndSession());
    return { fixture, parent, els, session, host: fixture.componentInstance };
  }

  function slot(
    el: HTMLElement,
    id: symbol,
    index: number,
    edge?: Edge,
  ): DropTargetHit {
    return {
      element: el,
      data: {
        ...boxData({ reorderableId: id, group: undefined, index }),
        ...(edge ? { __edge: edge } : {}),
      },
    };
  }

  function gapSession(
    source: HTMLElement,
    targets: DropTargetHit[],
    pointerY = 0,
  ): DragSession {
    return {
      sourceEl: source,
      sourceData: boxData<Card>({ id: 1 }),
      targets,
      pointer: { x: 0, y: pointerY },
      kind: 'transfer',
    };
  }

  // Deterministic vertical centers: item i is centered at i*20 + 10 → [10, 30, 50].
  function stubCenters(els: HTMLElement[]): void {
    els.forEach((el, i) => {
      el.getBoundingClientRect = () =>
        ({
          top: i * 20,
          height: 20,
          bottom: i * 20 + 20,
          left: 0,
          width: 100,
          right: 100,
          x: 0,
          y: i * 20,
          toJSON: () => ({}),
        }) as DOMRect;
    });
  }

  it('activeInsert is null with no drag', () => {
    const { parent } = render();
    expect(parent.activeInsert()).toBeNull();
  });

  it('derives the insert index from the pointer vs cached item centers (collision)', () => {
    const { fixture, parent, els, host, session } = render();
    stubCenters(els);
    const own = [slot(els[0], host.list._meta.id, 0)]; // this list owns the hover

    session.set(gapSession(els[0], own, 5)); // above center[0]=10
    fixture.detectChanges();
    expect(parent.activeInsert()).toBe(0);

    session.set(gapSession(els[0], own, 20)); // between 10 and 30
    fixture.detectChanges();
    expect(parent.activeInsert()).toBe(1);

    session.set(gapSession(els[0], own, 40)); // between 30 and 50
    fixture.detectChanges();
    expect(parent.activeInsert()).toBe(2);

    session.set(gapSession(els[0], own, 60)); // past all → end
    fixture.detectChanges();
    expect(parent.activeInsert()).toBe(3);
  });

  it('handles variable item heights (centers are per-item, not assumed uniform)', () => {
    const { fixture, parent, els, host, session } = render();
    // heights 20 / 60 / 20 → centers 10 / 50 / 90
    const rects = [
      { top: 0, height: 20 },
      { top: 20, height: 60 },
      { top: 80, height: 20 },
    ];
    els.forEach((el, i) => {
      el.getBoundingClientRect = () =>
        ({
          top: rects[i].top,
          height: rects[i].height,
          bottom: rects[i].top + rects[i].height,
          left: 0,
          width: 100,
          right: 100,
          x: 0,
          y: rects[i].top,
          toJSON: () => ({}),
        }) as DOMRect;
    });
    const own = [slot(els[0], host.list._meta.id, 0)];

    session.set(gapSession(els[0], own, 30)); // >10, <50 → between items 0 and 1
    fixture.detectChanges();
    expect(parent.activeInsert()).toBe(1);

    session.set(gapSession(els[0], own, 70)); // >50, <90 → between items 1 and 2
    fixture.detectChanges();
    expect(parent.activeInsert()).toBe(2);
  });

  it('only activates when this list owns the innermost target', () => {
    const { fixture, parent, els, host, session } = render();
    stubCenters(els);
    const other = Symbol('other');

    session.set(gapSession(els[0], [slot(els[2], host.list._meta.id, 2)], 40));
    fixture.detectChanges();
    expect(parent.activeInsert()).toBe(2);

    // a foreign reorderable owns the innermost slot → no gap for this list
    session.set(
      gapSession(els[0], [slot(document.createElement('ul'), other, 9)], 40),
    );
    fixture.detectChanges();
    expect(parent.activeInsert()).toBeNull();
  });

  it('reports the dragged source size (captured at drag start) only while dragging', () => {
    const { parent, els, host, session } = render();
    parent._setDraggedSize(40); // the source item records this in onDragStart
    session.set(gapSession(els[0], [slot(els[1], host.list._meta.id, 1)]));
    expect(parent.gapSize()).toBe(40);
    session.set(null);
    expect(parent.gapSize()).toBe(0);
  });

  it('opens an equal gap at the insert index and pulls the source from flow (net-zero)', () => {
    const { fixture, parent, els, host, session } = render();
    stubCenters(els);
    parent._setDraggedSize(40);
    const own = [slot(els[1], host.list._meta.id, 1)];

    // pointer at y=40 → between centers 30 and 50 → insert index 2
    session.set(gapSession(els[0], own, 40));
    fixture.detectChanges();

    expect(els[2].style.marginBlockStart).toBe('40px'); // gap before the insert item
    expect(els[1].style.marginBlockStart).toBe(''); // others unchanged
    expect(els[0].style.display).toBe('none'); // source removed from flow → no height growth

    session.set(null);
    fixture.detectChanges();
    expect(els[2].style.marginBlockStart).toBe('');
    expect(els[0].style.display).toBe('');
  });

  it('opens the gap AFTER the last item when inserting at the end', () => {
    const { fixture, parent, els, host, session } = render();
    stubCenters(els);
    parent._setDraggedSize(40);
    const own = [slot(els[2], host.list._meta.id, 2)];

    // pointer past all centers (y=60 > 50) → insert at end (index 3)
    session.set(gapSession(els[0], own, 60));
    fixture.detectChanges();

    expect(els[2].style.marginBlockEnd).toBe('40px'); // gap after the last item
    expect(els[2].style.marginBlockStart).toBe(''); // not before it
    expect(els[1].style.marginBlockEnd).toBe('');
  });

  it('suppresses the indicator line in gap mode', async () => {
    const { fixture, els, host, session } = render();
    await fixture.whenStable(); // would-be indicator is created in afterNextRender
    session.set(gapSession(els[0], [slot(els[1], host.list._meta.id, 1, 'top')]));
    fixture.detectChanges();
    expect(els[1].querySelector('.line')).toBeNull();
  });
});

describe('reorderable — indicator nesting & empty lists', () => {
  function drag(targets: DropTargetHit[]): DragSession {
    return {
      sourceEl: document.createElement('div'),
      sourceData: boxData<Card>({ id: 9 }),
      targets,
      pointer: { x: 0, y: 0 },
      kind: 'transfer',
    };
  }

  it('suppresses an item indicator when a deeper (nested) target is innermost (#3)', async () => {
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      providers: [provideDnd({ plugins: { hitbox: stubHitbox } })],
    });
    const fixture = TestBed.createComponent(Host);
    fixture.detectChanges();
    await fixture.whenStable();
    const firstEl = fixture.debugElement
      .queryAll(By.directive(ReorderableItem))[0]
      .nativeElement as HTMLElement;
    const session = TestBed.runInInjectionContext(() => injectDndSession());
    const id = fixture.componentInstance.list._meta.id;
    const nested = document.createElement('div');

    // a deeper/foreign reorderable owns the innermost slot → the outer draws no line
    session.set(
      drag([
        {
          element: nested,
          data: boxData({
            reorderableId: Symbol('inner'),
            group: undefined,
            index: 0,
          }),
        },
        {
          element: firstEl,
          data: boxData({ reorderableId: id, group: undefined, index: 0 }),
        },
      ]),
    );
    fixture.detectChanges();
    expect(firstEl.querySelector('.line')).toBeNull();

    // this list's own item is innermost → it draws the line
    session.set(
      drag([
        {
          element: firstEl,
          data: boxData({ reorderableId: id, group: undefined, index: 0 }),
        },
      ]),
    );
    fixture.detectChanges();
    expect(firstEl.querySelector('.line')?.getAttribute('data-edge')).toBe('top');
  });

  it('renders a container indicator for an empty list (#2)', async () => {
    @Component({
      selector: 'mm-reorderable-empty-host',
      imports: [Reorderable, ReorderableItem],
      template: `
        <ul [mmReorderable]="list">
          @for (c of list.items(); track c.id) {
            <li [mmReorderableItem]="c"></li>
          }
        </ul>
      `,
    })
    class EmptyHost {
      readonly cards = signal<Card[]>([]);
      readonly list = reorderable(this.cards, { accepts: isCard, key: (c) => c.id });
    }

    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      providers: [provideDnd({ plugins: { hitbox: stubHitbox } })],
    });
    const fixture = TestBed.createComponent(EmptyHost);
    fixture.detectChanges();
    await fixture.whenStable(); // container indicator created in afterNextRender
    const ul = fixture.debugElement.query(By.directive(Reorderable))
      .nativeElement as HTMLElement;
    const session = TestBed.runInInjectionContext(() => injectDndSession());
    const id = fixture.componentInstance.list._meta.id;

    expect(ul.querySelector('.line')).toBeNull(); // idle

    // hovering the empty list → container slot index 0 → container shows the line
    session.set(
      drag([
        {
          element: ul,
          data: boxData({ reorderableId: id, group: undefined, index: 0 }),
        },
      ]),
    );
    fixture.detectChanges();
    expect(ul.querySelector('.line')?.getAttribute('data-edge')).toBe('top');
  });
});
