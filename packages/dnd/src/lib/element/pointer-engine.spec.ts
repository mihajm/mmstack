import { TestBed } from '@angular/core/testing';

import { DndSession } from '../session';
import {
  DndPointerEngine,
  resolveHits,
  type PointerDragSource,
  type PointerDropEntry,
} from './pointer-engine';

vi.mock('@atlaskit/pragmatic-drag-and-drop/element/adapter', () => ({
  monitorForElements: vi.fn(() => () => undefined),
  draggable: vi.fn(() => () => undefined),
  dropTargetForElements: vi.fn(() => () => undefined),
}));

const src = (data: Record<string | symbol, unknown> = { id: 1 }): PointerDragSource => ({
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
    const hits = resolveHits([inner, unregistered, outer, document.body], entries, src());
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
    expect(resolveHits([a, b], entries, src()).map((h) => h.element)).toEqual([b]);
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
    const dispose = engine.registerDropTarget(target, entry({ getData: () => ({ at: 1 }) }));
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

    const finalTargets = engine.end();
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
    engine.cancel();
  });

  it('move before begin is a safe no-op (no fabricated session)', () => {
    const { engine, session } = setup();
    engine.move(src(), 5, 5);
    expect(session()).toBeNull();
  });

  it('cancel mid-drag clears source + over so a later move is inert (destroy-mid-drag teardown)', () => {
    const { engine, session } = setup();
    const enter = vi.fn();
    const leave = vi.fn();
    const a = document.createElement('div');
    engine.registerDropTarget(a, entry({ onDragEnter: enter, onDragLeave: leave }));
    engine.stack = [a];

    engine.begin(src(), 0, 0);
    expect(enter).toHaveBeenCalledTimes(1);
    expect(engine.dragging()).toBe(true);

    engine.cancel(); // e.g. the dragging source component is destroyed
    expect(leave).toHaveBeenCalledTimes(1); // the still-over target is notified
    expect(engine.dragging()).toBe(false);
    expect(session()).toBeNull();

    // source + over are cleared: a stray move can't re-fabricate a session or re-enter
    engine.move(src(), 5, 5);
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
    engine.registerDropTarget(a, entry({
      onDragEnter: () => events.push('a:enter'),
      onDragLeave: () => events.push('a:leave'),
    }));
    engine.registerDropTarget(b, entry({
      onDragEnter: () => events.push('b:enter'),
      onDragLeave: () => events.push('b:leave'),
    }));
    engine.stack = [a];
    engine.begin(src(), 0, 0);
    engine.stack = [b];
    engine.move(src(), 1, 1);
    expect(events).toEqual(['a:enter', 'a:leave', 'b:enter']);
  });

  it('fires onDrop on the current targets at end', () => {
    const engine = setup();
    const drops: string[] = [];
    const a = document.createElement('div');
    engine.registerDropTarget(a, entry({ onDrop: () => drops.push('a') }));
    engine.stack = [a];
    engine.begin(src(), 0, 0);
    engine.end();
    expect(drops).toEqual(['a']);
  });

  it('cancel fires leave for anything still over, and no drop', () => {
    const engine = setup();
    const events: string[] = [];
    const a = document.createElement('div');
    engine.registerDropTarget(a, entry({
      onDragLeave: () => events.push('leave'),
      onDrop: () => events.push('drop'),
    }));
    engine.stack = [a];
    engine.begin(src(), 0, 0);
    engine.cancel();
    expect(events).toEqual(['leave']);
  });
});
