import { PLATFORM_ID } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import type { monitorForElements } from '@atlaskit/pragmatic-drag-and-drop/element/adapter';

import { boxDragData } from './internal';
import { monitorElements } from './monitor';

type CapturedArgs = Parameters<typeof monitorForElements>[0];

const monitorMock = vi.fn();
const cleanupMock = vi.fn();

vi.mock('@atlaskit/pragmatic-drag-and-drop/element/adapter', () => ({
  draggable: vi.fn(() => () => undefined),
  dropTargetForElements: vi.fn(() => () => undefined),
  monitorForElements: (args: CapturedArgs) => {
    monitorMock(args);
    return cleanupMock;
  },
}));

type Card = { id: string };
const isCard = (d: unknown): d is Card =>
  !!d && typeof d === 'object' && 'id' in d;

describe('monitorElements', () => {
  beforeEach(() => {
    monitorMock.mockReset();
    cleanupMock.mockReset();
  });

  it('flips isDragging and exposes typed source on drag start/drop', () => {
    const ref = TestBed.runInInjectionContext(() =>
      monitorElements<Card>({ accepts: isCard }),
    );
    const args = monitorMock.mock.calls.at(-1)?.[0] as CapturedArgs;

    args.onDragStart?.({
      source: { element: document.createElement('div'), dragHandle: null, data: boxDragData({ id: 'k' }) },
      location: {
        initial: {} as never,
        current: { input: {} as never, dropTargets: [] },
        previous: { dropTargets: [] },
      },
    });
    expect(ref.isDragging()).toBe(true);
    expect(ref.source()).toEqual({ data: { id: 'k' }, meta: {} });

    args.onDrop?.({
      source: { element: document.createElement('div'), dragHandle: null, data: boxDragData({ id: 'k' }) },
      location: {
        initial: {} as never,
        current: { input: {} as never, dropTargets: [] },
        previous: { dropTargets: [] },
      },
    });
    expect(ref.isDragging()).toBe(false);
    expect(ref.source()).toBeUndefined();
  });

  it('ignores drags that fail the accepts typeguard', () => {
    const ref = TestBed.runInInjectionContext(() =>
      monitorElements<Card>({ accepts: isCard }),
    );
    const args = monitorMock.mock.calls.at(-1)?.[0] as CapturedArgs;

    args.onDragStart?.({
      source: { element: document.createElement('div'), dragHandle: null, data: boxDragData('not-a-card') },
      location: {
        initial: {} as never,
        current: { input: {} as never, dropTargets: [] },
        previous: { dropTargets: [] },
      },
    });
    expect(ref.isDragging()).toBe(false);
    expect(ref.source()).toBeUndefined();
  });

  it('returns inert signals on the server platform', () => {
    TestBed.configureTestingModule({
      providers: [{ provide: PLATFORM_ID, useValue: 'server' }],
    });
    TestBed.runInInjectionContext(() => {
      const ref = monitorElements();
      expect(ref.isDragging()).toBe(false);
      expect(ref.source()).toBeUndefined();
    });
    expect(monitorMock).not.toHaveBeenCalled();
  });
});
