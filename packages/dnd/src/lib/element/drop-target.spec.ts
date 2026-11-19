import {
  Component,
  ElementRef,
  Injector,
  PLATFORM_ID,
  viewChild,
} from '@angular/core';
import { TestBed } from '@angular/core/testing';
import {
  monitorForElements,
  type dropTargetForElements as PDDropTarget,
} from '@atlaskit/pragmatic-drag-and-drop/adapter/element-adapter';

import { signal } from '@angular/core';
import type { Edge } from '../internal/types';
import { trackRuns } from '../testing/reactivity';
import { makeDragSession } from '../testing/drag-session';

import { boxData, unboxData } from '../internal/payload';
import { provideDnd, type HitboxPlugin } from '../provide';
import { DndSession, type DragSession, type DropTargetHit } from '../session';
import { DropTarget, dropTarget } from './drop-target';
import { DndPointerEngine } from './pointer-engine';
import type { DropEvent, DropTargetEvent } from '../internal/types';

type DropTargetConfig = Parameters<typeof PDDropTarget>[0];

class StubPointerEngine extends DndPointerEngine {
  stack: Element[] = [];
  protected override elementsAt(): readonly Element[] {
    return this.stack;
  }
}

const dropTargetMock = vi.fn();

vi.mock('@atlaskit/pragmatic-drag-and-drop/adapter/element-adapter', () => ({
  dropTargetForElements: (config: DropTargetConfig) =>
    dropTargetMock(config) ?? (() => undefined),
  draggable: vi.fn(() => () => undefined),
  monitorForElements: vi.fn(() => () => undefined),
}));

type Card = { id: string };
const isCard = (d: unknown): d is Card =>
  !!d && typeof d === 'object' && 'id' in (d as object);

const stubHitbox: HitboxPlugin = {
  attachClosestEdge: (data) => ({ ...data, __edge: 'top' }),
  extractClosestEdge: () => 'top',
};

function setup(
  opts: {
    providers?: unknown[];
    edges?: ('top' | 'bottom')[];
    disabled?: boolean;
  } = {},
) {
  const element = document.createElement('div');
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({
    providers: [
      { provide: ElementRef, useValue: new ElementRef(element) },
      ...((opts.providers ?? []) as never[]),
    ],
  });
  return TestBed.runInInjectionContext(() => {
    const session = TestBed.inject(DndSession).session;
    const ref = dropTarget<Card>({
      accepts: isCard,
      edges: opts.edges,
      disabled: opts.disabled,
    });
    return {
      ref,
      element,
      session,
      config: dropTargetMock.mock.calls.at(-1)?.[0] as DropTargetConfig,
    };
  });
}

function makeSession(
  targets: DropTargetHit[],
  sourceData: Record<string | symbol, unknown> = boxData<Card>({ id: 'c' }),
): DragSession {
  return makeDragSession({ targets, sourceData });
}

