import { effect } from '@angular/core';
import { TestBed } from '@angular/core/testing';

/**
 * Spec-only helper (never shipped — excluded from the lib build). Wires an
 * effect that reads `source` and counts its runs; returns a getter for the
 * count. Drive your signals, call `TestBed.tick()`, then assert on the getter.
 *
 * The point of these counts is to PROVE fine-grained reactivity: a slice that
 * shouldn't recompute across drag frames stays flat.
 *
 * @example
 * const runs = trackRuns(() => ref.dragging());
 * TestBed.tick();            // initial → runs() === 1
 * session.set(...); TestBed.tick();
 * expect(runs()).toBe(2);    // flipped once, no churn
 */
export function trackRuns(source: () => unknown): () => number {
  let runs = 0;
  TestBed.runInInjectionContext(() => {
    effect(() => {
      source();
      runs++;
    });
  });
  return () => runs;
}
