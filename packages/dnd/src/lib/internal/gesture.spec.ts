import { TestBed } from '@angular/core/testing';

import { driveGesture, type GestureAdapter } from './gesture';

function pe(type: string, x: number, y: number, button = 0): Event {
  const e = new Event(type, { bubbles: true }) as Event & Record<string, unknown>;
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
