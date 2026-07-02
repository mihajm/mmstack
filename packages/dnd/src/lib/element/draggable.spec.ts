import { ElementRef, PLATFORM_ID, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { trackRuns } from '../testing/reactivity';
import { makeDragSession } from '../testing/drag-session';
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
  return makeDragSession({ sourceEl });
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

  it('drops with NO targets → null edge + empty location (non-happy)', () => {
    const dropped: DropEvent<{ id: number }>[] = [];
    const { config } = build({ data: { id: 1 }, onDrop: (e) => dropped.push(e) });
    config.onDrop?.({
      source: { element: {} as HTMLElement, dragHandle: null, data: {} },
      location: {
        initial: {} as never,
        current: { input: {} as never, dropTargets: [] },
        previous: { dropTargets: [] },
      },
    });
    expect(dropped[0].edge).toBeNull();
    expect(dropped[0].location.current).toEqual([]);
  });

  it('canDrag gate is forwarded live (reflects the latest value)', () => {
    const allow = signal(true);
    const { config } = build({ data: { id: 1 }, canDrag: () => allow() });
    expect(config.canDrag?.({} as never)).toBe(true);
    allow.set(false);
    expect(config.canDrag?.({} as never)).toBe(false); // read lazily, not snapshotted
  });
});

describe('draggable — reactivity & single registration', () => {
  beforeEach(() => {
    draggableMock.mockReset();
    cleanupMock.mockReset();
  });

  it('registers exactly once even as data / meta / canDrag signals churn', () => {
    const data = signal({ id: 1 });
    const meta = signal({ k: 'a' });
    const element = document.createElement('div');
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      providers: [{ provide: ElementRef, useValue: new ElementRef(element) }],
    });
    TestBed.runInInjectionContext(() => {
      TestBed.inject(DndSession);
      draggable({ data, meta: () => meta() });
    });
    expect(draggableMock).toHaveBeenCalledTimes(1);
    data.set({ id: 2 });
    meta.set({ k: 'b' });
    TestBed.tick();
    expect(draggableMock).toHaveBeenCalledTimes(1); // options are read lazily, never re-register
  });

  it('`dragging` stays stable across frames while this element remains the source', () => {
    const { ref, element, session } = setup({ id: 1 });
    const runs = trackRuns(() => ref.dragging());
    TestBed.tick();
    expect(runs()).toBe(1);

    session.set(sessionFor(element));
    TestBed.tick();
    expect(runs()).toBe(2); // false → true

    // frames: same source element, moving pointer → boolean unchanged
    for (let i = 1; i <= 4; i++) {
      session.set({ ...sessionFor(element), pointer: { x: i, y: i } });
      TestBed.tick();
    }
    expect(runs()).toBe(2); // no churn — the equality gate on the boolean holds

    session.set(null);
    TestBed.tick();
    expect(runs()).toBe(3); // true → false
  });
});

describe('draggable — reactive drag handle (re-registration)', () => {
  beforeEach(() => {
    draggableMock.mockReset();
    cleanupMock.mockReset();
  });

  it('re-registers only when the handle element actually changes, tearing down the old', () => {
    const h1 = document.createElement('button');
    const h2 = document.createElement('button');
    const handle = signal<HTMLElement | undefined>(h1);
    const element = document.createElement('div');
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      providers: [{ provide: ElementRef, useValue: new ElementRef(element) }],
    });
    TestBed.runInInjectionContext(() => {
      TestBed.inject(DndSession);
      draggable({ data: { id: 1 }, dragHandle: handle });
    });
    TestBed.tick(); // flush the afterRenderEffect
    expect(draggableMock).toHaveBeenCalledTimes(1);
    expect((draggableMock.mock.calls.at(-1)?.[0] as DraggableConfig).dragHandle).toBe(h1);

    handle.set(h2);
    TestBed.tick();
    expect(cleanupMock).toHaveBeenCalledTimes(1); // old registration torn down
    expect(draggableMock).toHaveBeenCalledTimes(2);
    expect((draggableMock.mock.calls.at(-1)?.[0] as DraggableConfig).dragHandle).toBe(h2);

    // re-setting the same element must NOT churn a re-register
    handle.set(h2);
    TestBed.tick();
    expect(draggableMock).toHaveBeenCalledTimes(2);
  });

  it('tolerates the handle becoming undefined (whole element draggable again)', () => {
    const h1 = document.createElement('button');
    const handle = signal<HTMLElement | undefined>(h1);
    const element = document.createElement('div');
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      providers: [{ provide: ElementRef, useValue: new ElementRef(element) }],
    });
    TestBed.runInInjectionContext(() => {
      TestBed.inject(DndSession);
      draggable({ data: { id: 1 }, dragHandle: handle });
    });
    TestBed.tick();
    handle.set(undefined);
    TestBed.tick();
    expect(draggableMock).toHaveBeenCalledTimes(2);
    expect((draggableMock.mock.calls.at(-1)?.[0] as DraggableConfig).dragHandle).toBeUndefined();
  });
});

