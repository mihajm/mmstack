import {
  createEnvironmentInjector,
  DestroyRef,
  EnvironmentInjector,
  PLATFORM_ID,
  signal,
} from '@angular/core';
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

  it('honors listener options in the fourth position', () => {
    const target = new EventTarget();
    const last = TestBed.runInInjectionContext(() =>
      signalFromEvent<CustomEvent<number>>(target, 'tick', null, {
        once: true,
      }),
    );
    const first = new CustomEvent('tick', { detail: 1 });
    target.dispatchEvent(first);
    target.dispatchEvent(new CustomEvent('tick', { detail: 2 }));
    expect(last()).toBe(first);
  });

  it('honors listener options in the fifth position after a project', () => {
    const target = new EventTarget();
    const last = TestBed.runInInjectionContext(() =>
      signalFromEvent<CustomEvent<number>, number>(
        target,
        'tick',
        0,
        (e) => e.detail,
        { once: true },
      ),
    );
    target.dispatchEvent(new CustomEvent('tick', { detail: 1 }));
    target.dispatchEvent(new CustomEvent('tick', { detail: 2 }));
    expect(last()).toBe(1);
  });

  it('returns the initial value and ignores events on the server', () => {
    TestBed.configureTestingModule({
      providers: [{ provide: PLATFORM_ID, useValue: 'server' }],
    });
    const target = new EventTarget();
    const last = TestBed.runInInjectionContext(() =>
      signalFromEvent<CustomEvent<number>, number>(
        target,
        'tick',
        42,
        (e) => e.detail,
      ),
    );
    const bare = TestBed.runInInjectionContext(() =>
      signalFromEvent(target, 'tick', null),
    );
    target.dispatchEvent(new CustomEvent('tick', { detail: 1 }));
    expect(last()).toBe(42);
    expect(bare()).toBeNull();
  });

  it('accepts an injector for a signal target outside an injection context', () => {
    const injector = TestBed.inject(EnvironmentInjector);
    const a = new EventTarget();
    const last = signalFromEvent<CustomEvent<number>, number>(
      signal<EventTarget | null>(a),
      'tick',
      0,
      (e) => e.detail,
      { injector },
    );
    TestBed.tick();
    a.dispatchEvent(new CustomEvent('tick', { detail: 3 }));
    expect(last()).toBe(3);
  });

  it.each([
    ['signal', true],
    ['static', false],
  ])(
    'detaches a %s target when the given destroyRef is destroyed',
    (_, sig) => {
      const child = createEnvironmentInjector(
        [],
        TestBed.inject(EnvironmentInjector),
      );
      const a = new EventTarget();
      const last = TestBed.runInInjectionContext(() =>
        signalFromEvent<CustomEvent<number>, number>(
          sig ? signal<EventTarget | null>(a) : a,
          'tick',
          0,
          (e) => e.detail,
          { destroyRef: child.get(DestroyRef) },
        ),
      );
      TestBed.tick();
      a.dispatchEvent(new CustomEvent('tick', { detail: 1 }));
      expect(last()).toBe(1);

      child.destroy();
      a.dispatchEvent(new CustomEvent('tick', { detail: 2 }));
      expect(last()).toBe(1);
    },
  );
});
