import { TestBed } from '@angular/core/testing';

import { DndSession } from '../session';
import {
  DndPointerEngine,
  resolveHits,
  type PointerDragSource,
  type PointerDropEntry,
} from './pointer-engine';

vi.mock('@atlaskit/pragmatic-drag-and-drop/adapter/element-adapter', () => ({
  monitorForElements: vi.fn(() => () => undefined),
  draggable: vi.fn(() => () => undefined),
  dropTargetForElements: vi.fn(() => () => undefined),
}));

const src = (
  data: Record<string | symbol, unknown> = { id: 1 },
): PointerDragSource => ({
  el: document.createElement('div'),
  data,
  kind: 'transfer',
});

const entry = (over: Partial<PointerDropEntry> = {}): PointerDropEntry => ({
  accepts: () => true,
  ...over,
});

describe('resolveHits', () => {
  it('returns innermost-first accepted targets, skipping unregistered elements', () => {
    const inner = document.createElement('div');
    const outer = document.createElement('div');
    const unregistered = document.createElement('div');
    const entries = new Map<Element, PointerDropEntry>([
      [inner, entry({ getData: () => ({ slot: 'i' }) })],
      [outer, entry({ getData: () => ({ slot: 'o' }) })],
    ]);
    // elementsFromPoint order: topmost (innermost) first
    const hits = resolveHits(
      [inner, unregistered, outer, document.body],
      entries,
      src(),
    );
    expect(hits.map((h) => h.element)).toEqual([inner, outer]);
    expect(hits.map((h) => h.data)).toEqual([{ slot: 'i' }, { slot: 'o' }]);
  });

  it('filters out targets whose accepts rejects the source', () => {
    const a = document.createElement('div');
    const b = document.createElement('div');
    const entries = new Map<Element, PointerDropEntry>([
      [a, entry({ accepts: () => false })],
      [b, entry()],
    ]);
    expect(resolveHits([a, b], entries, src()).map((h) => h.element)).toEqual([
      b,
    ]);
  });

  it('filters out targets whose canDrop returns false', () => {
    const a = document.createElement('div');
    const entries = new Map<Element, PointerDropEntry>([
      [a, entry({ canDrop: () => false })],
    ]);
    expect(resolveHits([a], entries, src())).toEqual([]);
  });

  it('passes the source data to accepts / canDrop', () => {
    const a = document.createElement('div');
    let seen: unknown;
    const entries = new Map<Element, PointerDropEntry>([
      [a, entry({ accepts: (d) => ((seen = d), true) })],
    ]);
    resolveHits([a], entries, src({ id: 42 }));
    expect(seen).toEqual({ id: 42 });
  });

  it('applies attachEdge with the point, so the hit data carries the live edge token', () => {
    const a = document.createElement('div');
    const entries = new Map<Element, PointerDropEntry>([
      [
        a,
        entry({
          getData: () => ({ slot: 'a' }),
          attachEdge: (d, p) => ({ ...d, edge: p.y < 50 ? 'top' : 'bottom' }),
        }),
      ],
    ]);
    expect(resolveHits([a], entries, src(), { x: 0, y: 10 })[0].data).toEqual({
      slot: 'a',
      edge: 'top',
    });
    expect(resolveHits([a], entries, src(), { x: 0, y: 90 })[0].data).toEqual({
      slot: 'a',
      edge: 'bottom',
    });
  });

  it('leaves attachEdge untouched when no point is passed (edge detection off)', () => {
    const a = document.createElement('div');
    const attachEdge = vi.fn((d: Record<string | symbol, unknown>) => ({
      ...d,
      edge: 'top',
    }));
    const entries = new Map<Element, PointerDropEntry>([
      [a, entry({ getData: () => ({ slot: 'a' }), attachEdge })],
    ]);
    expect(resolveHits([a], entries, src())[0].data).toEqual({ slot: 'a' });
    expect(attachEdge).not.toHaveBeenCalled();
  });
});

class StubEngine extends DndPointerEngine {
  stack: Element[] = [];
  protected override elementsAt(): readonly Element[] {
    return this.stack;
  }
}

