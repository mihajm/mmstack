import { computed, ElementRef, PLATFORM_ID, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';

import { movable, type MovableOptions } from './movable';
import type { Point } from './geometry';

function pe(
  type: string,
  x: number,
  y: number,
  mods: { ctrlKey?: boolean; shiftKey?: boolean } = {},
): Event {
  const e = new Event(type, { bubbles: true }) as Event & Record<string, unknown>;
  e['pointerId'] = 1;
  e['clientX'] = x;
  e['clientY'] = y;
  e['pageX'] = x;
  e['pageY'] = y;
  e['button'] = 0;
  e['shiftKey'] = !!mods.shiftKey;
  e['altKey'] = false;
  e['ctrlKey'] = !!mods.ctrlKey;
  e['metaKey'] = false;
  return e;
}

function setup(opts: MovableOptions = {}, start: Point = { x: 0, y: 0 }) {
  const el = document.createElement('div');
  document.body.appendChild(el);
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({
    providers: [{ provide: ElementRef, useValue: new ElementRef(el) }],
  });
  const position = signal<Point>(start);
  const ref = TestBed.runInInjectionContext(() => movable(position, opts));
  return { el, position, ref };
}

function tick() {
  TestBed.tick();
}

describe('movable', () => {
  it('writes position from the gesture delta once past the threshold', () => {
    const { el, position, ref } = setup({ activationThreshold: 3 });
    el.dispatchEvent(pe('pointerdown', 0, 0));
    tick();
    expect(ref.moving()).toBe(false);
    expect(position()).toEqual({ x: 0, y: 0 });

    el.dispatchEvent(pe('pointermove', 25, 10));
    tick();
    expect(ref.moving()).toBe(true);
    expect(position()).toEqual({ x: 25, y: 10 });
  });

  it('adds the delta to the captured base position', () => {
    const { el, position } = setup({ activationThreshold: 3 }, { x: 100, y: 50 });
    el.dispatchEvent(pe('pointerdown', 10, 10));
    tick();
    el.dispatchEvent(pe('pointermove', 30, 10));
    tick();
    expect(position()).toEqual({ x: 120, y: 50 });
  });

  it('snaps to the grid (and Ctrl bypasses it)', () => {
    const { el, position } = setup({ grid: { size: 10 }, activationThreshold: 3 });
    el.dispatchEvent(pe('pointerdown', 0, 0));
    tick();
    el.dispatchEvent(pe('pointermove', 12, 8));
    tick();
    expect(position()).toEqual({ x: 10, y: 10 });

    el.dispatchEvent(pe('pointermove', 12, 8, { ctrlKey: true }));
    tick();
    expect(position()).toEqual({ x: 12, y: 8 });
  });

  it('clamps within bounds', () => {
    const { el, position } = setup({
      bounds: { x: 0, y: 0, width: 50, height: 50 },
      activationThreshold: 3,
    });
    el.dispatchEvent(pe('pointerdown', 0, 0));
    tick();
    el.dispatchEvent(pe('pointermove', 100, 100));
    tick();
    expect(position()).toEqual({ x: 50, y: 50 });
  });

  it('does not move when disabled', () => {
    const disabled = signal(true);
    const { el, position, ref } = setup({ disabled, activationThreshold: 3 });
    el.dispatchEvent(pe('pointerdown', 0, 0));
    tick();
    el.dispatchEvent(pe('pointermove', 50, 0));
    tick();
    expect(position()).toEqual({ x: 0, y: 0 });
    expect(ref.moving()).toBe(false);
  });

  it('fires move lifecycle callbacks', () => {
    const events: string[] = [];
    const { el } = setup({
      activationThreshold: 3,
      onMoveStart: () => events.push('start'),
      onMove: () => events.push('move'),
      onMoveEnd: () => events.push('end'),
    });
    el.dispatchEvent(pe('pointerdown', 0, 0));
    tick();
    el.dispatchEvent(pe('pointermove', 20, 0));
    tick();
    el.dispatchEvent(pe('pointerup', 20, 0));
    tick();
    expect(events).toEqual(['start', 'move', 'end']);
  });

  it('returns an inert ref on the server', () => {
    const el = document.createElement('div');
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      providers: [
        { provide: ElementRef, useValue: new ElementRef(el) },
        { provide: PLATFORM_ID, useValue: 'server' },
      ],
    });
    const position = signal<Point>({ x: 0, y: 0 });
    const ref = TestBed.runInInjectionContext(() => movable(position));
    el.dispatchEvent(pe('pointerdown', 0, 0));
    tick();
    el.dispatchEvent(pe('pointermove', 50, 0));
    tick();
    expect(position()).toEqual({ x: 0, y: 0 });
    expect(ref.moving()).toBe(false);
  });
});

