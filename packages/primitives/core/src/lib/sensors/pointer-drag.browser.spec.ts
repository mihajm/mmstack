import { Injector } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { userEvent } from 'vitest/browser';
import { pointerDrag, type PointerDragState } from './pointer-drag';

function setup() {
  const el = document.createElement('div');
  el.setAttribute(
    'style',
    'position: fixed; left: 20px; top: 20px; width: 100px; height: 100px; background: teal',
  );
  document.body.appendChild(el);
  const seen: PointerDragState[] = [];
  const drag = pointerDrag({
    target: el,
    throttle: 0,
    activationThreshold: 3,
    injector: TestBed.inject(Injector),
    onChange: (s) => seen.push(s),
  });
  TestBed.tick();
  const last = () => seen[seen.length - 1];
  return { el, drag, seen, last };
}

const press = (el: Element) =>
  userEvent.pointer({
    keys: '[MouseLeft>]',
    target: el,
    coords: { x: 10, y: 10 },
  });
const moveTo = (x: number, y: number) =>
  userEvent.pointer({ coords: { x, y } });
const release = () => userEvent.pointer('[/MouseLeft]');

afterEach(async () => {
  await userEvent.cleanup();
  document.body.replaceChildren();
});

describe('pointerDrag with a real mouse', () => {
  it('keeps tracking outside the element while it holds capture, then ends normally', async () => {
    const { el, last } = setup();
    await press(el);
    await moveTo(60, 60);
    await moveTo(400, 300);
    expect(last()).toMatchObject({
      active: true,
      start: { x: 30, y: 30 },
      current: { x: 400, y: 300 },
      delta: { x: 370, y: 270 },
    });
    expect(el.hasPointerCapture(last().pointerId as number)).toBe(true);

    await release();
    expect(last()).toMatchObject({ active: false, cancelled: false });
  });

  it('ends cancelled when the element loses capture', async () => {
    const { el, last } = setup();
    await press(el);
    await moveTo(80, 80);
    el.releasePointerCapture(last().pointerId as number);
    // the browser fires lostpointercapture before the next pointer event
    await moveTo(85, 85);
    expect(last()).toMatchObject({ active: false, cancelled: true });
    await release();
  });

  it('Escape cancels the gesture and releases capture', async () => {
    const { el, last } = setup();
    await press(el);
    await moveTo(80, 80);
    const id = last().pointerId as number;
    expect(el.hasPointerCapture(id)).toBe(true);

    await userEvent.keyboard('{Escape}');
    expect(last()).toMatchObject({ active: false, cancelled: true });
    expect(el.hasPointerCapture(id)).toBe(false);
    await release();
  });

  it('holding a modifier key mid-gesture does not cancel it', async () => {
    const { el, last } = setup();
    await press(el);
    await moveTo(80, 80);
    await userEvent.keyboard('{Shift>}');
    await moveTo(90, 95);
    expect(last()).toMatchObject({
      active: true,
      cancelled: false,
      current: { x: 90, y: 95 },
      modifiers: { shift: true },
    });
    await userEvent.keyboard('{/Shift}');
    await release();
    expect(last()).toMatchObject({ active: false, cancelled: false });
  });
});