describe('DndPointerEngine', () => {
  function setup() {
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      providers: [{ provide: DndPointerEngine, useClass: StubEngine }],
    });
    const engine = TestBed.inject(DndPointerEngine) as StubEngine;
    const session = TestBed.inject(DndSession).session;
    return { engine, session };
  }

  it('begin/move/end drive the unified session, tagged engine:"pointer"', () => {
    const { engine, session } = setup();
    const target = document.createElement('div');
    const dispose = engine.registerDropTarget(
      target,
      entry({ getData: () => ({ at: 1 }) }),
    );
    engine.stack = [target, document.body];
    const source = src();

    expect(engine.dragging()).toBe(false);
    engine.begin(source, 10, 20);
    expect(engine.dragging()).toBe(true);
    const s = session();
    expect(s?.engine).toBe('pointer');
    expect(s?.sourceEl).toBe(source.el);
    expect(s?.pointer).toEqual({ x: 10, y: 20 });
    expect(s?.targets.map((t) => t.element)).toEqual([target]);

    engine.move(source, 11, 22);
    expect(session()?.pointer).toEqual({ x: 11, y: 22 });

    const finalTargets = engine.end(source);
    expect(finalTargets.map((t) => t.element)).toEqual([target]);
    expect(session()).toBeNull(); // cleared
    expect(engine.dragging()).toBe(false);
    dispose();
  });

  it('a disposed drop target no longer appears in hits', () => {
    const { engine, session } = setup();
    const target = document.createElement('div');
    const dispose = engine.registerDropTarget(target, entry());
    engine.stack = [target];
    const source = src();
    dispose();
    engine.begin(source, 0, 0);
    expect(session()?.targets).toHaveLength(0);
    engine.cancel(source);
  });

  it('move before begin is a safe no-op (no fabricated session)', () => {
    const { engine, session } = setup();
    engine.move(src(), 5, 5);
    expect(session()).toBeNull();
  });

  it('feeds the live pointer to attachEdge, so session targets carry a fresh edge token per frame', () => {
    const { engine, session } = setup();
    const target = document.createElement('div');
    engine.registerDropTarget(
      target,
      entry({
        getData: () => ({}),
        attachEdge: (d, p) => ({ ...d, edge: p.y < 50 ? 'top' : 'bottom' }),
      }),
    );
    engine.stack = [target];
    const s = src();
    engine.begin(s, 0, 10);
    expect(session()?.targets[0].data).toEqual({ edge: 'top' });
    engine.move(s, 0, 90);
    expect(session()?.targets[0].data).toEqual({ edge: 'bottom' });
    engine.cancel(s);
  });

  it('cancel mid-drag clears source + over so a later move is inert (destroy-mid-drag teardown)', () => {
    const { engine, session } = setup();
    const enter = vi.fn();
    const leave = vi.fn();
    const a = document.createElement('div');
    engine.registerDropTarget(
      a,
      entry({ onDragEnter: enter, onDragLeave: leave }),
    );
    engine.stack = [a];

    const s = src();
    engine.begin(s, 0, 0);
    expect(enter).toHaveBeenCalledTimes(1);
    expect(engine.dragging()).toBe(true);

    engine.cancel(s); // e.g. the dragging source component is destroyed
    expect(leave).toHaveBeenCalledTimes(1); // the still-over target is notified
    expect(engine.dragging()).toBe(false);
    expect(session()).toBeNull();

    // source + over are cleared: a stray move can't re-fabricate a session or re-enter
    engine.move(s, 5, 5);
    expect(session()).toBeNull();
    expect(enter).toHaveBeenCalledTimes(1); // no phantom re-enter after teardown
  });
});

describe('DndPointerEngine — enter/leave/drop dispatch', () => {
  function setup() {
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      providers: [{ provide: DndPointerEngine, useClass: StubEngine }],
    });
    return TestBed.inject(DndPointerEngine) as StubEngine;
  }

  it('fires onDragEnter for targets already under the pointer at begin', () => {
    const engine = setup();
    const events: string[] = [];
    const a = document.createElement('div');
    engine.registerDropTarget(
      a,
      entry({ onDragEnter: () => events.push('enter') }),
    );
    engine.stack = [a];
    engine.begin(src(), 0, 0);
    expect(events).toEqual(['enter']);
  });

  it('fires leave on the old target and enter on the new as the pointer moves', () => {
    const engine = setup();
    const events: string[] = [];
    const a = document.createElement('div');
    const b = document.createElement('div');
    engine.registerDropTarget(
      a,
      entry({
        onDragEnter: () => events.push('a:enter'),
        onDragLeave: () => events.push('a:leave'),
      }),
    );
    engine.registerDropTarget(
      b,
      entry({
        onDragEnter: () => events.push('b:enter'),
        onDragLeave: () => events.push('b:leave'),
      }),
    );
    engine.stack = [a];
    const s = src();
    engine.begin(s, 0, 0);
    engine.stack = [b];
    engine.move(s, 1, 1);
    expect(events).toEqual(['a:enter', 'a:leave', 'b:enter']);
  });

  it('fires onDrop on the current targets at end', () => {
    const engine = setup();
    const drops: string[] = [];
    const a = document.createElement('div');
    engine.registerDropTarget(a, entry({ onDrop: () => drops.push('a') }));
    engine.stack = [a];
    const s = src();
    engine.begin(s, 0, 0);
    engine.end(s);
    expect(drops).toEqual(['a']);
  });

  it('cancel fires leave for anything still over, and no drop', () => {
    const engine = setup();
    const events: string[] = [];
    const a = document.createElement('div');
    engine.registerDropTarget(
      a,
      entry({
        onDragLeave: () => events.push('leave'),
        onDrop: () => events.push('drop'),
      }),
    );
    engine.stack = [a];
    const s = src();
    engine.begin(s, 0, 0);
    engine.cancel(s);
    expect(events).toEqual(['leave']);
  });
});

