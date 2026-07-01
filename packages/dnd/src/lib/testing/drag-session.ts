import type { DragSession } from '../session';

/**
 * Spec-only builder (never shipped — excluded from the lib build). A `DragSession`
 * with sensible defaults; pass `overrides` for the slice a test cares about. Owns
 * the `engine: 'native'` default so adding session fields stays a one-line change
 * here instead of across every spec.
 */
export function makeDragSession(
  overrides: Partial<DragSession> = {},
): DragSession {
  return {
    sourceEl: document.createElement('div'),
    sourceData: {},
    targets: [],
    pointer: { x: 0, y: 0 },
    kind: 'transfer',
    engine: 'native',
    ...overrides,
  };
}
