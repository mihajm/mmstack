import { ElementRef, PLATFORM_ID } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import type { monitorForElements as PDMonitor } from '@atlaskit/pragmatic-drag-and-drop/element/adapter';

import { DndSession, injectDndActive, provideDndSession } from './session';

// Capture the config DndSession hands to pragmatic's monitor, typed against the
// REAL pragmatic signature — a contract guard: if pragmatic changes the monitor
// callback shape, this file stops compiling.
type MonitorConfig = Parameters<typeof PDMonitor>[0];
type MonitorEvent = Parameters<NonNullable<MonitorConfig['onDrag']>>[0];

let monitorConfig: MonitorConfig | undefined;

vi.mock('@atlaskit/pragmatic-drag-and-drop/element/adapter', () => ({
  monitorForElements: (config: MonitorConfig) => {
    monitorConfig = config;
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
  });

  it('bridges the monitor into a single derived signal', () => {
    const session = TestBed.inject(DndSession);
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

  it('updates targets on drop-target change', () => {
    const session = TestBed.inject(DndSession);
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

    monitorConfig?.onDragStart?.(makeEvent({ sourceEl: outside }));
    expect(active()).toBe(false);

    monitorConfig?.onDragStart?.(makeEvent({ sourceEl: inside }));
    expect(active()).toBe(true);
  });

  it('the writable session lets a custom engine drive it imperatively', () => {
    const session = TestBed.inject(DndSession);
    const sourceEl = document.createElement('div');
    session.session.set({
      sourceEl,
      sourceData: {},
      targets: [],
      pointer: { x: 1, y: 2 },
      kind: 'move',
    });
    expect(session.session()?.kind).toBe('move');
    session.session.set(null);
    expect(session.session()).toBeNull();
  });

  it('is inert on the server (no monitor subscription)', () => {
    monitorConfig = undefined;
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      providers: [{ provide: PLATFORM_ID, useValue: 'server' }],
    });
    const session = TestBed.inject(DndSession);
    expect(monitorConfig).toBeUndefined();
    expect(session.active()).toBe(false);
  });
});
