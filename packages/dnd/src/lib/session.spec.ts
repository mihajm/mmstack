import { ElementRef, PLATFORM_ID } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { trackRuns } from './testing/reactivity';
import { makeDragSession } from './testing/drag-session';
import type { monitorForElements as PDMonitor } from '@atlaskit/pragmatic-drag-and-drop/element/adapter';

import { DndSession, injectDndActive, provideDndSession } from './session';

// Capture the config DndSession hands to pragmatic's monitor, typed against the
// REAL pragmatic signature — a contract guard: if pragmatic changes the monitor
// callback shape, this file stops compiling.
type MonitorConfig = Parameters<typeof PDMonitor>[0];
type MonitorEvent = Parameters<NonNullable<MonitorConfig['onDrag']>>[0];

let monitorConfig: MonitorConfig | undefined;
let monitorCalls = 0;

vi.mock('@atlaskit/pragmatic-drag-and-drop/element/adapter', () => ({
  monitorForElements: (config: MonitorConfig) => {
    monitorConfig = config;
    monitorCalls++;
    return () => undefined;
  },
  draggable: vi.fn(() => () => undefined),
  dropTargetForElements: vi.fn(() => () => undefined),
}));

function makeEvent(opts: {
  sourceEl: HTMLElement;
  sourceData?: Record<string | symbol, unknown>;
  targets?: { element: Element; data: Record<string | symbol, unknown> }[];
  x?: number;
  y?: number;
}): MonitorEvent {
  const dropTargets = (opts.targets ?? []).map((t) => ({
    element: t.element,
    data: t.data,
    dropEffect: 'move' as const,
    isActiveDueToStickiness: false,
  }));
  const input = {
    clientX: opts.x ?? 0,
    clientY: opts.y ?? 0,
    pageX: opts.x ?? 0,
    pageY: opts.y ?? 0,
  } as MonitorEvent['location']['current']['input'];
  return {
    source: {
      element: opts.sourceEl,
      dragHandle: null,
      data: opts.sourceData ?? {},
    },
    location: {
      initial: { input, dropTargets: [] },
      current: { input, dropTargets },
      previous: { dropTargets: [] },
    },
  } as MonitorEvent;
}