describe('dropTarget — derived state', () => {
  beforeEach(() => {
    dropTargetMock.mockReset();
  });

  it('derives isDragOver / isInnermost from the innermost-first stack', () => {
    const { ref, element, session } = setup();
    const other = document.createElement('div');

    expect(ref.isDragOver()).toBe(false);
    expect(ref.isInnermost()).toBe(false);

    // our element is innermost (index 0)
    session.set(
      makeSession([
        { element, data: {} },
        { element: other, data: {} },
      ]),
    );
    expect(ref.isDragOver()).toBe(true);
    expect(ref.isInnermost()).toBe(true);

    // our element is an outer target (index 1)
    session.set(
      makeSession([
        { element: other, data: {} },
        { element, data: {} },
      ]),
    );
    expect(ref.isDragOver()).toBe(true);
    expect(ref.isInnermost()).toBe(false);

    // not in the stack
    session.set(makeSession([{ element: other, data: {} }]));
    expect(ref.isDragOver()).toBe(false);

    session.set(null);
    expect(ref.isDragOver()).toBe(false);
  });

  it('derives typed dragOverData from the boxed source payload', () => {
    const { ref, element, session } = setup();
    expect(ref.dragOverData()).toBeUndefined();
    session.set(makeSession([{ element, data: {} }]));
    expect(ref.dragOverData()).toEqual({ id: 'c' });
  });

  it('derives closestEdge from the session via the hitbox plugin', () => {
    const { ref, element, session } = setup({
      edges: ['top', 'bottom'],
      providers: [provideDnd({ plugins: { hitbox: stubHitbox } })],
    });
    expect(ref.closestEdge()).toBeNull();
    session.set(makeSession([{ element, data: { __edge: 'top' } }]));
    expect(ref.closestEdge()).toBe('top');
  });

  it('warns and no-ops (does not throw) when edges are requested without a hitbox', () => {
    const spy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    expect(() => setup({ edges: ['top'] })).not.toThrow(); // degrades: no edge, drop still works
    spy.mockRestore();
  });

  it('clears hover / innermost / edge when disabled flips mid-hover (#7)', () => {
    const element = document.createElement('div');
    const disabled = signal(false);
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      providers: [
        { provide: ElementRef, useValue: new ElementRef(element) },
        provideDnd({ plugins: { hitbox: stubHitbox } }),
      ],
    });
    const { ref, session } = TestBed.runInInjectionContext(() => {
      const session = TestBed.inject(DndSession).session;
      const ref = dropTarget<Card>({
        accepts: isCard,
        edges: ['top'],
        disabled,
      });
      return { ref, session };
    });
    session.set(makeSession([{ element, data: { __edge: 'top' } }]));
    expect(ref.isDragOver()).toBe(true);
    expect(ref.closestEdge()).toBe('top');

    disabled.set(true); // pointer stationary, no dragover fires
    expect(ref.isDragOver()).toBe(false);
    expect(ref.isInnermost()).toBe(false);
    expect(ref.closestEdge()).toBeNull();
  });
});

describe('dropTarget — registration hooks (read lazily)', () => {
  beforeEach(() => dropTargetMock.mockReset());

  it('gates canDrop on the accepts typeguard', () => {
    const { config } = setup();
    expect(
      config.canDrop?.({
        source: { data: boxData<Card>({ id: 'a' }) },
      } as never),
    ).toBe(true);
    expect(
      config.canDrop?.({ source: { data: boxData('nope') } } as never),
    ).toBe(false);
  });

  it('gates canDrop on disabled', () => {
    const { config } = setup({ disabled: true });
    expect(
      config.canDrop?.({
        source: { data: boxData<Card>({ id: 'a' }) },
      } as never),
    ).toBe(false);
  });

  it('attaches the closest edge in getData when a hitbox is present', () => {
    const attach = vi.fn((data) => data);
    const { config } = setup({
      edges: ['top', 'bottom'],
      providers: [
        provideDnd({
          plugins: {
            hitbox: {
              attachClosestEdge: attach,
              extractClosestEdge: () => null,
            },
          },
        }),
      ],
    });
    config.getData?.({
      input: { clientX: 1, clientY: 2 } as never,
      element: document.createElement('div'),
    } as never);
    expect(attach).toHaveBeenCalledOnce();
  });

  it('returns an inert ref on the server', () => {
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      providers: [
        {
          provide: ElementRef,
          useValue: new ElementRef(document.createElement('div')),
        },
        { provide: PLATFORM_ID, useValue: 'server' },
      ],
    });
    const { ref } = TestBed.runInInjectionContext(() => {
      TestBed.inject(DndSession);
      return { ref: dropTarget<Card>({ accepts: isCard }) };
    });
    expect(ref.isDragOver()).toBe(false);
    expect(dropTargetMock).not.toHaveBeenCalled();
  });
});