describe('movable — Figma-grade behaviours', () => {
  it('locks to the dominant axis while Shift is held', () => {
    const { el, position } = setup({ activationThreshold: 3 });
    el.dispatchEvent(pe('pointerdown', 0, 0));
    tick();
    el.dispatchEvent(pe('pointermove', 30, 8, { shiftKey: true }));
    tick();
    expect(position()).toEqual({ x: 30, y: 0 }); // y dominated out
  });

  it('moves a group by the same delta', () => {
    const other = signal<Point>({ x: 100, y: 100 });
    const { el, position } = setup({ group: () => [other], activationThreshold: 3 });
    el.dispatchEvent(pe('pointerdown', 0, 0));
    tick();
    el.dispatchEvent(pe('pointermove', 20, 5));
    tick();
    expect(position()).toEqual({ x: 20, y: 5 });
    expect(other()).toEqual({ x: 120, y: 105 });
  });

  it('group move with snapTargets reading the members does not loop', () => {
    // Regression: the move effect must read options untracked, else it depends
    // on the very `pos` signals group-move writes → infinite loop / freeze.
    const other = signal<Point>({ x: 100, y: 100 });
    const { el, position } = setup({
      activationThreshold: 3,
      size: () => ({ width: 20, height: 20 }),
      group: () => [other],
      snapTargets: () => [{ x: other().x, y: other().y, width: 20, height: 20 }],
    });
    el.dispatchEvent(pe('pointerdown', 0, 0));
    tick();
    el.dispatchEvent(pe('pointermove', 40, 0));
    tick();
    expect(position()).toEqual({ x: 40, y: 0 });
    expect(other()).toEqual({ x: 140, y: 100 });
  });

  it('snaps to a sibling edge and exposes alignment guides', () => {
    const { el, position, ref } = setup({
      activationThreshold: 3,
      size: () => ({ width: 20, height: 20 }),
      snapTargets: () => [{ x: 10, y: 0, width: 20, height: 20 }],
      snapThreshold: 6,
    });
    el.dispatchEvent(pe('pointerdown', 0, 0));
    tick();
    el.dispatchEvent(pe('pointermove', 8, 200));
    tick();
    expect(position().x).toBe(10); // left edge snapped to target left
    expect(ref.guides().some((g) => g.axis === 'x')).toBe(true);
  });

  it('nudges with arrow keys (Ctrl = large step)', () => {
    const { el, position } = setup({ keyboard: true, grid: { size: 10 } });
    el.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight' }));
    expect(position()).toEqual({ x: 10, y: 0 });
    el.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', ctrlKey: true }));
    expect(position()).toEqual({ x: 10, y: 100 }); // large = step * 10
  });

  it('captures the gesture base from `from` (for reflow-style rendering)', () => {
    // position starts at 0,0 but the rendered cell is elsewhere → `from` seeds it
    const { el, position } = setup({
      activationThreshold: 3,
      from: () => ({ x: 200, y: 50 }),
    });
    el.dispatchEvent(pe('pointerdown', 0, 0));
    tick();
    el.dispatchEvent(pe('pointermove', 20, 0));
    tick();
    expect(position()).toEqual({ x: 220, y: 50 }); // from-base + delta, not 0,0 + delta
  });

  it('reflow usage (from + onMove writing external state read back by `from`) is loop-free', () => {
    // Mirrors the grid example: position renders from a derived cell, onMove
    // writes shared layout state that the derived cell depends on. If this
    // looped, the test would hang.
    const external = signal(5);
    const derivedCell = computed<Point>(() => ({ x: external() * 10, y: 0 }));
    const { el } = setup({
      activationThreshold: 3,
      from: () => derivedCell(),
      onMove: () => external.update((v) => v + 1),
    });
    el.dispatchEvent(pe('pointerdown', 0, 0));
    tick();
    el.dispatchEvent(pe('pointermove', 20, 0));
    tick();
    el.dispatchEvent(pe('pointermove', 40, 0));
    tick();
    expect(external()).toBeGreaterThan(5); // reached here ⇒ no infinite loop
  });

  it('keyboard nudge moves the whole group by the same delta', () => {
    const other = signal<Point>({ x: 100, y: 100 });
    const { el, position } = setup({
      keyboard: { step: 10 },
      group: () => [other],
    });
    el.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight' }));
    expect(position()).toEqual({ x: 10, y: 0 });
    expect(other()).toEqual({ x: 110, y: 100 });
  });

  it('keyboard nudge respects bounds', () => {
    const { el, position } = setup({
      keyboard: { step: 10 },
      bounds: { x: 0, y: 0, width: 30, height: 30 },
      size: () => ({ width: 10, height: 10 }),
    });
    el.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft' }));
    expect(position()).toEqual({ x: 0, y: 0 }); // clamped at left edge
  });
});
