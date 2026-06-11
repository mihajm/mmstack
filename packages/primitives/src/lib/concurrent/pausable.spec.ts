/* eslint-disable @angular-eslint/component-selector */
import { Component, Injector, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { render } from '@testing-library/angular';
import { PAUSED_CONTEXT } from './activity';
import {
  pausableComputed,
  pausableEffect,
  pausableSignal,
  resolvePause,
} from './pausable';

const flush = async (detect: () => void) => {
  for (let i = 0; i < 5; i++) {
    detect();
    await Promise.resolve();
    await new Promise((r) => setTimeout(r));
  }
  detect();
};

describe('resolvePause', () => {
  it('returns null only for explicit pause: false (the bare-primitive opt-out)', () => {
    expect(resolvePause({ pause: false })).toBeNull();
  });

  it('returns a predicate as-is (covers Signal<boolean>; no injection context needed)', () => {
    const fn = () => true;
    expect(resolvePause({ pause: fn })).toBe(fn);
    const s = signal(false);
    expect(resolvePause({ pause: s })).toBe(s);
  });

  it('defaults to true (omitted / true) → resolves the ambient PAUSED_CONTEXT', () => {
    const ctx = signal(true);
    TestBed.configureTestingModule({
      providers: [{ provide: PAUSED_CONTEXT, useValue: ctx }],
    });
    TestBed.runInInjectionContext(() => {
      expect(resolvePause()).toBe(ctx); // omitted → true
      expect(resolvePause({})).toBe(ctx); // omitted → true
      expect(resolvePause({ pause: true })).toBe(ctx);
    });
  });

  it('for pause: true with an explicit injector, resolves PAUSED_CONTEXT from it', () => {
    const ctx = signal(true);
    const injector = Injector.create({
      providers: [{ provide: PAUSED_CONTEXT, useValue: ctx }],
    });
    expect(resolvePause({ pause: true, injector })).toBe(ctx);
  });
});

describe('pausableSignal', () => {
  it('pause: false → a plain writable signal (no holding)', () => {
    const s = pausableSignal(1, { pause: false });
    expect(s()).toBe(1);
    s.set(2);
    expect(s()).toBe(2);
  });

  it('holds the read while paused; writes land on the source and surface on resume', () => {
    const paused = signal(false);
    const s = pausableSignal(1, { pause: paused });
    expect(s()).toBe(1);

    paused.set(true);
    s.set(2);
    expect(s()).toBe(1); // frozen while paused
    s.update((v) => v + 10);
    expect(s()).toBe(1); // still frozen (update proxied to the source)

    paused.set(false);
    expect(s()).toBe(12); // latest source value (2 + 10) surfaces on resume
  });

  it('created while already paused: seeds the initial value, surfaces later writes on resume', () => {
    const paused = signal(true);
    const s = pausableSignal(1, { pause: paused });
    expect(s()).toBe(1); // first read seeds, even though born paused
    s.set(2);
    expect(s()).toBe(1); // still frozen on the seed
    paused.set(false);
    expect(s()).toBe(2); // the write surfaces on resume
  });
});

describe('pausableEffect', () => {
  it('pause: false → behaves like a plain effect (runs on dependency change)', async () => {
    @Component({ selector: 'p-eff-plain', template: `` })
    class Host {
      readonly dep = signal(0);
      runs = 0;
      constructor() {
        pausableEffect(
          () => {
            this.runs++;
            this.dep();
          },
          { pause: false },
        );
      }
    }
    const { fixture } = await render(Host);
    await flush(() => fixture.detectChanges());
    const host = fixture.componentInstance;
    expect(host.runs).toBe(1);

    host.dep.set(1);
    await flush(() => fixture.detectChanges());
    expect(host.runs).toBe(2);
  });

  it('skips the body while paused, collapses deps, and resumes', async () => {
    @Component({ selector: 'p-eff-paused', template: `` })
    class Host {
      readonly dep = signal(0);
      readonly paused = signal(false);
      runs = 0;
      constructor() {
        pausableEffect(
          () => {
            this.runs++;
            this.dep();
          },
          { pause: this.paused },
        );
      }
    }
    const { fixture } = await render(Host);
    await flush(() => fixture.detectChanges());
    const host = fixture.componentInstance;
    expect(host.runs).toBe(1); // initial run (not paused)

    host.dep.set(1);
    await flush(() => fixture.detectChanges());
    expect(host.runs).toBe(2); // ran on dep change

    host.paused.set(true);
    await flush(() => fixture.detectChanges());
    expect(host.runs).toBe(2); // re-evaluated (paused flipped) but body skipped

    host.dep.set(2);
    await flush(() => fixture.detectChanges());
    expect(host.runs).toBe(2); // dep change while paused does NOT run — deps collapsed

    host.paused.set(false);
    await flush(() => fixture.detectChanges());
    expect(host.runs).toBe(3); // resumes; body runs with the latest dep
  });

  it('created while already paused: body never runs until resume', async () => {
    @Component({ selector: 'p-eff-born-paused', template: `` })
    class Host {
      readonly dep = signal(0);
      readonly paused = signal(true);
      runs = 0;
      constructor() {
        pausableEffect(
          () => {
            this.runs++;
            this.dep();
          },
          { pause: this.paused },
        );
      }
    }
    const { fixture } = await render(Host);
    await flush(() => fixture.detectChanges());
    const host = fixture.componentInstance;
    expect(host.runs).toBe(0); // born paused → body never ran (only the predicate is read)

    host.dep.set(1);
    await flush(() => fixture.detectChanges());
    expect(host.runs).toBe(0); // dep change while paused → still nothing (deps collapsed)

    host.paused.set(false);
    await flush(() => fixture.detectChanges());
    expect(host.runs).toBe(1); // resumes → runs once with the latest dep
  });
});

describe('pausableComputed', () => {
  it('pause: false → a plain computed (recomputes on dependency change)', () => {
    const dep = signal(1);
    let runs = 0;
    const c = pausableComputed(
      () => {
        runs++;
        return dep() * 2;
      },
      { pause: false },
    );
    expect(c()).toBe(2);
    dep.set(5);
    expect(c()).toBe(10);
    expect(runs).toBe(2);
  });

  it('holds the value and collapses deps while paused, recomputes on resume', () => {
    const dep = signal(1);
    const paused = signal(false);
    let runs = 0;
    const c = pausableComputed(
      () => {
        runs++;
        return dep() * 2;
      },
      { pause: paused },
    );

    expect(c()).toBe(2); // seed
    expect(runs).toBe(1);

    paused.set(true);
    expect(c()).toBe(2); // held — returns cached without recomputing
    dep.set(5);
    expect(c()).toBe(2); // dep change while paused → no recompute (deps collapsed)
    dep.set(9);
    expect(c()).toBe(2);
    expect(runs).toBe(1); // body never re-ran while paused

    paused.set(false);
    expect(c()).toBe(18); // resume → recompute with the latest dep (9 * 2)
    expect(runs).toBe(2);
  });

  it('created while already paused: first read seeds via the computation, then holds until resume', () => {
    const dep = signal(1);
    const paused = signal(true);
    let runs = 0;
    const c = pausableComputed(
      () => {
        runs++;
        return dep() * 2;
      },
      { pause: paused },
    );

    expect(c()).toBe(2); // first read seeds via the computation even though born paused
    expect(runs).toBe(1);
    dep.set(5);
    expect(c()).toBe(2); // held — no recompute while paused (deps collapsed)
    expect(runs).toBe(1);

    paused.set(false);
    expect(c()).toBe(10); // resume → recompute with the latest dep (5 * 2)
    expect(runs).toBe(2);
  });
});