describe('DndPointerEngine: one drag at a time', () => {
  function setup() {
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      providers: [{ provide: DndPointerEngine, useClass: StubEngine }],
    });
    const engine = TestBed.inject(DndPointerEngine) as StubEngine;
    const session = TestBed.inject(DndSession).session;
    return { engine, session };
  }

  it('refuses a second begin, ignores its moves and ends, and keeps the first drag intact', () => {
    const { engine, session } = setup();
    const drops: unknown[] = [];
    const t = document.createElement('div');
    engine.registerDropTarget(t, entry({ onDrop: (s) => drops.push(s.data) }));
    engine.stack = [t];
    const a = src({ id: 'a' });
    const b = src({ id: 'b' });
    expect(engine.begin(a, 0, 0)).toBe(true);
    expect(engine.begin(b, 50, 50)).toBe(false);
    expect(session()?.sourceData).toEqual({ id: 'a' });
    expect(session()?.pointer).toEqual({ x: 0, y: 0 });
    engine.move(b, 70, 70);
    expect(session()?.pointer).toEqual({ x: 0, y: 0 });
    expect(engine.end(b)).toEqual([]);
    expect(drops).toEqual([]);
    expect(engine.dragging()).toBe(true);
    engine.cancel(b);
    expect(engine.dragging()).toBe(true);
    engine.move(a, 5, 5);
    expect(session()?.pointer).toEqual({ x: 5, y: 5 });
    expect(engine.end(a).map((h) => h.element)).toEqual([t]);
    expect(drops).toEqual([{ id: 'a' }]);
    expect(session()).toBeNull();
    expect(engine.begin(b, 0, 0)).toBe(true);
  });
});

describe('DndPointerEngine: registry and hit-testing contract', () => {
  function setup() {
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      providers: [{ provide: DndPointerEngine, useClass: StubEngine }],
    });
    return TestBed.inject(DndPointerEngine) as StubEngine;
  }

  it('an old disposer never removes a newer registration on the same element', () => {
    const engine = setup();
    const el = document.createElement('div');
    const dropA = vi.fn();
    const dropB = vi.fn();
    const disposeA = engine.registerDropTarget(el, entry({ onDrop: dropA }));
    engine.registerDropTarget(el, entry({ onDrop: dropB }));
    disposeA();
    engine.stack = [el];
    const s = src();
    engine.begin(s, 0, 0);
    engine.end(s);
    expect(dropB).toHaveBeenCalledTimes(1);
    expect(dropA).not.toHaveBeenCalled();
  });

  it('hit-tests with document.elementsFromPoint by default', () => {
    TestBed.resetTestingModule();
    const engine = TestBed.inject(DndPointerEngine);
    const session = TestBed.inject(DndSession).session;
    const el = document.createElement('div');
    engine.registerDropTarget(el, entry());
    const original = document.elementsFromPoint;
    document.elementsFromPoint = vi.fn(() => [el]);
    try {
      const s = src();
      engine.begin(s, 3, 4);
      expect(document.elementsFromPoint).toHaveBeenCalledWith(3, 4);
      expect(session()?.targets.map((t) => t.element)).toEqual([el]);
      engine.cancel(s);
    } finally {
      document.elementsFromPoint = original;
    }
  });

  it('enter fires once per target while the pointer stays over nested targets', () => {
    const engine = setup();
    const outer = document.createElement('div');
    const inner = document.createElement('div');
    const enter = vi.fn();
    const leave = vi.fn();
    engine.registerDropTarget(
      outer,
      entry({ onDragEnter: enter, onDragLeave: leave }),
    );
    engine.registerDropTarget(
      inner,
      entry({ onDragEnter: enter, onDragLeave: leave }),
    );
    engine.stack = [inner, outer];
    const s = src();
    engine.begin(s, 0, 0);
    engine.move(s, 1, 1);
    engine.move(s, 2, 2);
    expect(enter).toHaveBeenCalledTimes(2);
    expect(leave).not.toHaveBeenCalled();
  });

  it.each(['move away', 'end', 'cancel'] as const)(
    'a target disposed while under the pointer is skipped on %s',
    (how) => {
      const engine = setup();
      const gone = document.createElement('div');
      const kept = document.createElement('div');
      const keptDrop = vi.fn();
      const dispose = engine.registerDropTarget(gone, entry());
      engine.registerDropTarget(kept, entry({ onDrop: keptDrop }));
      engine.stack = [gone, kept];
      const s = src();
      engine.begin(s, 0, 0);
      dispose();
      if (how === 'move away') {
        engine.stack = [];
        expect(() => engine.move(s, 9, 9)).not.toThrow();
        engine.cancel(s);
      } else if (how === 'end') {
        expect(() => engine.end(s)).not.toThrow();
        expect(keptDrop).toHaveBeenCalledTimes(1);
      } else {
        expect(() => engine.cancel(s)).not.toThrow();
      }
      expect(engine.dragging()).toBe(false);
    },
  );
});
