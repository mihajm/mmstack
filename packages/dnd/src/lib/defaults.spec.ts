import { Component, Injector, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';

import {
  dropTarget,
  injectDropTargetDefaults,
  provideDropTargetDefaults,
} from './element/drop-target';
import {
  injectDraggableDefaults,
  provideDraggableDefaults,
} from './element/draggable';
import { DndPointerEngine } from './element/pointer-engine';
import { injectDndDefaults, provideDndDefaults } from './provide';
import {
  injectReorderable,
  injectReorderableDefaults,
  provideReorderableDefaults,
  reorderable,
} from './sortable';

vi.mock('@atlaskit/pragmatic-drag-and-drop/element/adapter', () => ({
  draggable: vi.fn(() => () => undefined),
  dropTargetForElements: vi.fn(() => () => undefined),
  monitorForElements: vi.fn(() => () => undefined),
}));

/** Configure a fresh module with `providers`, then run `fn` in an injection context. */
function inCtx<T>(providers: unknown[], fn: () => T): T {
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({ providers });
  return TestBed.runInInjectionContext(fn);
}

describe('option defaults — DI token mechanics', () => {
  it('injectX returns null when nothing is registered', () => {
    inCtx([], () => {
      expect(injectDndDefaults()).toBeNull();
      expect(injectDraggableDefaults()).toBeNull();
      expect(injectDropTargetDefaults()).toBeNull();
      expect(injectReorderableDefaults()).toBeNull();
    });
  });

  it('common defaults are inherited by every primitive', () => {
    inCtx([provideDndDefaults({ engine: 'pointer' })], () => {
      expect(injectDndDefaults()).toEqual({ engine: 'pointer' });
      expect(injectDraggableDefaults()).toEqual({ engine: 'pointer' });
      expect(injectDropTargetDefaults()).toEqual({ engine: 'pointer' });
      expect(injectReorderableDefaults()).toEqual({ engine: 'pointer' });
    });
  });

  it('a per-primitive default layers over the common one (own key wins, others still inherit)', () => {
    inCtx(
      [
        provideDndDefaults({ engine: 'pointer' }),
        provideReorderableDefaults({ engine: 'native', axis: 'x' }),
      ],
      () => {
        // untouched primitives still inherit the common engine
        expect(injectDraggableDefaults()).toEqual({ engine: 'pointer' });
        expect(injectDropTargetDefaults()).toEqual({ engine: 'pointer' });
        // reorderable overrides engine and adds its own key
        expect(injectReorderableDefaults()).toEqual({ engine: 'native', axis: 'x' });
      },
    );
  });

  it('provideDraggableDefaults overrides the common engine for draggables only', () => {
    inCtx(
      [
        provideDndDefaults({ engine: 'native' }),
        provideDraggableDefaults({ engine: 'pointer' }),
      ],
      () => {
        expect(injectDraggableDefaults()).toEqual({ engine: 'pointer' });
        expect(injectDropTargetDefaults()).toEqual({ engine: 'native' }); // untouched sibling
      },
    );
  });

  it('a per-primitive default that omits engine still inherits the common engine', () => {
    inCtx(
      [
        provideDndDefaults({ engine: 'pointer' }),
        provideDropTargetDefaults({ sticky: true, dropEffect: 'copy' }),
      ],
      () =>
        expect(injectDropTargetDefaults()).toEqual({
          engine: 'pointer',
          sticky: true,
          dropEffect: 'copy',
        }),
    );
  });

  it('accepts a factory form (same `T | (() => T)` signature as provideDnd)', () => {
    inCtx([provideDndDefaults(() => ({ engine: 'pointer' }))], () =>
      expect(injectDndDefaults()).toEqual({ engine: 'pointer' }),
    );
  });

  it('injectX(injector) resolves OUTSIDE an injection context', () => {
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      providers: [provideDndDefaults({ engine: 'pointer' })],
    });
    const injector = TestBed.inject(Injector);
    // deliberately NOT inside runInInjectionContext — reads via injector.get
    expect(injectDndDefaults(injector)).toEqual({ engine: 'pointer' });
    expect(injectReorderableDefaults(injector)).toEqual({ engine: 'pointer' });
  });
});

describe('option defaults — reorderable consumption', () => {
  const list = () => signal([{ id: 1 }, { id: 2 }]);
  const key = (t: { id: number }) => t.id;

  it('injectReorderable picks up the common engine default', () => {
    const ctrl = inCtx([provideDndDefaults({ engine: 'pointer' })], () =>
      injectReorderable(list(), { key }),
    );
    expect(ctrl.engine).toBe('pointer');
  });

  it('applies partial per-primitive defaults; unset keys fall through to built-ins', () => {
    const ctrl = inCtx([provideReorderableDefaults({ axis: 'x' })], () =>
      injectReorderable(list(), { key }),
    );
    expect(ctrl.axis).toBe('x'); // from the default
    expect(ctrl.engine).toBe('native'); // built-in — nothing set it
  });

  it('a per-call option beats the DI default (absolute priority)', () => {
    const ctrl = inCtx([provideDndDefaults({ engine: 'pointer' })], () =>
      injectReorderable(list(), { key, engine: 'native' }),
    );
    expect(ctrl.engine).toBe('native');
  });

  it('the pure reorderable() ignores DI defaults — no injector, no magic', () => {
    const ctrl = inCtx([provideDndDefaults({ engine: 'pointer' })], () =>
      reorderable(list(), { key }),
    );
    expect(ctrl.engine).toBe('native'); // stays built-in despite the registered default
  });
});

describe('option defaults — element primitive consumption', () => {
  it('dropTarget adopts the common engine default (takes the pointer registration path)', () => {
    const spy = vi.spyOn(DndPointerEngine.prototype, 'registerDropTarget');

    @Component({ selector: 'mm-dt-host', template: '' })
    class Host {
      readonly ref = dropTarget<{ id: number }>({
        accepts: (d): d is { id: number } =>
          !!d && typeof d === 'object' && 'id' in d,
      });
    }

    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      providers: [provideDndDefaults({ engine: 'pointer' })],
    });
    const fixture = TestBed.createComponent(Host);
    fixture.detectChanges();

    expect(spy).toHaveBeenCalledTimes(1); // pointer path — a native target would call dropTargetForElements
    spy.mockRestore();
  });
});
