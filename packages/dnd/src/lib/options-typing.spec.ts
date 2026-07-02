import type { CreateDraggableOptions } from './element/draggable';
import type { CreateDropTargetOptions } from './element/drop-target';
import type { Edge } from './internal/types';
import type { HitboxPlugin } from './provide';
import type { ReorderableOptions } from './sortable/types';

// These specs assert COMPILE-TIME behaviour: each `@ts-expect-error` must flag a real
// error (an unused `@ts-expect-error` fails the build), so they guard the engine-
// discriminated option unions — native-only options are forbidden with engine:'pointer'.

type Card = { id: string };
const isCard = (d: unknown): d is Card =>
  !!d && typeof d === 'object' && 'id' in d;
const card: Card = { id: 'a' };
const edges: Edge[] = ['top'];
const hitbox: HitboxPlugin = {
  attachClosestEdge: (d) => d,
  extractClosestEdge: () => null,
};

describe('engine-discriminated options (compile-time safety)', () => {
  it('dropTarget: native-only options forbidden with engine:"pointer"', () => {
    // valid — native default keeps the native-only options
    const nativeDT: CreateDropTargetOptions<Card> = {
      accepts: isCard,
      edges,
      sticky: true,
      dropEffect: 'copy',
      hitbox,
    };
    // valid — pointer with only shared options
    const pointerDT: CreateDropTargetOptions<Card> = {
      accepts: isCard,
      engine: 'pointer',
      canDrop: () => true,
    };
    expect(typeof nativeDT.accepts).toBe('function');
    expect(pointerDT.engine).toBe('pointer');

    // @ts-expect-error `edges` is native-only
    const badEdges: CreateDropTargetOptions<Card> = {
      accepts: isCard,
      engine: 'pointer',
      edges,
    };
    // @ts-expect-error `hitbox` is native-only
    const badHitbox: CreateDropTargetOptions<Card> = {
      accepts: isCard,
      engine: 'pointer',
      hitbox,
    };
    // @ts-expect-error `sticky` is native-only
    const badSticky: CreateDropTargetOptions<Card> = {
      accepts: isCard,
      engine: 'pointer',
      sticky: true,
    };
    void badEdges;
    void badHitbox;
    void badSticky;
  });

  it('draggable: hitbox forbidden with engine:"pointer"', () => {
    const nativeD: CreateDraggableOptions<Card> = { data: card, hitbox };
    const pointerD: CreateDraggableOptions<Card> = {
      data: card,
      engine: 'pointer',
    };
    expect(nativeD.data).toBeDefined();
    expect(pointerD.engine).toBe('pointer');

    // @ts-expect-error `hitbox` is native-only
    const bad: CreateDraggableOptions<Card> = {
      data: card,
      engine: 'pointer',
      hitbox,
    };
    void bad;
  });

  it('draggable: activationThreshold is pointer-only', () => {
    const pointerD: CreateDraggableOptions<Card> = {
      data: card,
      engine: 'pointer',
      activationThreshold: 8,
    };
    expect(pointerD.activationThreshold).toBe(8);

    // @ts-expect-error `activationThreshold` is pointer-only
    const bad: CreateDraggableOptions<Card> = {
      data: card,
      activationThreshold: 8,
    };
    void bad;
  });

  it('reorderable: insert / onItemInserted forbidden with engine:"pointer"', () => {
    const nativeR: ReorderableOptions<Card, string> = {
      key: (c) => c.id,
      insert: { accepts: () => true, create: () => card },
      onItemInserted: () => undefined,
    };
    const pointerR: ReorderableOptions<Card, string> = {
      key: (c) => c.id,
      engine: 'pointer',
      axis: 'x', // shared options are fine
    };
    expect(typeof nativeR.key).toBe('function');
    expect(pointerR.engine).toBe('pointer');

    // @ts-expect-error `insert` is native-only
    const badInsert: ReorderableOptions<Card, string> = {
      key: (c) => c.id,
      engine: 'pointer',
      insert: { accepts: () => true, create: () => card },
    };
    // @ts-expect-error `onItemInserted` is native-only
    const badCb: ReorderableOptions<Card, string> = {
      key: (c) => c.id,
      engine: 'pointer',
      onItemInserted: () => undefined,
    };
    void badInsert;
    void badCb;
  });

  it('reorderable: activationThreshold is pointer-only', () => {
    const pointerR: ReorderableOptions<Card, string> = {
      key: (c) => c.id,
      engine: 'pointer',
      activationThreshold: 10,
    };
    expect(pointerR.activationThreshold).toBe(10);

    // @ts-expect-error `activationThreshold` is pointer-only
    const bad: ReorderableOptions<Card, string> = {
      key: (c) => c.id,
      activationThreshold: 10,
    };
    void bad;
  });
});
