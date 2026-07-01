import { EnvironmentInjector, PLATFORM_ID } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { trackRuns } from '../testing/reactivity';
import { makeDragSession } from '../testing/drag-session';
import type { monitorForElements as PDMonitor } from '@atlaskit/pragmatic-drag-and-drop/element/adapter';

import { monitor } from './monitor';
import { boxData } from '../internal/payload';
import { provideDnd, type HitboxPlugin } from '../provide';
import { DndSession, type DragSession } from '../session';
import type { DropEvent } from '../internal/types';

type MonitorConfig = Parameters<typeof PDMonitor>[0];

const monitorMock = vi.fn();
const cleanupMock = vi.fn();
const configs: MonitorConfig[] = [];

vi.mock('@atlaskit/pragmatic-drag-and-drop/element/adapter', () => ({
  monitorForElements: (config: MonitorConfig) => {
    monitorMock(config);
    configs.push(config);
    return cleanupMock;
  },
  draggable: vi.fn(() => () => undefined),
  dropTargetForElements: vi.fn(() => () => undefined),
}));

type Card = { id: string };
const isCard = (d: unknown): d is Card =>
  !!d && typeof d === 'object' && 'id' in (d as object);

const KIND = Symbol('kind');

function makeSession(
  sourceData: Record<string | symbol, unknown>,
): DragSession {
  return makeDragSession({ sourceData });
}

beforeEach(() => {
  TestBed.resetTestingModule();
  monitorMock.mockClear();
  cleanupMock.mockClear();
  configs.length = 0;
});

describe('monitor — derived state', () => {
  it('derives isDragging/source from the ambient session, filtered by accepts', () => {
    const session = TestBed.inject(DndSession).session;
    const ref = TestBed.runInInjectionContext(() =>
      monitor<Card>({ accepts: isCard }),
    );

    expect(ref.isDragging()).toBe(false);
    expect(ref.source()).toBeUndefined();

    session.set(makeSession(boxData<Card>({ id: 'a' })));
    expect(ref.isDragging()).toBe(true);
    expect(ref.source()?.data).toEqual({ id: 'a' });

    session.set(null);
    expect(ref.isDragging()).toBe(false);
  });

  it('rejects sources that fail the accepts guard', () => {
    const session = TestBed.inject(DndSession).session;
    const ref = TestBed.runInInjectionContext(() =>
      monitor<Card>({ accepts: isCard }),
    );
    session.set(makeSession(boxData('not-a-card')));
    expect(ref.isDragging()).toBe(false);
    expect(ref.source()).toBeUndefined();
  });

  it('accepts any @mmstack source when no accepts guard is given', () => {
    const session = TestBed.inject(DndSession).session;
    const ref = TestBed.runInInjectionContext(() => monitor());
    session.set(makeSession(boxData('anything')));
    expect(ref.isDragging()).toBe(true);
  });

  it('a no-accepts monitor ignores foreign drags with no @mmstack payload (#15)', () => {
    const session = TestBed.inject(DndSession).session;
    const ref = TestBed.runInInjectionContext(() => monitor());
    // a raw/foreign pragmatic drag carries no boxed @mmstack data
    session.set(makeSession({ foreignKey: 1 }));
    expect(ref.isDragging()).toBe(false);
    expect(ref.source()).toBeUndefined(); // never reports active with undefined data
  });

  it('extracts typed meta from the source payload', () => {
    const session = TestBed.inject(DndSession).session;
    const ref = TestBed.runInInjectionContext(() =>
      monitor<Card, { [KIND]: string }>({ accepts: isCard }),
    );
    session.set(
      makeSession({ ...boxData<Card>({ id: 'a' }), [KIND]: 'todo' }),
    );
    expect(ref.source()?.meta[KIND]).toBe('todo');
  });
});