describe('dropTarget — callbacks & reactivity', () => {
  beforeEach(() => {
    dropTargetMock.mockReset();
  });

  function build(
    opts: Record<string, unknown> = {},
    providers: unknown[] = [],
  ) {
    const element = document.createElement('div');
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      providers: [
        { provide: ElementRef, useValue: new ElementRef(element) },
        ...(providers as never[]),
      ],
    });
    return TestBed.runInInjectionContext(() => {
      TestBed.inject(DndSession);
      const ref = dropTarget<Card, unknown>({
        accepts: isCard,
        ...(opts as object),
      });
      return {
        ref,
        element,
        config: dropTargetMock.mock.calls.at(-1)?.[0] as DropTargetConfig,
      };
    });
  }

  const card = () => boxData<Card>({ id: 'a' });

  it('fires onDragEnter only for accepted sources, with self data', () => {
    const enters: DropTargetEvent<Card, unknown>[] = [];
    const { config } = build({
      data: () => ({ slot: 9 }),
      onDragEnter: (e: DropTargetEvent<Card, unknown>) => enters.push(e),
    });
    const self = { element: document.createElement('div'), data: {} };
    config.onDragEnter?.({ source: { data: card() }, self } as never);
    config.onDragEnter?.({ source: { data: boxData('nope') }, self } as never);
    expect(enters).toHaveLength(1);
    expect(enters[0].self.data).toEqual({ slot: 9 });
  });

  it('fires onDragLeave only for accepted sources', () => {
    const leaves: unknown[] = [];
    const { config } = build({ onDragLeave: () => leaves.push(1) });
    const self = { element: document.createElement('div'), data: {} };
    config.onDragLeave?.({ source: { data: card() }, self } as never);
    config.onDragLeave?.({ source: { data: boxData('nope') }, self } as never);
    expect(leaves).toHaveLength(1);
  });

  it('honours a custom canDrop predicate', () => {
    const { config } = build({ canDrop: () => false });
    expect(config.canDrop?.({ source: { data: card() } } as never)).toBe(false);
  });

  it('reflects a reactive disabled signal in canDrop (read lazily)', () => {
    const disabled = signal(false);
    const { config } = build({ disabled });
    expect(config.canDrop?.({ source: { data: card() } } as never)).toBe(true);
    disabled.set(true);
    expect(config.canDrop?.({ source: { data: card() } } as never)).toBe(false);
  });

  it('forwards sticky → getIsSticky and dropEffect → getDropEffect (lazy)', () => {
    const { config } = build({ sticky: true, dropEffect: 'copy' });
    expect(config.getIsSticky?.({} as never)).toBe(true);
    expect(config.getDropEffect?.({} as never)).toBe('copy');
  });

  it('omits getIsSticky / getDropEffect when not configured', () => {
    const { config } = build();
    expect(config.getIsSticky).toBeUndefined();
    expect(config.getDropEffect).toBeUndefined();
  });

  it('getData boxes self data and needs no hitbox without edges', () => {
    const { config } = build({ data: () => ({ slot: 1 }) });
    const data = config.getData?.({
      input: { clientX: 0, clientY: 0 } as never,
      element: document.createElement('div'),
    } as never);
    expect(unboxData(data ?? {})).toEqual({ slot: 1 });
  });

  it('degrades (warns, no edge) when dynamic edges become non-empty without a hitbox (#9)', () => {
    const edges = signal<('top' | 'bottom')[] | undefined>(undefined);
    const { config } = build({ edges }); // starts empty → setup does not throw
    edges.set(['top']);
    const spy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    expect(() =>
      config.getData?.({
        input: { clientX: 0, clientY: 0 } as never,
        element: document.createElement('div'),
      } as never),
    ).not.toThrow(); // missing hitbox → no edge attached, but the drop still works
    spy.mockRestore();
  });

  it('onDrop fires for accepted sources with mapped (unboxed) location and null edge sans hitbox', () => {
    const drops: DropEvent<Card>[] = [];
    const { config } = build({ onDrop: (e: DropEvent<Card>) => drops.push(e) });
    const tEl = document.createElement('div');
    config.onDrop?.({
      source: { data: card() },
      self: { element: tEl, data: {} },
      location: {
        current: {
          dropTargets: [{ element: tEl, data: boxData({ slot: 2 }) }],
        },
        previous: { dropTargets: [] },
      },
    } as never);
    config.onDrop?.({
      source: { data: boxData('nope') },
      self: { element: tEl, data: {} },
      location: { current: { dropTargets: [] }, previous: { dropTargets: [] } },
    } as never);

    expect(drops).toHaveLength(1);
    expect(drops[0].data).toEqual({ id: 'a' });
    expect(drops[0].edge).toBeNull();
    expect(drops[0].location.current[0].data).toEqual({ slot: 2 });
  });
});