describe('DndSession', () => {
  beforeEach(() => {
    TestBed.resetTestingModule();
    monitorConfig = undefined;
    monitorCalls = 0;
  });

  it('attaches the native monitor lazily + idempotently (zero-cost for pointer-only)', () => {
    const session = TestBed.inject(DndSession);
    expect(monitorConfig).toBeUndefined(); // injecting alone attaches nothing
    expect(monitorCalls).toBe(0);

    session.ensureNativeMonitor();
    expect(monitorCalls).toBe(1); // attached on first native demand
    expect(monitorConfig).toBeDefined();

    session.ensureNativeMonitor();
    expect(monitorCalls).toBe(1); // idempotent
  });

  it('bridges the monitor into a single derived signal', () => {
    const session = TestBed.inject(DndSession);
    session.ensureNativeMonitor();
    expect(session.active()).toBe(false);
    expect(session.session()).toBeNull();
    expect(monitorConfig).toBeDefined();

    const sourceEl = document.createElement('div');
    monitorConfig?.onDragStart?.(makeEvent({ sourceEl }));
    expect(session.active()).toBe(true);
    expect(session.session()?.sourceEl).toBe(sourceEl);

    monitorConfig?.onDrop?.(makeEvent({ sourceEl }));
    expect(session.active()).toBe(false);
    expect(session.session()).toBeNull();
  });

  it('tags a native (pragmatic) drag with engine: "native"', () => {
    const session = TestBed.inject(DndSession);
    session.ensureNativeMonitor();
    const sourceEl = document.createElement('div');
    monitorConfig?.onDragStart?.(makeEvent({ sourceEl }));
    expect(session.session()?.engine).toBe('native');
  });

  it('updates targets on drop-target change', () => {
    const session = TestBed.inject(DndSession);
    session.ensureNativeMonitor();
    const sourceEl = document.createElement('div');
    const target = document.createElement('div');

    monitorConfig?.onDragStart?.(makeEvent({ sourceEl }));
    expect(session.session()?.targets).toHaveLength(0);

    monitorConfig?.onDropTargetChange?.(
      makeEvent({ sourceEl, targets: [{ element: target, data: {} }] }),
    );
    expect(session.session()?.targets.map((t) => t.element)).toEqual([target]);
  });

  it('refreshes the closest-edge token on onDrag within one target (#4)', () => {
    const session = TestBed.inject(DndSession);
    session.ensureNativeMonitor();
    const sourceEl = document.createElement('div');
    const target = document.createElement('div');

    monitorConfig?.onDragStart?.(
      makeEvent({
        sourceEl,
        targets: [{ element: target, data: { edge: 'top' } }],
      }),
    );
    expect(session.targets()[0].data).toEqual({ edge: 'top' });

    // pragmatic delivers a fresh edge via onDrag (no onDropTargetChange fires)
    monitorConfig?.onDrag?.(
      makeEvent({
        sourceEl,
        targets: [{ element: target, data: { edge: 'bottom' } }],
      }),
    );
    expect(session.targets()[0].data).toEqual({ edge: 'bottom' });
  });

  it('a scoped session ignores drags originating outside its subtree (#2)', () => {
    const root = document.createElement('div');
    const inside = document.createElement('div');
    root.appendChild(inside);
    const outside = document.createElement('div');

    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      providers: [
        { provide: ElementRef, useValue: new ElementRef(root) },
        DndSession,
      ],
    });
    const session = TestBed.inject(DndSession);
    session.ensureNativeMonitor();

    monitorConfig?.onDragStart?.(makeEvent({ sourceEl: outside }));
    expect(session.active()).toBe(false); // out of scope → not tracked

    monitorConfig?.onDragStart?.(makeEvent({ sourceEl: inside }));
    expect(session.active()).toBe(true); // within the scoped subtree → tracked
  });

  it('provideDndSession() scopes an isolated session via the public API', () => {
    const root = document.createElement('div');
    const inside = document.createElement('div');
    root.appendChild(inside);
    const outside = document.createElement('div');

    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      providers: [
        { provide: ElementRef, useValue: new ElementRef(root) },
        provideDndSession(),
      ],
    });
    const active = TestBed.runInInjectionContext(() => injectDndActive());
    TestBed.inject(DndSession).ensureNativeMonitor();

    monitorConfig?.onDragStart?.(makeEvent({ sourceEl: outside }));
    expect(active()).toBe(false);

    monitorConfig?.onDragStart?.(makeEvent({ sourceEl: inside }));
    expect(active()).toBe(true);
  });

  it('the writable session lets a custom engine drive it imperatively', () => {
    const session = TestBed.inject(DndSession);
    session.ensureNativeMonitor();
    const sourceEl = document.createElement('div');
    session.session.set(
      makeDragSession({ sourceEl, pointer: { x: 1, y: 2 }, kind: 'move' }),
    );
    expect(session.session()?.kind).toBe('move');
    session.session.set(null);
    expect(session.session()).toBeNull();
  });

  // --- fine-grained reactivity: the whole reason the session is split into slices.
  // Prove a reader of one slice does NOT recompute when only another slice changes.
  it('active does NOT re-notify across onDrag frames (flips on start/drop only)', () => {
    const session = TestBed.inject(DndSession);
    session.ensureNativeMonitor();
    const sourceEl = document.createElement('div');
    const runs = trackRuns(() => session.active());
    TestBed.tick(); // initial
    expect(runs()).toBe(1);

    monitorConfig?.onDragStart?.(makeEvent({ sourceEl }));
    TestBed.tick(); // false → true
    expect(runs()).toBe(2);

    for (let i = 0; i < 5; i++) {
      monitorConfig?.onDrag?.(makeEvent({ sourceEl, x: i, y: i }));
      TestBed.tick();
    }
    expect(runs()).toBe(2); // no per-frame churn — active stayed true

    monitorConfig?.onDrop?.(makeEvent({ sourceEl }));
    TestBed.tick();
    expect(runs()).toBe(3); // true → false
  });

  it('source is set on start/drop only — readers never recompute per frame', () => {
    const session = TestBed.inject(DndSession);
    session.ensureNativeMonitor();
    const sourceEl = document.createElement('div');
    const runs = trackRuns(() => session.source());
    TestBed.tick();
    monitorConfig?.onDragStart?.(makeEvent({ sourceEl }));
    TestBed.tick();
    const afterStart = runs();
    for (let i = 0; i < 5; i++) {
      monitorConfig?.onDrag?.(makeEvent({ sourceEl, x: i }));
      TestBed.tick();
    }
    expect(runs()).toBe(afterStart); // dragging does not touch `source`
  });

  it('targetEls custom equality suppresses per-frame churn while raw targets refresh', () => {
    const session = TestBed.inject(DndSession);
    session.ensureNativeMonitor();
    const sourceEl = document.createElement('div');
    const target = document.createElement('div');
    const elRuns = trackRuns(() => session.targetEls());
    const targetRuns = trackRuns(() => session.targets());
    TestBed.tick();
    monitorConfig?.onDragStart?.(
      makeEvent({ sourceEl, targets: [{ element: target, data: { edge: 'top' } }] }),
    );
    TestBed.tick();
    const elAfterStart = elRuns();
    const targetAfterStart = targetRuns();

    // same hovered element, fresh edge token each frame
    for (const edge of ['bottom', 'top', 'bottom']) {
      monitorConfig?.onDrag?.(
        makeEvent({ sourceEl, targets: [{ element: target, data: { edge } }] }),
      );
      TestBed.tick();
    }
    expect(targetRuns()).toBe(targetAfterStart + 3); // raw targets re-set each frame
    expect(elRuns()).toBe(elAfterStart); // element identity unchanged → no recompute
  });

  it('pointer notifies on every onDrag frame (and session, but not active)', () => {
    const session = TestBed.inject(DndSession);
    session.ensureNativeMonitor();
    const sourceEl = document.createElement('div');
    const pointerRuns = trackRuns(() => session.pointer());
    const activeRuns = trackRuns(() => session.active());
    TestBed.tick();
    monitorConfig?.onDragStart?.(makeEvent({ sourceEl }));
    TestBed.tick();
    const pointerAfterStart = pointerRuns();
    const activeAfterStart = activeRuns();

    for (let i = 1; i <= 4; i++) {
      monitorConfig?.onDrag?.(makeEvent({ sourceEl, x: i, y: i }));
      TestBed.tick();
    }
    expect(pointerRuns()).toBe(pointerAfterStart + 4); // live coords every frame
    expect(activeRuns()).toBe(activeAfterStart); // ...but active is untouched
  });

  it('pointer does NOT re-notify when the coordinates are unchanged (held still)', () => {
    const session = TestBed.inject(DndSession);
    session.ensureNativeMonitor();
    const sourceEl = document.createElement('div');
    const runs = trackRuns(() => session.pointer());
    TestBed.tick();
    monitorConfig?.onDragStart?.(makeEvent({ sourceEl, x: 5, y: 5 }));
    TestBed.tick();
    const after = runs();
    for (let i = 0; i < 4; i++) {
      monitorConfig?.onDrag?.(makeEvent({ sourceEl, x: 5, y: 5 })); // same coords
      TestBed.tick();
    }
    expect(runs()).toBe(after); // equality-gated → no churn
    monitorConfig?.onDrag?.(makeEvent({ sourceEl, x: 6, y: 5 }));
    TestBed.tick();
    expect(runs()).toBe(after + 1); // a real move notifies once
  });

  it('targets does NOT re-notify when the hovered stack is unchanged across frames', () => {
    const session = TestBed.inject(DndSession);
    session.ensureNativeMonitor();
    const sourceEl = document.createElement('div');
    const target = document.createElement('div');
    const runs = trackRuns(() => session.targets());
    TestBed.tick();
    monitorConfig?.onDragStart?.(
      makeEvent({ sourceEl, targets: [{ element: target, data: {} }] }),
    );
    TestBed.tick();
    const after = runs();
    for (let i = 1; i <= 4; i++) {
      // pointer moves, but the hovered stack + its data are identical
      monitorConfig?.onDrag?.(
        makeEvent({ sourceEl, x: i, targets: [{ element: target, data: {} }] }),
      );
      TestBed.tick();
    }
    expect(runs()).toBe(after); // content-equality gate → no churn
  });

  // --- non-happy-path: malformed / out-of-order event sequences must stay safe.
  it('ignores an orphan onDrag (no active source) — no fabricated session or leaked pointer', () => {
    const session = TestBed.inject(DndSession);
    session.ensureNativeMonitor();
    const sourceEl = document.createElement('div');
    monitorConfig?.onDrag?.(makeEvent({ sourceEl, x: 99, y: 99 }));
    expect(session.active()).toBe(false);
    expect(session.session()).toBeNull();
    expect(session.pointer()).toEqual({ x: 0, y: 0 }); // untouched
  });

  it('ignores an orphan onDropTargetChange (no active source)', () => {
    const session = TestBed.inject(DndSession);
    session.ensureNativeMonitor();
    const sourceEl = document.createElement('div');
    const target = document.createElement('div');
    monitorConfig?.onDropTargetChange?.(
      makeEvent({ sourceEl, targets: [{ element: target, data: {} }] }),
    );
    expect(session.targets()).toHaveLength(0);
  });

  it('ignores an orphan onDrop (drop with no start) without throwing', () => {
    const session = TestBed.inject(DndSession);
    session.ensureNativeMonitor();
    const sourceEl = document.createElement('div');
    expect(() => monitorConfig?.onDrop?.(makeEvent({ sourceEl }))).not.toThrow();
    expect(session.active()).toBe(false);
  });

  it('a second onDragStart before a drop replaces the source (latest wins)', () => {
    const session = TestBed.inject(DndSession);
    session.ensureNativeMonitor();
    const first = document.createElement('div');
    const second = document.createElement('div');
    monitorConfig?.onDragStart?.(makeEvent({ sourceEl: first }));
    monitorConfig?.onDragStart?.(makeEvent({ sourceEl: second }));
    expect(session.session()?.sourceEl).toBe(second);
  });

  it('clears targets (and notifies targetEls) when the hover empties out', () => {
    const session = TestBed.inject(DndSession);
    session.ensureNativeMonitor();
    const sourceEl = document.createElement('div');
    const target = document.createElement('div');
    const elRuns = trackRuns(() => session.targetEls());
    TestBed.tick();
    monitorConfig?.onDragStart?.(
      makeEvent({ sourceEl, targets: [{ element: target, data: {} }] }),
    );
    TestBed.tick();
    const withTarget = elRuns();
    monitorConfig?.onDropTargetChange?.(makeEvent({ sourceEl, targets: [] }));
    TestBed.tick();
    expect(session.targets()).toHaveLength(0);
    expect(elRuns()).toBe(withTarget + 1); // length 1 → 0 is a real change
  });

  it('a scoped session keeps an in-scope drag alive when an out-of-scope drop arrives', () => {
    const root = document.createElement('div');
    const inside = document.createElement('div');
    root.appendChild(inside);
    const outside = document.createElement('div');
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      providers: [{ provide: ElementRef, useValue: new ElementRef(root) }, DndSession],
    });
    const session = TestBed.inject(DndSession);
    session.ensureNativeMonitor();

    monitorConfig?.onDragStart?.(makeEvent({ sourceEl: inside }));
    expect(session.active()).toBe(true);
    // a drop for some other (out-of-scope) drag must not tear ours down
    monitorConfig?.onDrop?.(makeEvent({ sourceEl: outside }));
    expect(session.active()).toBe(true);
    // our own drop ends it
    monitorConfig?.onDrop?.(makeEvent({ sourceEl: inside }));
    expect(session.active()).toBe(false);
  });

  it('is inert on the server (no monitor subscription)', () => {
    monitorConfig = undefined;
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      providers: [{ provide: PLATFORM_ID, useValue: 'server' }],
    });
    const session = TestBed.inject(DndSession);
    session.ensureNativeMonitor();
    expect(monitorConfig).toBeUndefined();
    expect(session.active()).toBe(false);
  });
});
