import { ElementRef, PLATFORM_ID } from '@angular/core';
import { TestBed } from '@angular/core/testing';

import { boxData, unboxData } from '../internal/payload';
import { trackRuns } from '../testing/reactivity';
import {
  DndExternalSession,
  fileDropTarget,
  monitorExternal,
  type FileDropEvent,
} from './external';

type Hook = (args: never) => unknown;
type DropCfg = {
  canDrop?: Hook;
  onDrop?: Hook;
  onDragEnter?: Hook;
  onDragLeave?: Hook;
  getIsSticky?: Hook;
  getDropEffect?: Hook;
  getData?: Hook;
};
type MonCfg = { onDragStart?: Hook; onDrop?: Hook; onDropTargetChange?: Hook };

const dropTargetMock = vi.fn();
const dropCleanups: ReturnType<typeof vi.fn>[] = [];
const monitorConfigs: MonCfg[] = [];
const monitorCleanups: ReturnType<typeof vi.fn>[] = [];

vi.mock(
  '@atlaskit/pragmatic-drag-and-drop/adapter/drop-target-for-external',
  () => ({
    dropTargetForExternal: (config: DropCfg) => {
      dropTargetMock(config);
      const cleanup = vi.fn();
      dropCleanups.push(cleanup);
      return cleanup;
    },
  }),
);

vi.mock(
  '@atlaskit/pragmatic-drag-and-drop/adapter/monitor-for-external',
  () => ({
    monitorForExternal: (config: MonCfg) => {
      monitorConfigs.push(config);
      const cleanup = vi.fn();
      monitorCleanups.push(cleanup);
      return cleanup;
    },
  }),
);

vi.mock('@atlaskit/pragmatic-drag-and-drop/utils/contains-files', () => ({
  containsFiles: ({ source }: { source: { types: string[] } }) =>
    (source.types ?? []).includes('Files'),
}));

vi.mock('@atlaskit/pragmatic-drag-and-drop/utils/get-files', () => ({
  getFiles: ({ source }: { source: { files?: File[] } }) => source.files ?? [],
}));

function lastDropConfig(): DropCfg {
  return dropTargetMock.mock.calls.at(-1)?.[0] as DropCfg;
}

/** The ambient session's `monitorForExternal` subscription: the first one made. */
function bridge(): MonCfg {
  return monitorConfigs[0];
}

function ext(elements: Element[], types = ['Files'], x = 0) {
  return {
    source: { types },
    location: {
      current: {
        input: { clientX: x, clientY: x },
        dropTargets: elements.map((element) => ({ element, data: {} })),
      },
    },
  } as never;
}

function dropArgs(
  current: { element: Element; data: Record<string | symbol, unknown> }[],
  files: File[] = [],
) {
  return {
    source: { types: ['Files'], files },
    location: {
      current: { dropTargets: current },
      previous: { dropTargets: [] },
    },
  } as never;
}

function setup(opts: Parameters<typeof fileDropTarget>[0] = {}) {
  const el = document.createElement('div');
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({
    providers: [{ provide: ElementRef, useValue: new ElementRef(el) }],
  });
  return TestBed.runInInjectionContext(() => {
    TestBed.inject(DndExternalSession);
    const ref = fileDropTarget(opts);
    return { el, ref, config: lastDropConfig() };
  });
}

function onServer() {
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
}

beforeEach(() => {
  dropTargetMock.mockReset();
  dropCleanups.length = 0;
  monitorConfigs.length = 0;
  monitorCleanups.length = 0;
});