describe('dropTarget — reactivity (recomputation counts) & gate separation', () => {
  beforeEach(() => dropTargetMock.mockReset());

  const edgeHitbox: HitboxPlugin = {
    attachClosestEdge: (data) => data,
    extractClosestEdge: (data) => (data as { __edge?: Edge }).__edge ?? null,
  };

  it('isDragOver/isInnermost stay stable across frames; closestEdge refreshes per frame', () => {
    const { ref, element, session } = setup({
      edges: ['top'],
      providers: [provideDnd({ plugins: { hitbox: edgeHitbox } })],
    });
    const overRuns = trackRuns(() => ref.isDragOver());
    const innerRuns = trackRuns(() => ref.isInnermost());
    const edgeRuns = trackRuns(() => ref.closestEdge());
    TestBed.tick();
    session.set(makeSession([{ element, data: { __edge: 'top' } }]));
    TestBed.tick();
    const [o, n, e] = [overRuns(), innerRuns(), edgeRuns()];

    // frames: same hovered element (stable identity), fresh edge token each time
    for (const edge of ['bottom', 'top', 'bottom']) {
      session.set(makeSession([{ element, data: { __edge: edge } }]));
      TestBed.tick();
    }
    expect(overRuns()).toBe(o); // membership unchanged → no recompute
    expect(innerRuns()).toBe(n);
    expect(edgeRuns()).toBe(e + 3); // edge follows the live token
  });

  it('isDragOver reflects membership, but dragOverData still gates on accepts (foreign source)', () => {
    const { ref, element, session } = setup();
    session.set(
      makeSession(
        [{ element, data: {} }],
        boxData<unknown>({ notACard: true }),
      ),
    );
    expect(ref.isDragOver()).toBe(true); // element is in the hovered stack
    expect(ref.dragOverData()).toBeUndefined(); // ...but the payload isn't accepted
  });
});

describe('dropTarget — pointer engine', () => {
  beforeEach(() => dropTargetMock.mockReset());

  it('engine:"pointer" skips pragmatic; reactive state still flows from the unified session', () => {
    const element = document.createElement('div');
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      providers: [{ provide: ElementRef, useValue: new ElementRef(element) }],
    });
    const { ref, session } = TestBed.runInInjectionContext(() => {
      const s = TestBed.inject(DndSession).session;
      const r = dropTarget<Card>({ accepts: isCard, engine: 'pointer' });
      return { ref: r, session: s };
    });

    expect(dropTargetMock).not.toHaveBeenCalled(); // not registered with pragmatic
    // drive the session the way the pointer engine would
    session.set(
      makeDragSession({
        targets: [{ element, data: {} }],
        sourceData: boxData<Card>({ id: 'c' }),
        engine: 'pointer',
      }),
    );
    expect(ref.isDragOver()).toBe(true);
    expect(ref.isInnermost()).toBe(true);
    expect(ref.dragOverData()).toEqual({ id: 'c' });
  });

  const yHitbox: HitboxPlugin = {
    attachClosestEdge: (data, { input }) => ({
      ...data,
      __edge: input.clientY < 50 ? 'top' : 'bottom',
    }),
    extractClosestEdge: (data) => (data as { __edge?: Edge }).__edge ?? null,
  };

  const pointerSource = () => ({
    el: document.createElement('div'),
    data: boxData<Card>({ id: 'c' }),
    kind: 'transfer' as const,
  });

  function setupPointerEdges(onDrop?: (e: DropEvent<Card>) => void): {
    ref: ReturnType<typeof dropTarget<Card>>;
    engine: StubPointerEngine;
  } {
    const element = document.createElement('div');
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      providers: [
        { provide: ElementRef, useValue: new ElementRef(element) },
        { provide: DndPointerEngine, useClass: StubPointerEngine },
        provideDnd({ plugins: { hitbox: yHitbox } }),
      ],
    });
    return TestBed.runInInjectionContext(() => {
      const engine = TestBed.inject(DndPointerEngine) as StubPointerEngine;
      const ref = dropTarget<Card>({
        accepts: isCard,
        edges: ['top', 'bottom'] as Edge[],
        engine: 'pointer',
        onDrop,
      });
      engine.stack = [element];
      return { ref, engine };
    });
  }

  it('resolves closestEdge from the live pointer in pointer mode (no pragmatic input)', () => {
    const { ref, engine } = setupPointerEdges();
    expect(ref.closestEdge()).toBeNull(); // idle

    const src = pointerSource();
    engine.begin(src, 0, 10); // upper half → top
    expect(ref.isDragOver()).toBe(true);
    expect(ref.closestEdge()).toBe('top');

    engine.move(src, 0, 90); // lower half → bottom
    expect(ref.closestEdge()).toBe('bottom');

    engine.cancel(src);
    expect(ref.closestEdge()).toBeNull(); // cleared with the session
  });

  it('drop carries the resolved closest edge in pointer mode', () => {
    const drops: (Edge | null)[] = [];
    const { engine } = setupPointerEdges((e) => drops.push(e.edge));

    const src = pointerSource();
    engine.begin(src, 0, 90); // bottom
    engine.end(src);
    expect(drops).toEqual(['bottom']);
  });

  it('an edge flip refreshes closestEdge without churning membership; same edge does not recompute', () => {
    const { ref, engine } = setupPointerEdges();
    const overRuns = trackRuns(() => ref.isDragOver());
    const edgeRuns = trackRuns(() => ref.closestEdge());
    TestBed.tick();

    const src = pointerSource();
    engine.begin(src, 0, 10); // top
    TestBed.tick();
    const [over0, edge0] = [overRuns(), edgeRuns()];

    engine.move(src, 0, 90); // top → bottom
    TestBed.tick();
    expect(edgeRuns()).toBe(edge0 + 1);
    expect(overRuns()).toBe(over0); // membership stable across the flip

    const edge1 = edgeRuns();
    engine.move(src, 0, 95); // bottom → bottom (same edge)
    TestBed.tick();
    expect(edgeRuns()).toBe(edge1); // token unchanged → no recompute
    expect(overRuns()).toBe(over0);

    engine.cancel(src);
  });
});

