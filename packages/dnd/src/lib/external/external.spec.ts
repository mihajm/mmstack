import { ElementRef, PLATFORM_ID } from '@angular/core';
import { TestBed } from '@angular/core/testing';

import {
  DndExternalSession,
  fileDropTarget,
  monitorExternal,
  type ExternalSession,
  type FileDropEvent,
} from './external';

type Hook = (args: never) => unknown;
type DropCfg = {
  canDrop?: Hook;
  onDrop?: Hook;
  getIsSticky?: Hook;
  getDropEffect?: Hook;
  getData?: Hook;
};
type MonCfg = { onDragStart?: Hook; onDrop?: Hook; onDropTargetChange?: Hook };

const dropTargetMock = vi.fn();
const monitorConfigs: MonCfg[] = [];

vi.mock('@atlaskit/pragmatic-drag-and-drop/external/adapter', () => ({
  dropTargetForExternal: (config: DropCfg) => {
    dropTargetMock(config);
    return () => undefined;
  },
  monitorForExternal: (config: MonCfg) => {
    monitorConfigs.push(config);
    return () => undefined;
  },
}));

vi.mock('@atlaskit/pragmatic-drag-and-drop/external/file', () => ({
  containsFiles: ({ source }: { source: { types: string[] } }) =>
    (source.types ?? []).includes('Files'),
  getFiles: ({ source }: { source: { files?: File[] } }) => source.files ?? [],
}));

function lastDropConfig(): DropCfg {
  return dropTargetMock.mock.calls.at(-1)?.[0] as DropCfg;
}

function session(targets: Element[], types = ['Files']): ExternalSession {
  return { types, targets, pointer: { x: 0, y: 0 } };
}

function setup(opts: Parameters<typeof fileDropTarget>[0] = {}) {
  const el = document.createElement('div');
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({
    providers: [{ provide: ElementRef, useValue: new ElementRef(el) }],
  });
  return TestBed.runInInjectionContext(() => {
    const ext = TestBed.inject(DndExternalSession);
    const ref = fileDropTarget(opts);
    return { el, ext, ref, config: lastDropConfig() };
  });
}

beforeEach(() => {
  dropTargetMock.mockReset();
  monitorConfigs.length = 0;
});

describe('fileDropTarget — derived state', () => {
  it('derives isDragOver / isInnermost from the external session', () => {
    const { el, ext, ref } = setup();
    const other = document.createElement('div');
    expect(ref.isDragOver()).toBe(false);

    ext.session.set(session([el, other]));
    expect(ref.isDragOver()).toBe(true);
    expect(ref.isInnermost()).toBe(true);

    ext.session.set(session([other, el]));
    expect(ref.isInnermost()).toBe(false);

    ext.session.set(null);
    expect(ref.isDragOver()).toBe(false);
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

  it('honours a custom canDrop and disabled', () => {
    const rejected = setup({ canDrop: () => false });
    expect(
      rejected.config.canDrop?.({ source: { types: ['Files'] } } as never),
    ).toBe(false);

    const off = setup({ disabled: true });
    expect(
      off.config.canDrop?.({ source: { types: ['Files'] } } as never),
    ).toBe(false);
  });

  it('extracts files on drop', () => {
    const dropped: FileDropEvent[] = [];
    const { config } = setup({ onDrop: (e) => dropped.push(e) });
    const file = new File(['x'], 'a.txt');
    config.onDrop?.({
      source: { types: ['Files'], files: [file] },
      location: {
        current: { dropTargets: [] },
        previous: { dropTargets: [] },
      },
    } as never);
    expect(dropped[0].files).toEqual([file]);
  });

  it('forwards sticky / dropEffect', () => {
    const { config } = setup({ sticky: true, dropEffect: 'copy' });
    expect(config.getIsSticky?.({} as never)).toBe(true);
    expect(config.getDropEffect?.({} as never)).toBe('copy');
  });

  it('is inert on the server', () => {
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
    const ref = TestBed.runInInjectionContext(() => {
      TestBed.inject(DndExternalSession);
      return fileDropTarget();
    });
    expect(ref.isDragOver()).toBe(false);
    expect(dropTargetMock).not.toHaveBeenCalled();
  });
});

describe('monitorExternal', () => {
  it('derives isDragging from the external session', () => {
    TestBed.resetTestingModule();
    const ext = TestBed.inject(DndExternalSession);
    const ref = TestBed.runInInjectionContext(() => monitorExternal());
    expect(ref.isDragging()).toBe(false);
    ext.session.set(session([document.createElement('div')]));
    expect(ref.isDragging()).toBe(true);
  });

  it('stays idle for non-file external drags, activates for files (#8)', () => {
    TestBed.resetTestingModule();
    const ext = TestBed.inject(DndExternalSession);
    const ref = TestBed.runInInjectionContext(() => monitorExternal());
    // the ambient session bridge is the first monitorForExternal subscription
    const bridge = monitorConfigs[0];

    const loc = {
      current: { input: { clientX: 0, clientY: 0 }, dropTargets: [] },
    };
    bridge.onDragStart?.({
      source: { types: ['text/uri-list'] },
      location: loc,
    } as never);
    expect(ref.isDragging()).toBe(false);

    bridge.onDragStart?.({
      source: { types: ['Files'] },
      location: loc,
    } as never);
    expect(ref.isDragging()).toBe(true);

    ext.session.set(null);
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
});
