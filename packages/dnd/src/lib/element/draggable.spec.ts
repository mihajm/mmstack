import { ElementRef, PLATFORM_ID, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import type { draggable as PDDraggable } from '@atlaskit/pragmatic-drag-and-drop/element/adapter';

import { draggable } from './draggable';
import { unboxData } from '../internal/payload';
import { provideDnd, type HitboxPlugin } from '../provide';
import { DndSession, type DragSession } from '../session';
import type { DropEvent } from '../internal/types';

type DraggableConfig = Parameters<typeof PDDraggable>[0];

const draggableMock = vi.fn();
const cleanupMock = vi.fn();

vi.mock('@atlaskit/pragmatic-drag-and-drop/element/adapter', () => ({
  draggable: (config: DraggableConfig) => {
    draggableMock(config);
    return cleanupMock;
  },
  dropTargetForElements: vi.fn(() => () => undefined),
  monitorForElements: vi.fn(() => () => undefined),
}));

const stubHitbox: HitboxPlugin = {
  attachClosestEdge: (data) => data,
  extractClosestEdge: () => 'left',
};

function setup<T>(
  data: T,
  opts: { providers?: unknown[]; onDrop?: (e: DropEvent<T>) => void } = {},
) {
  const element = document.createElement('div');
  document.body.appendChild(element);
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({
    providers: [
      { provide: ElementRef, useValue: new ElementRef(element) },
      ...((opts.providers ?? []) as never[]),
    ],
  });
  return TestBed.runInInjectionContext(() => {
    const session = TestBed.inject(DndSession).session;
    const ref = draggable<T>({ data, onDrop: opts.onDrop });
    return {
      ref,
      element,
      session,
      config: draggableMock.mock.calls.at(-1)?.[0] as DraggableConfig,
    };
  });
}

function sessionFor(sourceEl: HTMLElement): DragSession {
  return {
    sourceEl,
    sourceData: {},
    targets: [],
    pointer: { x: 0, y: 0 },
    kind: 'transfer',
  };
}

describe('draggable', () => {
  beforeEach(() => {
    draggableMock.mockReset();
    cleanupMock.mockReset();
  });

  it('registers once with the injected host element', () => {
    const { element, config } = setup({ id: 1 });
    expect(config.element).toBe(element);
    expect(draggableMock).toHaveBeenCalledTimes(1);
  });

  it('boxes initial data under the drag-data symbol (read lazily)', () => {
    const { config } = setup({ id: 'a' });
    const boxed = config.getInitialData?.({
      input: {} as never,
      element: {} as never,
      dragHandle: null,
    });
    expect(unboxData(boxed ?? {})).toEqual({ id: 'a' });
  });

  it('derives `dragging` from the ambient session (no writable signal)', () => {
    const { ref, element, session } = setup({ id: 'x' });
    expect(ref.dragging()).toBe(false);

    session.set(sessionFor(element));
    expect(ref.dragging()).toBe(true);

    session.set(sessionFor(document.createElement('div')));
    expect(ref.dragging()).toBe(false);

    session.set(null);
    expect(ref.dragging()).toBe(false);
  });

  it('reports the drop edge via the resolved hitbox plugin', () => {
    const dropped: DropEvent<{ id: string }>[] = [];
    const { config } = setup(
      { id: 'x' },
      {
        providers: [provideDnd({ plugins: { hitbox: stubHitbox } })],
        onDrop: (e) => dropped.push(e),
      },
    );
    config.onDrop?.({
      source: { element: {} as HTMLElement, dragHandle: null, data: {} },
      location: {
        initial: {} as never,
        current: {
          input: {} as never,
          dropTargets: [{ element: {} as Element, data: {}, dropEffect: 'move', isActiveDueToStickiness: false }],
        },
        previous: { dropTargets: [] },
      },
    });
    expect(dropped).toHaveLength(1);
    expect(dropped[0].edge).toBe('left');
  });

  it('returns an inert ref on the server', () => {
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      providers: [
        { provide: ElementRef, useValue: new ElementRef(document.createElement('div')) },
        { provide: PLATFORM_ID, useValue: 'server' },
      ],
    });
    const { ref } = TestBed.runInInjectionContext(() => {
      const session = TestBed.inject(DndSession).session;
      const r = draggable({ data: { id: 1 } });
      return { ref: r, session };
    });
    expect(ref.dragging()).toBe(false);
    expect(draggableMock).not.toHaveBeenCalled();
  });
});