describe('dropTarget: pointer-engine contract', () => {
  beforeEach(() => {
    dropTargetMock.mockReset();
  });

  const tagHitbox = (tag: string): HitboxPlugin => ({
    attachClosestEdge: (data, { element }) => ({
      ...data,
      __edge: (element as HTMLElement).dataset['edge'] ?? tag,
    }),
    extractClosestEdge: (data) =>
      ((data as { __edge?: Edge }).__edge ?? null) as Edge | null,
  });

  function scope(providers: unknown[] = []) {
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      providers: [
        { provide: DndPointerEngine, useClass: StubPointerEngine },
        ...(providers as never[]),
      ],
    });
    const engine = TestBed.inject(DndPointerEngine) as StubPointerEngine;
    const session = TestBed.inject(DndSession).session;
    const make = (opts: Record<string, unknown> = {}) => {
      const element = document.createElement('div');
      const injector = Injector.create({
        providers: [{ provide: ElementRef, useValue: new ElementRef(element) }],
        parent: TestBed.inject(Injector),
      });
      const ref = dropTarget<Card, unknown>({
        accepts: isCard,
        engine: 'pointer',
        injector,
        ...(opts as object),
      } as never);
      return { element, ref, injector };
    };
    const source = (id = 'a') => ({
      el: document.createElement('div'),
      data: boxData<Card>({ id }),
      kind: 'transfer' as const,
    });
    return { engine, session, make, source };
  }

  it('surfaces its own data on the hit and the drop, with the host as element', () => {
    const { engine, session, make, source } = scope();
    const drops: DropEvent<Card>[] = [];
    const t = make({
      data: { slot: 1 },
      onDrop: (e: DropEvent<Card>) => drops.push(e),
    });
    engine.stack = [t.element];
    const s = source();
    engine.begin(s, 0, 0);
    expect(unboxData(session()?.targets[0].data ?? {})).toEqual({ slot: 1 });
    engine.end(s);
    expect(drops[0].data).toEqual({ id: 'a' });
    expect(drops[0].location.current[0].element).toBe(t.element);
    expect(drops[0].location.current[0].data).toEqual({ slot: 1 });
    expect(drops[0].location.previous).toEqual([]);
  });

  it('a disabled target or a canDrop veto is not hit and gets no drop', () => {
    const { engine, session, make, source } = scope();
    const onDrop = vi.fn();
    const off = make({ disabled: true, onDrop });
    const veto = make({
      canDrop: ({ source: x }: { source: { data: Card } }) => x.data.id !== 'c',
      onDrop,
    });
    engine.stack = [off.element, veto.element];
    const s = source('c');
    engine.begin(s, 0, 0);
    expect(session()?.targets).toEqual([]);
    engine.end(s);
    expect(onDrop).not.toHaveBeenCalled();
    const ok = source('a');
    engine.begin(ok, 0, 0);
    expect(session()?.targets.map((h) => h.element)).toEqual([veto.element]);
    engine.cancel(ok);
  });

  it('forwards enter and leave once, with the source data and the host element', () => {
    const { engine, make, source } = scope();
    const enter = vi.fn();
    const leave = vi.fn();
    const t = make({ onDragEnter: enter, onDragLeave: leave });
    engine.stack = [t.element];
    const s = source();
    engine.begin(s, 0, 0);
    engine.move(s, 1, 1);
    expect(enter).toHaveBeenCalledTimes(1);
    expect(enter.mock.calls[0][0].source.data).toEqual({ id: 'a' });
    expect(enter.mock.calls[0][0].self.element).toBe(t.element);
    engine.stack = [];
    engine.move(s, 2, 2);
    expect(leave).toHaveBeenCalledTimes(1);
    expect(leave.mock.calls[0][0].source.data).toEqual({ id: 'a' });
    expect(leave.mock.calls[0][0].self.element).toBe(t.element);
    engine.cancel(s);
  });

  it('each nested target reports the edge from its own hit', () => {
    const { engine, make, source } = scope([
      provideDnd({ plugins: { hitbox: tagHitbox('x') } }),
    ]);
    const edges: Record<string, Edge | null> = {};
    const outer = make({
      edges: ['top', 'bottom'],
      onDrop: (e: DropEvent<Card>) => (edges['outer'] = e.edge),
    });
    const inner = make({
      edges: ['top', 'bottom'],
      onDrop: (e: DropEvent<Card>) => (edges['inner'] = e.edge),
    });
    outer.element.dataset['edge'] = 'bottom';
    inner.element.dataset['edge'] = 'top';
    engine.stack = [inner.element, outer.element];
    const s = source();
    engine.begin(s, 0, 0);
    engine.end(s);
    expect(edges).toEqual({ inner: 'top', outer: 'bottom' });
  });

  it.each([
    ['edges without a hitbox', [], { edges: ['top'] }],
    [
      'a hitbox without edges',
      [provideDnd({ plugins: { hitbox: tagHitbox('top') } })],
      {},
    ],
    [
      'edges resolving to undefined',
      [provideDnd({ plugins: { hitbox: tagHitbox('top') } })],
      { edges: signal(undefined) },
    ],
  ] as const)('with %s: hit, null edge, no throw', (_, providers, opts) => {
    const spy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { engine, make, source } = scope([...providers]);
    const drops: DropEvent<Card>[] = [];
    const t = make({ ...opts, onDrop: (e: DropEvent<Card>) => drops.push(e) });
    engine.stack = [t.element];
    const s = source();
    expect(() => engine.begin(s, 0, 0)).not.toThrow();
    expect(t.ref.isDragOver()).toBe(true);
    expect(t.ref.closestEdge()).toBeNull();
    engine.end(s);
    expect(drops).toHaveLength(1);
    expect(drops[0].edge).toBeNull();
    spy.mockRestore();
  });

  it('a target without onDrop does not stop its neighbor from dropping', () => {
    const { engine, make, source } = scope();
    const onDrop = vi.fn();
    const silent = make();
    const loud = make({ onDrop });
    engine.stack = [silent.element, loud.element];
    const s = source();
    engine.begin(s, 0, 0);
    expect(() => engine.end(s)).not.toThrow();
    expect(onDrop).toHaveBeenCalledTimes(1);
    expect(engine.dragging()).toBe(false);
  });

  it('a destroyed target is no longer hit', () => {
    const { engine, session, make, source } = scope();
    const t = make();
    t.injector.destroy();
    engine.stack = [t.element];
    const s = source();
    engine.begin(s, 0, 0);
    expect(session()?.targets).toEqual([]);
    engine.cancel(s);
  });

  it('dragOverData is undefined while the stack holds another element', () => {
    const { session, make } = scope();
    const t = make();
    session.set(
      makeDragSession({
        targets: [{ element: document.createElement('div'), data: {} }],
        sourceData: boxData<Card>({ id: 'a' }),
        engine: 'pointer',
      }),
    );
    expect(t.ref.dragOverData()).toBeUndefined();
    expect(t.ref.isDragOver()).toBe(false);
  });

  it('the server ref is never innermost', () => {
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      providers: [{ provide: PLATFORM_ID, useValue: 'server' }],
    });
    const ref = TestBed.runInInjectionContext(() =>
      dropTarget<Card>({ accepts: isCard }),
    );
    expect(ref.isInnermost()).toBe(false);
    expect(ref.dragOverData()).toBeUndefined();
    expect(ref.closestEdge()).toBeNull();
  });
});

