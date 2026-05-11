import { Component, signal, type WritableSignal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import type {
  draggable as pdDraggable,
  dropTargetForElements as pdDropTarget,
} from '@atlaskit/pragmatic-drag-and-drop/element/adapter';

import { boxDragData } from './internal';
import {
  reorderable,
  Reorderable,
  ReorderableItem,
  REORDERABLE_GROUP_KEY,
  REORDERABLE_ID_KEY,
  type ReorderableRef,
} from './reorderable';

type DraggableArgs = Parameters<typeof pdDraggable>[0];
type DropTargetArgs = Parameters<typeof pdDropTarget>[0];

const draggableMock = vi.fn();
const dropTargetMock = vi.fn();
const cleanup = vi.fn();

vi.mock('@atlaskit/pragmatic-drag-and-drop/element/adapter', () => ({
  draggable: (args: DraggableArgs) => {
    draggableMock(args);
    return cleanup;
  },
  dropTargetForElements: (args: DropTargetArgs) => {
    dropTargetMock(args);
    return cleanup;
  },
  monitorForElements: vi.fn(() => () => undefined),
}));

vi.mock('@atlaskit/pragmatic-drag-and-drop-hitbox/closest-edge', () => ({
  attachClosestEdge: (data: Record<string | symbol, unknown>) => data,
  extractClosestEdge: () => null,
}));

type Item = { id: number; label: string };
const isItem = (d: unknown): d is Item =>
  !!d && typeof d === 'object' && 'id' in d && 'label' in d;

@Component({
  selector: 'mm-test-list',
  imports: [Reorderable, ReorderableItem],
  template: `
    <ul [mmReorderable]="list">
      @for (item of list.items(); track list.key(item)) {
        <li [mmReorderableItem]="item">{{ item.label }}</li>
      }
    </ul>
  `,
})
class TestList {
  items!: WritableSignal<Item[]>;
  list!: ReorderableRef<Item>;
}

function createTestList(initial: Item[], group?: string) {
  const items = signal<Item[]>(initial);
  const fixture = TestBed.createComponent(TestList);
  fixture.componentInstance.items = items;
  fixture.componentInstance.list = TestBed.runInInjectionContext(() =>
    reorderable(items, { accepts: isItem, key: (i) => i.id, group }),
  );
  fixture.detectChanges();
  return { fixture, items };
}

function nthDropTargetCall(n: number): DropTargetArgs {
  return dropTargetMock.mock.calls.at(n)?.[0] as DropTargetArgs;
}

function sourceFor(meta: { id: symbol; group?: string }, data: Item) {
  return {
    element: document.createElement('div'),
    dragHandle: null,
    data: {
      ...boxDragData(data),
      [REORDERABLE_ID_KEY]: meta.id,
      [REORDERABLE_GROUP_KEY]: meta.group,
    },
  };
}

describe('reorderable composable', () => {
  it('exposes a unique meta id per instance', () => {
    const a = TestBed.runInInjectionContext(() =>
      reorderable(signal<Item[]>([]), { accepts: isItem, key: (i) => i.id }),
    );
    const b = TestBed.runInInjectionContext(() =>
      reorderable(signal<Item[]>([]), { accepts: isItem, key: (i) => i.id }),
    );
    expect(a._meta.id).not.toBe(b._meta.id);
  });
});

describe('same-list reorder', () => {
  beforeEach(() => {
    draggableMock.mockReset();
    dropTargetMock.mockReset();
    cleanup.mockReset();
  });

  it('moves an item down via item drop target onDrop', () => {
    const { fixture, items } = createTestList([
      { id: 1, label: 'A' },
      { id: 2, label: 'B' },
      { id: 3, label: 'C' },
      { id: 4, label: 'D' },
    ]);
    const meta = fixture.componentInstance.list._meta;

    // dropTarget call indices: 0 = container, 1..N = items
    const itemDDropTarget = nthDropTargetCall(4); // D at items[3]

    // Drop A onto D (insertAt resolves to 3 → A moves to index 2)
    itemDDropTarget.onDrop?.({
      source: sourceFor(meta, { id: 1, label: 'A' }),
      self: {
        element: document.createElement('div'),
        data: {},
        dropEffect: 'move' as const,
        isActiveDueToStickiness: false,
      },
      location: {
        initial: {} as never,
        current: {
          input: {} as never,
          dropTargets: [
            { element: document.createElement('div'), data: {}, dropEffect: 'move' as const, isActiveDueToStickiness: false },
          ],
        },
        previous: { dropTargets: [] },
      },
    });

    expect(items().map((i) => i.id)).toEqual([2, 3, 1, 4]);
  });

  it('moves an item to the end via the container when it is innermost', () => {
    const { fixture, items } = createTestList([
      { id: 1, label: 'A' },
      { id: 2, label: 'B' },
      { id: 3, label: 'C' },
    ]);
    const meta = fixture.componentInstance.list._meta;
    const containerDropTarget = nthDropTargetCall(0);
    const containerEl = fixture.nativeElement.querySelector('ul') as HTMLElement;

    containerDropTarget.onDrop?.({
      source: sourceFor(meta, { id: 1, label: 'A' }),
      self: {
        element: containerEl,
        data: {},
        dropEffect: 'move' as const,
        isActiveDueToStickiness: false,
      },
      location: {
        initial: {} as never,
        current: {
          input: {} as never,
          // container is innermost (no item under cursor)
          dropTargets: [
            { element: containerEl, data: {}, dropEffect: 'move' as const, isActiveDueToStickiness: false },
          ],
        },
        previous: { dropTargets: [] },
      },
    });

    expect(items().map((i) => i.id)).toEqual([2, 3, 1]);
  });

  it('skips container onDrop when an item drop target is innermost', () => {
    const { fixture, items } = createTestList([
      { id: 1, label: 'A' },
      { id: 2, label: 'B' },
    ]);
    const meta = fixture.componentInstance.list._meta;
    const containerDropTarget = nthDropTargetCall(0);
    const containerEl = fixture.nativeElement.querySelector('ul') as HTMLElement;
    const itemEl = fixture.nativeElement.querySelector('li') as HTMLElement;

    // Simulate an item dispatching its drop first (items signal already updated)
    items.set([{ id: 2, label: 'B' }, { id: 1, label: 'A' }]);

    // Now the container's onDrop fires with an item as the innermost target
    containerDropTarget.onDrop?.({
      source: sourceFor(meta, { id: 1, label: 'A' }),
      self: {
        element: containerEl,
        data: {},
        dropEffect: 'move' as const,
        isActiveDueToStickiness: false,
      },
      location: {
        initial: {} as never,
        current: {
          input: {} as never,
          dropTargets: [
            { element: itemEl, data: {}, dropEffect: 'move' as const, isActiveDueToStickiness: false },
            { element: containerEl, data: {}, dropEffect: 'move' as const, isActiveDueToStickiness: false },
          ],
        },
        previous: { dropTargets: [] },
      },
    });

    // container did not double-move
    expect(items().map((i) => i.id)).toEqual([2, 1]);
  });
});

describe('cross-list reorder', () => {
  beforeEach(() => {
    draggableMock.mockReset();
    dropTargetMock.mockReset();
    cleanup.mockReset();
  });

  it('inserts on target and removes on source when groups match', () => {
    const todoItems = signal<Item[]>([
      { id: 1, label: 'T1' },
      { id: 2, label: 'T2' },
    ]);
    const doneItems = signal<Item[]>([{ id: 3, label: 'D1' }]);

    const todoFixture = TestBed.createComponent(TestList);
    todoFixture.componentInstance.items = todoItems;
    todoFixture.componentInstance.list = TestBed.runInInjectionContext(() =>
      reorderable(todoItems, {
        accepts: isItem,
        key: (i) => i.id,
        group: 'kanban',
      }),
    );
    todoFixture.detectChanges();
    const todoMeta = todoFixture.componentInstance.list._meta;

    // Capture the source draggable for item T1 (id=1) before resetting
    // (it's the first draggable registered for the todo list)
    const todoT1Draggable = draggableMock.mock.calls[0]?.[0] as DraggableArgs;

    // Spawn the done list — its drop targets register after
    dropTargetMock.mockReset();
    const doneFixture = TestBed.createComponent(TestList);
    doneFixture.componentInstance.items = doneItems;
    doneFixture.componentInstance.list = TestBed.runInInjectionContext(() =>
      reorderable(doneItems, {
        accepts: isItem,
        key: (i) => i.id,
        group: 'kanban',
      }),
    );
    doneFixture.detectChanges();
    const doneItemD1DropTarget = nthDropTargetCall(1); // call 0 is doneList container, 1 is D1
    const doneItemEl = doneFixture.nativeElement.querySelector('li') as HTMLElement;

    // Step 1: target item's onDrop fires — inserts T1 into doneList
    doneItemD1DropTarget.onDrop?.({
      source: sourceFor(todoMeta, { id: 1, label: 'T1' }),
      self: {
        element: doneItemEl,
        data: {},
        dropEffect: 'move' as const,
        isActiveDueToStickiness: false,
      },
      location: {
        initial: {} as never,
        current: {
          input: {} as never,
          dropTargets: [
            { element: doneItemEl, data: {}, dropEffect: 'move' as const, isActiveDueToStickiness: false },
          ],
        },
        previous: { dropTargets: [] },
      },
    });

    expect(doneItems().map((i) => i.id)).toEqual([1, 3]);

    // Step 2: source draggable's onDrop fires — removes T1 from todoList
    todoT1Draggable.onDrop?.({
      source: { element: document.createElement('div'), dragHandle: null, data: {} },
      location: {
        initial: {} as never,
        current: {
          input: {} as never,
          dropTargets: [
            {
              element: doneItemEl,
              data: {
                reorderableId: doneFixture.componentInstance.list._meta.id,
                group: 'kanban',
                index: 0,
              },
              dropEffect: 'move' as const,
              isActiveDueToStickiness: false,
            },
          ],
        },
        previous: { dropTargets: [] },
      },
    });

    expect(todoItems().map((i) => i.id)).toEqual([2]);
  });

  it('canDrop rejects drops from non-reorderable sources', () => {
    const { fixture } = createTestList([{ id: 1, label: 'A' }], 'kanban');
    const itemDropTarget = nthDropTargetCall(1);

    const ok = itemDropTarget.canDrop?.({
      input: {} as never,
      source: {
        element: document.createElement('div'),
        dragHandle: null,
        // no REORDERABLE_ID_KEY in source.data
        data: boxDragData({ id: 99, label: 'Z' }),
      },
      element: fixture.nativeElement.querySelector('li') as HTMLElement,
    });

    expect(ok).toBe(false);
  });

  it('canDrop rejects drops from a different group', () => {
    const { fixture } = createTestList([{ id: 1, label: 'A' }], 'kanban');
    const itemDropTarget = nthDropTargetCall(1);
    const otherListMeta = { id: Symbol('other'), group: 'other' };

    const ok = itemDropTarget.canDrop?.({
      input: {} as never,
      source: sourceFor(otherListMeta, { id: 99, label: 'Z' }),
      element: fixture.nativeElement.querySelector('li') as HTMLElement,
    });

    expect(ok).toBe(false);
  });

  it('canDrop allows same group', () => {
    const { fixture } = createTestList([{ id: 1, label: 'A' }], 'kanban');
    const itemDropTarget = nthDropTargetCall(1);
    const otherListMeta = { id: Symbol('other-but-same-group'), group: 'kanban' };

    const ok = itemDropTarget.canDrop?.({
      input: {} as never,
      source: sourceFor(otherListMeta, { id: 99, label: 'Z' }),
      element: fixture.nativeElement.querySelector('li') as HTMLElement,
    });

    expect(ok).toBe(true);
  });

  it('canDrop allows same-instance drops even without a group set', () => {
    const { fixture } = createTestList([{ id: 1, label: 'A' }]);
    const meta = fixture.componentInstance.list._meta;
    const itemDropTarget = nthDropTargetCall(1);

    const ok = itemDropTarget.canDrop?.({
      input: {} as never,
      source: sourceFor(meta, { id: 1, label: 'A' }),
      element: fixture.nativeElement.querySelector('li') as HTMLElement,
    });

    expect(ok).toBe(true);
  });
});

// keep the previous shape-level test for documentation
describe('reorderable key symbols', () => {
  it('symbols are stable and distinct', () => {
    expect(typeof REORDERABLE_ID_KEY).toBe('symbol');
    expect(typeof REORDERABLE_GROUP_KEY).toBe('symbol');
    expect(REORDERABLE_ID_KEY).not.toBe(REORDERABLE_GROUP_KEY);
  });
});

