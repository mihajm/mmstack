import { TestBed } from '@angular/core/testing';

import { driveGesture, type GestureAdapter } from './gesture';

function pe(type: string, x: number, y: number, button = 0): Event {
  const e = new Event(type, { bubbles: true }) as Event &
    Record<string, unknown>;
  e['pointerId'] = 1;
  e['clientX'] = x;
  e['clientY'] = y;
  e['pageX'] = x;
  e['pageY'] = y;
  e['button'] = button;
  e['shiftKey'] = e['altKey'] = e['ctrlKey'] = e['metaKey'] = false;
  return e;
}

describe('driveGesture', () => {
  it('hands the pressing button to begin', () => {
    const el = document.createElement('div');
    const began: (number | undefined)[] = [];
    const adapter: GestureAdapter = {
      begin: (_origin, _start, _modifiers, button) => {
        began.push(button);
        return true;
      },
      move: () => void 0,
      end: () => void 0,
      cancel: () => void 0,
    };

    TestBed.runInInjectionContext(() =>
      driveGesture(el, adapter, { activationThreshold: 0, buttons: [0, 1] }),
    );
    TestBed.tick();

    el.dispatchEvent(pe('pointerdown', 0, 0, 1));
    TestBed.tick();
    el.dispatchEvent(pe('pointermove', 10, 0, -1));
    TestBed.tick();
    el.dispatchEvent(pe('pointerup', 10, 0, 1));
    TestBed.tick();

    expect(began).toEqual([1]);
  });
});

function spyAdapter(claims = true) {
  return {
    begin: vi.fn(() => claims),
    move: vi.fn(),
    end: vi.fn(),
    cancel: vi.fn(),
  } satisfies GestureAdapter;
}

function press(el: HTMLElement, to: { x: number; y: number }) {
  el.dispatchEvent(pe('pointerdown', 0, 0));
  TestBed.tick();
  el.dispatchEvent(pe('pointermove', to.x, to.y));
  TestBed.tick();
}

describe('driveGesture contract', () => {
  it('only the innermost surface claims a press by default', () => {
    const outer = document.createElement('div');
    const inner = document.createElement('div');
    outer.appendChild(inner);
    document.body.appendChild(outer);
    const outerAdapter = spyAdapter();
    const innerAdapter = spyAdapter();
    TestBed.runInInjectionContext(() => {
      driveGesture(outer, outerAdapter, { activationThreshold: 0 });
      driveGesture(inner, innerAdapter, { activationThreshold: 0 });
    });
    TestBed.tick();

    press(inner, { x: 10, y: 0 });
    inner.dispatchEvent(pe('pointerup', 10, 0));
    TestBed.tick();

    expect(innerAdapter.begin).toHaveBeenCalled();
    expect(outerAdapter.begin).not.toHaveBeenCalled();
    outer.remove();
  });

  it('never sends move to an adapter that declined the press', () => {
    const el = document.createElement('div');
    const adapter = spyAdapter(false);
    TestBed.runInInjectionContext(() =>
      driveGesture(el, adapter, { activationThreshold: 0 }),
    );
    TestBed.tick();

    press(el, { x: 10, y: 0 });
    el.dispatchEvent(pe('pointermove', 20, 0));
    TestBed.tick();

    expect(adapter.begin).toHaveBeenCalled();
    expect(adapter.move).not.toHaveBeenCalled();
    expect(adapter.end).not.toHaveBeenCalled();
  });

  it('exposes the live pointer mid-gesture', () => {
    const el = document.createElement('div');
    const driver = TestBed.runInInjectionContext(() =>
      driveGesture(el, spyAdapter(), { activationThreshold: 0 }),
    );
    TestBed.tick();

    press(el, { x: 10, y: 4 });
    expect(driver.pointer).toEqual({ x: 10, y: 4 });
  });
});