describe('dropTarget: native-engine contract', () => {
  beforeEach(() => {
    dropTargetMock.mockReset();
    vi.mocked(monitorForElements).mockClear();
  });

  function native(
    opts: Record<string, unknown> = {},
    providers: unknown[] = [],
  ) {
    const element = document.createElement('div');
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      providers: [
        { provide: ElementRef, useValue: new ElementRef(element) },
        ...(providers as never[]),
      ],
    });
    const cleanup = vi.fn();
    dropTargetMock.mockReturnValueOnce(cleanup);
    const ref = TestBed.runInInjectionContext(() =>
      dropTarget<Card, unknown>({
        accepts: isCard,
        ...(opts as object),
      } as never),
    );
    const config = dropTargetMock.mock.calls.at(-1)?.[0] as DropTargetConfig;
    return { element, ref, config, cleanup };
  }
  const src = (id = 'a') => ({
    element: document.createElement('div'),
    dragHandle: null,
    data: boxData<Card>({ id }),
  });
  const self = (el: Element, data: Record<string | symbol, unknown> = {}) => ({
    element: el,
    data,
    dropEffect: 'move' as const,
    isActiveDueToStickiness: false,
  });
  const loc = () => ({
    initial: {} as never,
    current: { input: {} as never, dropTargets: [] },
    previous: { dropTargets: [] },
  });
  const input = { clientX: 1, clientY: 2 } as never;

  it('attaches the session monitor on its own and unregisters on destroy', () => {
    const { cleanup } = native();
    expect(monitorForElements).toHaveBeenCalledTimes(1);
    expect(cleanup).not.toHaveBeenCalled();
    TestBed.resetTestingModule();
    expect(cleanup).toHaveBeenCalledTimes(1);
  });

  it('getData with a hitbox but no edges returns its own data untouched', () => {
    const attach = vi.fn((d) => d);
    const { config, element } = native({ data: { slot: 3 } }, [
      provideDnd({
        plugins: {
          hitbox: { attachClosestEdge: attach, extractClosestEdge: () => null },
        },
      }),
    ]);
    const d = config.getData?.({
      input,
      element,
      dragHandle: null,
      source: src(),
    } as never);
    expect(unboxData(d ?? {})).toEqual({ slot: 3 });
    expect(attach).not.toHaveBeenCalled();
  });

  it('getData passes element, input and the allowed edges to the hitbox', () => {
    const attach = vi.fn((d) => d);
    const { config, element } = native({ edges: ['top'] }, [
      provideDnd({
        plugins: {
          hitbox: { attachClosestEdge: attach, extractClosestEdge: () => null },
        },
      }),
    ]);
    config.getData?.({
      input,
      element,
      dragHandle: null,
      source: src(),
    } as never);
    expect(attach).toHaveBeenCalledWith(expect.anything(), {
      element,
      input,
      allowedEdges: ['top'],
    });
  });

  it('canDrop hands the unboxed source to the predicate', () => {
    const { config, element } = native({
      canDrop: ({ source }: { source: { data: Card } }) =>
        source.data.id !== 'a',
    });
    expect(
      config.canDrop?.({ source: src('a'), input, element } as never),
    ).toBe(false);
    expect(
      config.canDrop?.({ source: src('b'), input, element } as never),
    ).toBe(true);
  });

  it('enter and leave carry the source data; rejected sources and missing callbacks are quiet', () => {
    const enters: unknown[] = [];
    const leaves: unknown[] = [];
    const { config, element } = native({
      onDragEnter: (e: { source: { data: Card } }) =>
        enters.push(e.source.data),
      onDragLeave: (e: { source: { data: Card } }) =>
        leaves.push(e.source.data),
    });
    const args = (s: ReturnType<typeof src>) =>
      ({ source: s, self: self(element), location: loc() }) as never;
    const rejected = { ...src(), data: boxData('nope') };
    config.onDragEnter?.(args(rejected));
    config.onDragEnter?.(args(src()));
    config.onDragLeave?.(args(src()));
    expect(enters).toEqual([{ id: 'a' }]);
    expect(leaves).toEqual([{ id: 'a' }]);
    const bare = native();
    expect(() => {
      bare.config.onDragEnter?.(args(src()));
      bare.config.onDragLeave?.(args(src()));
      bare.config.onDrop?.(args(src()));
    }).not.toThrow();
  });

  it.each([
    ['hitbox and edges report the edge', { edges: ['top'] }, true, 'top'],
    ['edges without a hitbox give null', { edges: ['top'] }, false, null],
    ['a hitbox without edges gives null', {}, true, null],
  ] as const)('drop: %s', (_, opts, withHitbox, want) => {
    const spy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const drops: DropEvent<Card>[] = [];
    const { config, element } = native(
      { ...opts, onDrop: (e: DropEvent<Card>) => drops.push(e) },
      withHitbox ? [provideDnd({ plugins: { hitbox: stubHitbox } })] : [],
    );
    config.onDrop?.({
      source: src(),
      self: self(element),
      location: loc(),
    } as never);
    expect(drops[0].edge).toBe(want);
    spy.mockRestore();
  });
});