describe('fileDropTarget — derived state', () => {
  it('seeds hover from the drag start', () => {
    const { el, ref } = setup();
    const other = document.createElement('div');
    expect(ref.isDragOver()).toBe(false);

    bridge().onDragStart?.(ext([el, other]));
    expect(ref.isDragOver()).toBe(true);
    expect(ref.isInnermost()).toBe(true);
  });

  it('follows the pointer between targets', () => {
    const { el, ref } = setup();
    const other = document.createElement('div');
    bridge().onDragStart?.(ext([]));
    expect(ref.isDragOver()).toBe(false);

    bridge().onDropTargetChange?.(ext([el]));
    expect(ref.isDragOver()).toBe(true);
    expect(ref.isInnermost()).toBe(true);

    bridge().onDropTargetChange?.(ext([other, el]));
    expect(ref.isDragOver()).toBe(true);
    expect(ref.isInnermost()).toBe(false);

    bridge().onDropTargetChange?.(ext([]));
    expect(ref.isDragOver()).toBe(false);
  });

  it('ignores drags without files', () => {
    const { el, ref } = setup();
    bridge().onDragStart?.(ext([el], ['text/uri-list']));
    expect(ref.isDragOver()).toBe(false);
    bridge().onDropTargetChange?.(ext([el], ['text/uri-list']));
    expect(ref.isDragOver()).toBe(false);
  });

  it('clears hover on drop', () => {
    const { el, ref } = setup();
    bridge().onDragStart?.(ext([el]));
    bridge().onDrop?.(ext([el]));
    expect(ref.isDragOver()).toBe(false);
    expect(ref.isInnermost()).toBe(false);
  });

  it('isDragOver / isInnermost stay stable across frames (hovered elements unchanged)', () => {
    const { el, ref } = setup();
    const over = trackRuns(() => ref.isDragOver());
    const inner = trackRuns(() => ref.isInnermost());
    TestBed.tick();
    bridge().onDragStart?.(ext([el]));
    TestBed.tick();
    const [o, n] = [over(), inner()];
    for (let i = 1; i <= 4; i++) {
      bridge().onDropTargetChange?.(ext([el], ['Files'], i));
      TestBed.tick();
    }
    expect(over()).toBe(o);
    expect(inner()).toBe(n);
  });
});

describe('fileDropTarget — registration', () => {
  it('only accepts drags that contain files', () => {
    const { config } = setup();
    expect(config.canDrop?.({ source: { types: ['Files'] } } as never)).toBe(
      true,
    );
    expect(
      config.canDrop?.({ source: { types: ['text/plain'] } } as never),
    ).toBe(false);
  });

  it('honours a custom canDrop (called with the drag types) and disabled', () => {
    const canDrop = vi.fn(() => false);
    const rejected = setup({ canDrop });
    expect(
      rejected.config.canDrop?.({ source: { types: ['Files'] } } as never),
    ).toBe(false);
    expect(canDrop).toHaveBeenCalledWith({ types: ['Files'] });

    const off = setup({ disabled: true });
    expect(
      off.config.canDrop?.({ source: { types: ['Files'] } } as never),
    ).toBe(false);
  });

  it('passes its data to pragmatic boxed', () => {
    const { config } = setup({ data: { slot: 1 } });
    const data = config.getData?.({} as never) as Record<symbol, unknown>;
    expect(unboxData(data)).toEqual({ slot: 1 });
  });

  it('forwards onDragEnter / onDragLeave', () => {
    const onDragEnter = vi.fn();
    const onDragLeave = vi.fn();
    const { config } = setup({ onDragEnter, onDragLeave });
    config.onDragEnter?.({} as never);
    expect(onDragEnter).toHaveBeenCalledTimes(1);
    expect(onDragLeave).not.toHaveBeenCalled();
    config.onDragLeave?.({} as never);
    expect(onDragLeave).toHaveBeenCalledTimes(1);
  });

  it('extracts files and unboxes the drop location', () => {
    const dropped: FileDropEvent[] = [];
    const { el, config } = setup({ onDrop: (e) => dropped.push(e) });
    const file = new File(['x'], 'a.txt');
    config.onDrop?.(dropArgs([{ element: el, data: boxData(1) }], [file]));
    expect(dropped).toHaveLength(1);
    expect(dropped[0].files).toEqual([file]);
    expect(dropped[0].location).toEqual({
      current: [{ element: el, data: 1 }],
      previous: [],
    });
  });

  it('a hover-only target (no onDrop) accepts a drop without throwing', () => {
    const { el, config } = setup();
    expect(() =>
      config.onDrop?.(dropArgs([{ element: el, data: {} }])),
    ).not.toThrow();
  });

  it('forwards sticky / dropEffect', () => {
    const { config } = setup({ sticky: true, dropEffect: 'copy' });
    expect(config.getIsSticky?.({} as never)).toBe(true);
    expect(config.getDropEffect?.({} as never)).toBe('copy');
  });

  it('releases its pragmatic registrations on destroy', () => {
    setup();
    TestBed.runInInjectionContext(() =>
      monitorExternal({ onDrop: () => undefined }),
    );
    expect(dropCleanups).toHaveLength(1);
    expect(monitorCleanups).toHaveLength(2);
    TestBed.resetTestingModule();
    for (const cleanup of [...dropCleanups, ...monitorCleanups])
      expect(cleanup).toHaveBeenCalledTimes(1);
  });

  it('is inert on the server', () => {
    onServer();
    const ref = TestBed.runInInjectionContext(() => {
      TestBed.inject(DndExternalSession);
      return fileDropTarget();
    });
    expect(ref.isDragOver()).toBe(false);
    expect(ref.isInnermost()).toBe(false);
    expect(dropTargetMock).not.toHaveBeenCalled();
    expect(monitorConfigs).toHaveLength(0);
  });
});

