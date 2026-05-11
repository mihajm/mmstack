import { ElementRef, PLATFORM_ID } from '@angular/core';
import { TestBed } from '@angular/core/testing';

import type { draggable as PDDraggable } from '@atlaskit/pragmatic-drag-and-drop/element/adapter';

import { draggable } from './draggable';
import { unboxDragData } from './internal';

type CapturedArgs = Parameters<typeof PDDraggable>[0];

const draggableMock = vi.fn();
const cleanupMock = vi.fn();

vi.mock('@atlaskit/pragmatic-drag-and-drop/element/adapter', () => ({
  draggable: (args: CapturedArgs) => {
    draggableMock(args);
    return cleanupMock;
  },
  dropTargetForElements: vi.fn(() => () => undefined),
  monitorForElements: vi.fn(() => () => undefined),
}));

function createHostElement() {
  const el = document.createElement('div');
  document.body.appendChild(el);
  return el;
}

function setup<T>(data: T) {
  const element = createHostElement();
  TestBed.configureTestingModule({
    providers: [{ provide: ElementRef, useValue: new ElementRef(element) }],
  });
  return TestBed.runInInjectionContext(() => {
    const ref = draggable<T>({ data });
    TestBed.tick();
    return { ref, element, args: draggableMock.mock.calls.at(-1)?.[0] as CapturedArgs };
  });
}

describe('draggable', () => {
  beforeEach(() => {
    draggableMock.mockReset();
    cleanupMock.mockReset();
  });

  it('registers with the injected host element', () => {
    const { element, args } = setup({ id: 1 });
    expect(args.element).toBe(element);
  });

  it('boxes initial data under the drag-data symbol', () => {
    const { args } = setup({ id: 'a' });
    const boxed = args.getInitialData?.({
      input: {} as never,
      element: {} as never,
      dragHandle: null,
    });
    expect(unboxDragData(boxed ?? {})).toEqual({ id: 'a' });
  });

  it('flips the dragging signal on drag start and drop', () => {
    const { ref, args } = setup({ id: 'x' });
    expect(ref.dragging()).toBe(false);

    args.onDragStart?.({
      source: { element: {} as HTMLElement, dragHandle: null, data: {} },
      location: { initial: {} as never, current: {} as never, previous: { dropTargets: [] } },
    });
    expect(ref.dragging()).toBe(true);

    args.onDrop?.({
      source: { element: {} as HTMLElement, dragHandle: null, data: {} },
      location: {
        initial: {} as never,
        current: { input: {} as never, dropTargets: [] },
        previous: { dropTargets: [] },
      },
    });
    expect(ref.dragging()).toBe(false);
  });

  it('invokes consumer onDrop with current data', () => {
    const data = { id: 'snap' };
    const element = createHostElement();
    const onDrop = vi.fn();
    TestBed.configureTestingModule({
      providers: [{ provide: ElementRef, useValue: new ElementRef(element) }],
    });
    TestBed.runInInjectionContext(() => {
      draggable({ data, onDrop });
      TestBed.tick();
    });
    const args = draggableMock.mock.calls.at(-1)?.[0] as CapturedArgs;
    args.onDrop?.({
      source: { element, dragHandle: null, data: {} },
      location: {
        initial: {} as never,
        current: { input: {} as never, dropTargets: [] },
        previous: { dropTargets: [] },
      },
    });
    expect(onDrop).toHaveBeenCalledWith(
      expect.objectContaining({ data }),
    );
  });

  it('returns inert signals on the server platform', () => {
    const element = createHostElement();
    TestBed.configureTestingModule({
      providers: [
        { provide: ElementRef, useValue: new ElementRef(element) },
        { provide: PLATFORM_ID, useValue: 'server' },
      ],
    });
    TestBed.runInInjectionContext(() => {
      const ref = draggable({ data: { x: 1 } });
      expect(ref.dragging()).toBe(false);
      expect(ref.data()).toEqual({ x: 1 });
    });
    expect(draggableMock).not.toHaveBeenCalled();
  });
});