describe('DropTarget directive', () => {
  @Component({
    selector: 'mm-drop-host',
    imports: [DropTarget],
    template: `<div
      mmDropTarget
      [accepts]="isCard"
      [canDrop]="veto()"
      (dragEnter)="enters.push($event)"
      (dragLeave)="leaves.push($event)"
      (dropped)="drops.push($event)"
      #t="mmDropTarget"
    ></div>`,
  })
  class Host {
    readonly isCard = isCard;
    readonly veto = signal<(() => boolean) | undefined>(undefined);
    readonly enters: unknown[] = [];
    readonly leaves: unknown[] = [];
    readonly drops: unknown[] = [];
    readonly t = viewChild.required<DropTarget<Card>>('t');
  }

  it('defaults, accepts, canDrop and outputs', () => {
    dropTargetMock.mockReset();
    TestBed.resetTestingModule();
    const fixture = TestBed.createComponent(Host);
    fixture.detectChanges();
    const config = dropTargetMock.mock.calls.at(-1)?.[0] as DropTargetConfig;
    const el = fixture.nativeElement.firstElementChild as HTMLElement;
    const source = {
      element: document.createElement('div'),
      dragHandle: null,
      data: boxData<Card>({ id: 'a' }),
    };
    const args = { source, input: {} as never, element: el } as never;
    expect(config.getIsSticky?.(args)).toBe(false);
    expect(config.getDropEffect?.(args)).toBe('move');
    expect(config.canDrop?.(args)).toBe(true);
    fixture.componentInstance.veto.set(() => false);
    fixture.detectChanges();
    expect(config.canDrop?.(args)).toBe(false);
    const ev = {
      source,
      self: {
        element: el,
        data: {},
        dropEffect: 'move',
        isActiveDueToStickiness: false,
      },
      location: {
        initial: {},
        current: { input: {}, dropTargets: [] },
        previous: { dropTargets: [] },
      },
    } as never;
    config.onDragEnter?.(ev);
    config.onDragLeave?.(ev);
    config.onDrop?.(ev);
    const h = fixture.componentInstance;
    expect([h.enters.length, h.leaves.length, h.drops.length]).toEqual([
      1, 1, 1,
    ]);
    TestBed.inject(DndSession).session.set(
      makeDragSession({
        targets: [{ element: el, data: {} }],
        sourceData: boxData<Card>({ id: 'a' }),
      }),
    );
    expect(h.t().dragOverData()).toEqual({ id: 'a' });
  });
});
