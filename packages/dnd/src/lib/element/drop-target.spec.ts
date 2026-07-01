import { ElementRef, PLATFORM_ID } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import type { dropTargetForElements as PDDropTarget } from '@atlaskit/pragmatic-drag-and-drop/element/adapter';

import { signal } from '@angular/core';
import type { Edge } from '../internal/types';
import { trackRuns } from '../testing/reactivity';
import { makeDragSession } from '../testing/drag-session';

import { boxData, unboxData } from '../internal/payload';
import { provideDnd, type HitboxPlugin } from '../provide';
import { DndSession, type DragSession, type DropTargetHit } from '../session';
import { dropTarget } from './drop-target';
import type { DropEvent, DropTargetEvent } from '../internal/types';

type DropTargetConfig = Parameters<typeof PDDropTarget>[0];

const dropTargetMock = vi.fn();

vi.mock('@atlaskit/pragmatic-drag-and-drop/element/adapter', () => ({
  dropTargetForElements: (config: DropTargetConfig) => {
    dropTargetMock(config);
    return () => undefined;
  },
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
  beforeEach(() => dropTargetMock.mockReset());

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
      const ref = dropTarget<Card>({ accepts: isCard, edges: ['top'], disabled });
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
            hitbox: { attachClosestEdge: attach, extractClosestEdge: () => null },
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
        { provide: ElementRef, useValue: new ElementRef(document.createElement('div')) },
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
  beforeEach(() => dropTargetMock.mockReset());

  function build(opts: Record<string, unknown> = {}, providers: unknown[] = []) {
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
      makeSession([{ element, data: {} }], boxData<unknown>({ notACard: true })),
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
});