describe('monitor — subscription lifecycle', () => {
  it('does NOT subscribe when no callbacks are supplied', () => {
    TestBed.inject(DndSession); // 1 subscription (the session bridge)
    const before = monitorMock.mock.calls.length;
    TestBed.runInInjectionContext(() => monitor<Card>({ accepts: isCard }));
    expect(monitorMock.mock.calls.length).toBe(before);
  });

  it('subscribes once when a callback is supplied', () => {
    TestBed.inject(DndSession);
    const before = monitorMock.mock.calls.length;
    TestBed.runInInjectionContext(() =>
      monitor<Card>({ accepts: isCard, onDrop: () => undefined }),
    );
    expect(monitorMock.mock.calls.length).toBe(before + 1);
  });

  it('fires onDragStart / onDrop only for accepted sources', () => {
    const started: Card[] = [];
    const dropped: DropEvent<Card>[] = [];
    TestBed.inject(DndSession);
    TestBed.runInInjectionContext(() =>
      monitor<Card>({
        accepts: isCard,
        onDragStart: (e) => started.push(e.data),
        onDrop: (e) => dropped.push(e),
      }),
    );
    const cfg = configs.at(-1) as MonitorConfig;

    // accepted
    cfg.onDragStart?.({
      source: {
        element: document.createElement('div'),
        dragHandle: null,
        data: boxData<Card>({ id: 'a' }),
      },
      location: {
        initial: {} as never,
        current: { input: {} as never, dropTargets: [] },
        previous: { dropTargets: [] },
      },
    });
    // rejected
    cfg.onDragStart?.({
      source: {
        element: document.createElement('div'),
        dragHandle: null,
        data: boxData('nope'),
      },
      location: {
        initial: {} as never,
        current: { input: {} as never, dropTargets: [] },
        previous: { dropTargets: [] },
      },
    });

    expect(started).toEqual([{ id: 'a' }]);

    cfg.onDrop?.({
      source: {
        element: document.createElement('div'),
        dragHandle: null,
        data: boxData<Card>({ id: 'b' }),
      },
      location: {
        initial: {} as never,
        current: { input: {} as never, dropTargets: [] },
        previous: { dropTargets: [] },
      },
    });
    expect(dropped).toHaveLength(1);
    expect(dropped[0].data).toEqual({ id: 'b' });
  });

  it('reports drop edge via the hitbox plugin', () => {
    const stub: HitboxPlugin = {
      attachClosestEdge: (d) => d,
      extractClosestEdge: () => 'bottom',
    };
    const dropped: DropEvent<Card>[] = [];
    TestBed.configureTestingModule({
      providers: [provideDnd({ plugins: { hitbox: stub } })],
    });
    TestBed.inject(DndSession);
    TestBed.runInInjectionContext(() =>
      monitor<Card>({ accepts: isCard, onDrop: (e) => dropped.push(e) }),
    );
    const cfg = configs.at(-1) as MonitorConfig;
    cfg.onDrop?.({
      source: {
        element: document.createElement('div'),
        dragHandle: null,
        data: boxData<Card>({ id: 'b' }),
      },
      location: {
        initial: {} as never,
        current: {
          input: {} as never,
          dropTargets: [
            { element: document.createElement('div'), data: {}, dropEffect: 'move', isActiveDueToStickiness: false },
          ],
        },
        previous: { dropTargets: [] },
      },
    });
    expect(dropped[0].edge).toBe('bottom');
  });

  it('returns inert signals on the server', () => {
    TestBed.configureTestingModule({
      providers: [{ provide: PLATFORM_ID, useValue: 'server' }],
    });
    const ref = TestBed.runInInjectionContext(() =>
      monitor<Card>({ accepts: isCard, onDrop: () => undefined }),
    );
    expect(ref.isDragging()).toBe(false);
    expect(monitorMock).not.toHaveBeenCalled();
  });

  it('runs in a provided injector when called outside an injection context', () => {
    const injector = TestBed.inject(EnvironmentInjector);
    // No runInInjectionContext wrapper — relies solely on opts.injector.
    const ref = monitor<Card>({
      accepts: isCard,
      injector,
      onDrop: () => undefined,
    });
    expect(ref.isDragging()).toBe(false);
    expect(monitorMock).toHaveBeenCalled();
  });
});

describe('monitor — reactivity & non-happy', () => {
  it('isDragging is frame-stable (boolean equality gate) across the drag', () => {
    const session = TestBed.inject(DndSession).session;
    const ref = TestBed.runInInjectionContext(() =>
      monitor<Card>({ accepts: isCard }),
    );
    const runs = trackRuns(() => ref.isDragging());
    TestBed.tick();
    session.set(makeSession(boxData<Card>({ id: 'a' })));
    TestBed.tick();
    const after = runs();
    for (let i = 1; i <= 4; i++) {
      session.set({
        ...makeSession(boxData<Card>({ id: 'a' })),
        pointer: { x: i, y: i },
      });
      TestBed.tick();
    }
    expect(runs()).toBe(after); // stays true → no churn
    session.set(null);
    TestBed.tick();
    expect(runs()).toBe(after + 1); // true → false
  });

  it('drops accepted→foreign mid-flight: isDragging falls to false (non-happy)', () => {
    const session = TestBed.inject(DndSession).session;
    const ref = TestBed.runInInjectionContext(() =>
      monitor<Card>({ accepts: isCard }),
    );
    session.set(makeSession(boxData<Card>({ id: 'a' })));
    expect(ref.isDragging()).toBe(true);
    // a foreign source takes over (e.g. external drag) — must not read as ours
    session.set(makeSession(boxData('not-a-card')));
    expect(ref.isDragging()).toBe(false);
    expect(ref.source()).toBeUndefined();
  });
});