function pe(type: string, x = 0, y = 0, id = 1): Event {
  const e = new Event(type, { bubbles: true }) as Event & Record<string, unknown>;
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

describe('draggable — pointer engine', () => {
  beforeEach(() => {
    draggableMock.mockReset();
    cleanupMock.mockReset();
  });

  function setupPointer(
    opts: {
      onDrop?: (e: DropEvent<{ id: string }>) => void;
      canDrag?: () => boolean;
    } = {},
  ) {
    const element = document.createElement('div');
    document.body.appendChild(element);
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      providers: [{ provide: ElementRef, useValue: new ElementRef(element) }],
    });
    const { ref, session } = TestBed.runInInjectionContext(() => {
      const session = TestBed.inject(DndSession).session;
      const r = draggable<{ id: string }>({
        data: { id: 'x' },
        engine: 'pointer',
        canDrag: opts.canDrag,
        onDrop: opts.onDrop,
      });
      return { ref: r, session };
    });
    return { element, ref, session };
  }

  it('uses the pointer engine (never registers with pragmatic)', () => {
    setupPointer();
    expect(draggableMock).not.toHaveBeenCalled();
  });

  it('a gesture drives the unified session (engine:"pointer") + follows the pointer, then drops', () => {
    const drops: DropEvent<{ id: string }>[] = [];
    const { element, ref, session } = setupPointer({ onDrop: (e) => drops.push(e) });

    expect(ref.dragging()).toBe(false);
    element.dispatchEvent(pe('pointerdown', 0, 0));
    element.dispatchEvent(pe('pointermove', 20, 5)); // past the 5px threshold
    TestBed.tick();

    expect(session()?.engine).toBe('pointer');
    expect(session()?.sourceEl).toBe(element);
    expect(ref.dragging()).toBe(true);
    expect(element.style.transform).toContain('translate'); // source follows pointer

    element.dispatchEvent(pe('pointerup', 20, 5));
    TestBed.tick();

    expect(session()).toBeNull();
    expect(element.style.transform).toBe(''); // preview cleared
    expect(ref.dragging()).toBe(false);
    expect(drops).toHaveLength(1);
    expect(drops[0].data).toEqual({ id: 'x' });
  });

  it('Escape aborts: session cleared, transform reset, onDrop fires with an EMPTY stack (native parity)', () => {
    const drops: DropEvent<{ id: string }>[] = [];
    const { element, ref, session } = setupPointer({ onDrop: (e) => drops.push(e) });

    element.dispatchEvent(pe('pointerdown', 0, 0));
    element.dispatchEvent(pe('pointermove', 20, 5));
    TestBed.tick();
    expect(ref.dragging()).toBe(true);

    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    TestBed.tick();

    expect(session()).toBeNull();
    expect(ref.dragging()).toBe(false);
    expect(element.style.transform).toBe('');
    expect(drops).toHaveLength(1);
    expect(drops[0].location.current).toEqual([]); // aborted → no targets
  });

  it('canDrag=false vetoes the whole gesture — flipping true mid-gesture cannot start a drag', () => {
    const allowed = signal(false);
    const { element, session } = setupPointer({ canDrag: () => allowed() });

    element.dispatchEvent(pe('pointerdown', 0, 0));
    element.dispatchEvent(pe('pointermove', 20, 5));
    TestBed.tick();
    expect(session()).toBeNull(); // denied at activation

    allowed.set(true); // permission arrives mid-gesture
    element.dispatchEvent(pe('pointermove', 30, 5));
    TestBed.tick();
    expect(session()).toBeNull(); // still denied — latched for this gesture

    element.dispatchEvent(pe('pointerup', 30, 5));
    TestBed.tick();

    // a fresh gesture re-evaluates the gate
    element.dispatchEvent(pe('pointerdown', 0, 0, 2));
    element.dispatchEvent(pe('pointermove', 20, 5, 2));
    TestBed.tick();
    expect(session()?.sourceEl).toBe(element);
    element.dispatchEvent(pe('pointerup', 20, 5, 2));
    TestBed.tick();
  });

  it('a custom pointer preview follows the pointer; the source stays put; cleaned up on drop', () => {
    const element = document.createElement('div');
    document.body.appendChild(element);
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      providers: [{ provide: ElementRef, useValue: new ElementRef(element) }],
    });
    let container: HTMLElement | undefined;
    TestBed.runInInjectionContext(() => {
      TestBed.inject(DndSession);
      draggable({
        data: { id: 'x' },
        engine: 'pointer',
        preview: {
          render: (c) => {
            c.textContent = 'PREVIEW';
            container = c;
          },
        },
      });
    });

    element.dispatchEvent(pe('pointerdown', 0, 0));
    element.dispatchEvent(pe('pointermove', 30, 10));
    TestBed.tick();

    expect(container?.textContent).toBe('PREVIEW');
    expect(container?.style.transform).toContain('translate'); // preview follows
    expect(element.style.transform).toBe(''); // ...source is NOT transformed
    expect(document.body.contains(container as HTMLElement)).toBe(true);

    element.dispatchEvent(pe('pointerup', 30, 10));
    TestBed.tick();
    expect(document.body.contains(container as HTMLElement)).toBe(false); // removed
  });
});