describe('draggable — options, callbacks & lazy reads', () => {
  beforeEach(() => {
    draggableMock.mockReset();
    cleanupMock.mockReset();
  });

  function build<T>(opts: Parameters<typeof draggable<T>>[0]) {
    const element = document.createElement('div');
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      providers: [{ provide: ElementRef, useValue: new ElementRef(element) }],
    });
    return TestBed.runInInjectionContext(() => {
      TestBed.inject(DndSession);
      const ref = draggable<T>(opts);
      return {
        ref,
        element,
        config: draggableMock.mock.calls.at(-1)?.[0] as DraggableConfig,
      };
    });
  }

  it('forwards canDrag (and omits it when not provided)', () => {
    expect(
      build({ data: { id: 1 }, canDrag: () => false }).config.canDrag?.(
        {} as never,
      ),
    ).toBe(false);
    expect(build({ data: { id: 1 } }).config.canDrag).toBeUndefined();
  });

  it('wires onGenerateDragPreview only when a preview is configured', () => {
    expect(build({ data: { id: 1 } }).config.onGenerateDragPreview).toBeUndefined();
    const withPreview = build({
      data: { id: 1 },
      preview: { render: () => undefined },
    });
    expect(withPreview.config.onGenerateDragPreview).toBeDefined();
  });

  it('fires onDragStart with data, meta and the source element', () => {
    const KIND = Symbol('kind');
    const events: unknown[] = [];
    const el = document.createElement('span');
    const { config } = build<{ id: string }>({
      data: { id: 'a' },
      meta: () => ({ [KIND]: 'todo' }),
      onDragStart: (e) => events.push(e),
    });
    config.onDragStart?.({
      source: { element: el, dragHandle: null, data: {} },
      location: {
        initial: {} as never,
        current: { input: {} as never, dropTargets: [] },
        previous: { dropTargets: [] },
      },
    });
    expect(events).toEqual([
      { data: { id: 'a' }, meta: { [KIND]: 'todo' }, element: el },
    ]);
  });

  it('reads data lazily — getInitialData reflects the latest signal value', () => {
    const data = signal({ id: 'a' });
    const { config } = build({ data });
    data.set({ id: 'b' });
    const boxed = config.getInitialData?.({
      input: {} as never,
      element: {} as never,
      dragHandle: null,
    });
    expect(unboxData(boxed ?? {})).toEqual({ id: 'b' });
  });

  it('merges meta symbols into the initial data', () => {
    const KIND = Symbol('kind');
    const { config } = build<{ id: number }>({
      data: { id: 1 },
      meta: () => ({ [KIND]: 'x' }),
    });
    const boxed = (config.getInitialData?.({
      input: {} as never,
      element: {} as never,
      dragHandle: null,
    }) ?? {}) as Record<string | symbol, unknown>;
    expect(unboxData(boxed)).toEqual({ id: 1 });
    expect(boxed[KIND]).toBe('x');
  });

  it('reports a null drop edge when no hitbox is registered', () => {
    const dropped: DropEvent<{ id: number }>[] = [];
    const { config } = build({ data: { id: 1 }, onDrop: (e) => dropped.push(e) });
    config.onDrop?.({
      source: { element: {} as HTMLElement, dragHandle: null, data: {} },
      location: {
        initial: {} as never,
        current: {
          input: {} as never,
          dropTargets: [{ element: {} as Element, data: {}, dropEffect: 'move', isActiveDueToStickiness: false }],
        },
        previous: { dropTargets: [] },
      },
    });
    expect(dropped[0].edge).toBeNull();
  });
});
