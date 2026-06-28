// Contract / probe suite — exercises the REAL @atlaskit packages (no mocks) to
// guard the assumptions @mmstack/dnd makes about pragmatic-drag-and-drop v2.
// We do NOT test pragmatic's own behaviour, only the seams we depend on, so a
// version bump that breaks our assumptions fails loudly here.
import {
  draggable,
  dropTargetForElements,
  monitorForElements,
} from '@atlaskit/pragmatic-drag-and-drop/element/adapter';
import {
  attachClosestEdge,
  extractClosestEdge,
} from '@atlaskit/pragmatic-drag-and-drop-hitbox/closest-edge';
import {
  dropTargetForExternal,
  monitorForExternal,
} from '@atlaskit/pragmatic-drag-and-drop/external/adapter';
import {
  containsFiles,
  getFiles,
} from '@atlaskit/pragmatic-drag-and-drop/external/file';
import { autoScrollForElements } from '@atlaskit/pragmatic-drag-and-drop-auto-scroll/element';
import { triggerPostMoveFlash } from '@atlaskit/pragmatic-drag-and-drop-flourish/trigger-post-move-flash';
import { announce as liveRegionAnnounce } from '@atlaskit/pragmatic-drag-and-drop-live-region';
import type { Input } from '@atlaskit/pragmatic-drag-and-drop/types';

import type {
  AnnouncePlugin,
  AutoScrollPlugin,
  HitboxPlugin,
  PostMoveFlash,
} from './provide';

// ── Compile-time guards (break the build if pragmatic's shape drifts) ──

// The monitor config still exposes every callback DndSession bridges from.
type MonitorCfg = NonNullable<Parameters<typeof monitorForElements>[0]>;
const _monitorCallbacks: (keyof MonitorCfg)[] = [
  'onDragStart',
  'onDrag',
  'onDropTargetChange',
  'onDrop',
];

// The real hitbox functions are structurally a HitboxPlugin — this is the whole
// reason hitbox can stay out of peerDependencies and be plugged in by the user.
const realHitbox: HitboxPlugin = { attachClosestEdge, extractClosestEdge };

function makeInput(clientX: number, clientY: number): Input {
  return {
    clientX,
    clientY,
    pageX: clientX,
    pageY: clientY,
    altKey: false,
    button: 0,
    buttons: 1,
    ctrlKey: false,
    metaKey: false,
    shiftKey: false,
  };
}

describe('pragmatic-drag-and-drop v2 adapter contract', () => {
  it('still exports draggable / dropTargetForElements / monitorForElements as functions', () => {
    expect(typeof draggable).toBe('function');
    expect(typeof dropTargetForElements).toBe('function');
    expect(typeof monitorForElements).toBe('function');
  });

  it('monitor config exposes the callbacks we bridge from', () => {
    expect(_monitorCallbacks).toEqual([
      'onDragStart',
      'onDrag',
      'onDropTargetChange',
      'onDrop',
    ]);
  });
});

describe('hitbox closest-edge contract', () => {
  it('the real functions satisfy our structural HitboxPlugin type', () => {
    expect(typeof realHitbox.attachClosestEdge).toBe('function');
    expect(typeof realHitbox.extractClosestEdge).toBe('function');
  });

  it('round-trips an edge token through attach → extract', () => {
    const el = document.createElement('div');
    el.getBoundingClientRect = () =>
      ({
        top: 0,
        left: 0,
        right: 100,
        bottom: 100,
        width: 100,
        height: 100,
        x: 0,
        y: 0,
        toJSON: () => ({}),
      }) as DOMRect;

    const nearTop = realHitbox.attachClosestEdge(
      {},
      { element: el, input: makeInput(50, 2), allowedEdges: ['top', 'bottom'] },
    );
    expect(realHitbox.extractClosestEdge(nearTop)).toBe('top');

    const nearBottom = realHitbox.attachClosestEdge(
      {},
      { element: el, input: makeInput(50, 98), allowedEdges: ['top', 'bottom'] },
    );
    expect(realHitbox.extractClosestEdge(nearBottom)).toBe('bottom');
  });

  it('extractClosestEdge returns null for data without a token', () => {
    expect(realHitbox.extractClosestEdge({})).toBeNull();
  });
});

describe('external adapter contract', () => {
  it('still exports the external adapter + file helpers as functions', () => {
    expect(typeof dropTargetForExternal).toBe('function');
    expect(typeof monitorForExternal).toBe('function');
    expect(typeof containsFiles).toBe('function');
    expect(typeof getFiles).toBe('function');
  });
});

describe('optional plugin contract', () => {
  // Compile-time: the real optional plugins satisfy our structural seam types,
  // so consumers can register them directly via `provideDnd({ plugins })`.
  const autoScroll: AutoScrollPlugin = autoScrollForElements;
  const flash: PostMoveFlash = triggerPostMoveFlash;
  const announce: AnnouncePlugin = liveRegionAnnounce;

  it('auto-scroll / flourish / live-region match the plugin seam', () => {
    expect(typeof autoScroll).toBe('function');
    expect(typeof flash).toBe('function');
    expect(typeof announce).toBe('function');
  });
});
