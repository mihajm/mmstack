import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { signalFromEvent } from './signal-from-event';

describe('signalFromEvent', () => {
  it('emits the latest event from the target', () => {
    TestBed.runInInjectionContext(() => {
      const target = new EventTarget();
      const lastEvent = signalFromEvent<CustomEvent>(target, 'tick', null);

      expect(lastEvent()).toBeNull();

      const ev = new CustomEvent('tick', { detail: 1 });
      target.dispatchEvent(ev);

      expect(lastEvent()).toBe(ev);
    });
  });

  it('applies the project function when provided', () => {
    TestBed.runInInjectionContext(() => {
      const target = new EventTarget();
      const lastDetail = signalFromEvent<CustomEvent<number>, number>(
        target,
        'tick',
        0,
        (e) => e.detail,
      );

      expect(lastDetail()).toBe(0);

      target.dispatchEvent(new CustomEvent('tick', { detail: 5 }));
      expect(lastDetail()).toBe(5);

      target.dispatchEvent(new CustomEvent('tick', { detail: 7 }));
      expect(lastDetail()).toBe(7);
    });
  });

  it('re-attaches the listener when a signal target flips', () => {
    TestBed.runInInjectionContext(() => {
      const a = new EventTarget();
      const b = new EventTarget();
      const target = signal<EventTarget | null>(a);

      const last = signalFromEvent<CustomEvent<number>, number>(
        target,
        'tick',
        -1,
        (e) => e.detail,
      );

      // Effect attaches synchronously inside an injection context.
      TestBed.tick();

      a.dispatchEvent(new CustomEvent('tick', { detail: 1 }));
      expect(last()).toBe(1);

      // Flip to b — the listener should move with it.
      target.set(b);
      TestBed.tick();

      b.dispatchEvent(new CustomEvent('tick', { detail: 2 }));
      expect(last()).toBe(2);

      // The old target must no longer be observed.
      a.dispatchEvent(new CustomEvent('tick', { detail: 99 }));
      expect(last()).toBe(2);
    });
  });

  it('detaches the listener when the signal target becomes null', () => {
    TestBed.runInInjectionContext(() => {
      const a = new EventTarget();
      const target = signal<EventTarget | null>(a);

      const last = signalFromEvent<CustomEvent<number>, number>(
        target,
        'tick',
        0,
        (e) => e.detail,
      );

      TestBed.tick();
      a.dispatchEvent(new CustomEvent('tick', { detail: 1 }));
      expect(last()).toBe(1);

      target.set(null);
      TestBed.tick();

      a.dispatchEvent(new CustomEvent('tick', { detail: 99 }));
      expect(last()).toBe(1); // listener detached
    });
  });
});