describe('monitorExternal', () => {
  it('derives isDragging from file drags only', () => {
    TestBed.resetTestingModule();
    const ref = TestBed.runInInjectionContext(() => monitorExternal());
    expect(ref.isDragging()).toBe(false);

    bridge().onDragStart?.(ext([], ['text/uri-list']));
    expect(ref.isDragging()).toBe(false);

    bridge().onDragStart?.(ext([]));
    expect(ref.isDragging()).toBe(true);

    bridge().onDrop?.(ext([]));
    expect(ref.isDragging()).toBe(false);
  });

  it('does not add a subscription without callbacks, adds one with', () => {
    TestBed.resetTestingModule();
    TestBed.inject(DndExternalSession);
    const before = monitorConfigs.length;
    TestBed.runInInjectionContext(() => monitorExternal());
    expect(monitorConfigs.length).toBe(before);
    TestBed.runInInjectionContext(() =>
      monitorExternal({ onDrop: () => undefined }),
    );
    expect(monitorConfigs.length).toBe(before + 1);
  });

  it('calls onDragStart with the types and onDrop with files and location', () => {
    TestBed.resetTestingModule();
    TestBed.inject(DndExternalSession);
    const onDragStart = vi.fn();
    const onDrop = vi.fn();
    TestBed.runInInjectionContext(() =>
      monitorExternal({ onDragStart, onDrop }),
    );
    const cfg = monitorConfigs.at(-1) as MonCfg;
    const el = document.createElement('div');
    const file = new File(['x'], 'a.txt');

    cfg.onDragStart?.(ext([]));
    expect(onDragStart).toHaveBeenCalledWith({ types: ['Files'] });

    cfg.onDrop?.(dropArgs([{ element: el, data: boxData('slot') }], [file]));
    expect(onDrop).toHaveBeenCalledWith({
      files: [file],
      location: { current: [{ element: el, data: 'slot' }], previous: [] },
    });
  });

  it('is inert on the server', () => {
    onServer();
    const ref = TestBed.runInInjectionContext(() =>
      monitorExternal({
        onDragStart: () => undefined,
        onDrop: () => undefined,
      }),
    );
    expect(ref.isDragging()).toBe(false);
    expect(monitorConfigs).toHaveLength(0);
  });
});
