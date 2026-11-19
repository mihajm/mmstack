import { Injector, PLATFORM_ID, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { injectPaused, PAUSED_CONTEXT, providePaused } from './paused';
import {
  pausableComputed,
  pausableSignal,
  providePausableOptions,
  resolvePause,
} from './pausable';
import { pausablePureEffect } from './pausable-pure';
import { createTransaction } from './transaction';

const inCtx = <T>(fn: () => T): T => TestBed.runInInjectionContext(fn);

describe('resolvePause: opt-out and server', () => {
  it('pause: false is the opt-out inside a boundary, at the call site and as the app default', () => {
    TestBed.configureTestingModule({
      providers: [
        { provide: PAUSED_CONTEXT, useValue: signal(true) },
        providePausableOptions({ pause: false }),
      ],
    });
    inCtx(() => {
      expect(resolvePause({ pause: false })).toBeNull();
      expect(resolvePause()).toBeNull();
    });
  });

  it('on a server platform the default and pause: true never pause, even inside a boundary', () => {
    TestBed.configureTestingModule({
      providers: [
        { provide: PLATFORM_ID, useValue: 'server' },
        { provide: PAUSED_CONTEXT, useValue: signal(true) },
      ],
    });
    inCtx(() => {
      expect(resolvePause()).toBeNull();
      expect(resolvePause({ pause: true })).toBeNull();
    });
  });

  it('a predicate with a server injector never pauses', () => {
    const injector = Injector.create({
      providers: [{ provide: PLATFORM_ID, useValue: 'server' }],
    });
    expect(resolvePause({ pause: () => true, injector })).toBeNull();
  });

  it('a predicate with no window (real SSR) never pauses', () => {
    vi.stubGlobal('window', undefined);
    try {
      expect(resolvePause({ pause: () => true })).toBeNull();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('a predicate from providePausableOptions with no call-site options gates the signal', () => {
    const gate = signal(true);
    TestBed.configureTestingModule({
      providers: [providePausableOptions({ pause: gate })],
    });
    const s = inCtx(() => pausableSignal(0));
    expect(s()).toBe(0);
    s.set(1);
    expect(s()).toBe(0);
    gate.set(false);
    expect(s()).toBe(1);
  });
});

describe('resolvePause: the dev warning', () => {
  let warn: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  });
  afterEach(() => warn.mockRestore());

  it('an explicit pause: true with no boundary warns once', () => {
    inCtx(() => resolvePause({ pause: true }));
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('the omitted default with no boundary stays quiet', () => {
    inCtx(() => {
      resolvePause();
      resolvePause({});
    });
    expect(warn).not.toHaveBeenCalled();
  });
});

describe('pausable primitives with no options', () => {
  it('outside DI they work like signal and computed', () => {
    expect(pausableSignal(0)()).toBe(0);
    expect(pausableComputed(() => 1)()).toBe(1);
  });

  it('inside a boundary they hold while the context is paused', () => {
    const ctx = signal(false);
    TestBed.configureTestingModule({ providers: [providePaused(ctx)] });
    const src = signal(1);
    const s = inCtx(() => pausableSignal(1));
    const c = inCtx(() => pausableComputed(() => src() * 10));
    expect([s(), c()]).toEqual([1, 10]);
    ctx.set(true);
    s.set(2);
    src.set(2);
    expect([s(), c()]).toEqual([1, 10]);
    ctx.set(false);
    expect([s(), c()]).toEqual([2, 20]);
  });
});

describe('pausableSignal in a transaction', () => {
  it('an update inside a transaction is undone by an abort', () => {
    const s = pausableSignal(1, { pause: () => false });
    const t = createTransaction();
    t.enter(() => s.update((v) => v + 1));
    expect(s()).toBe(2);
    t.restore();
    expect(s()).toBe(1);
  });

  it('tx.set on a paused signal aborts back to the source, not the held view', () => {
    const paused = signal(false);
    const s = pausableSignal(1, { pause: paused });
    expect(s()).toBe(1);
    paused.set(true);
    s.set(2);
    expect(s()).toBe(1);
    const t = createTransaction();
    t.set(s, 3);
    t.restore();
    paused.set(false);
    expect(s()).toBe(2);
  });
});

describe('injectPaused', () => {
  it('outside a boundary it is never paused', () => {
    expect(inCtx(injectPaused)()).toBe(false);
  });

  it('inside a boundary it follows the source', () => {
    const ctx = signal(true);
    TestBed.configureTestingModule({ providers: [providePaused(ctx)] });
    const p = inCtx(injectPaused);
    expect(p()).toBe(true);
    ctx.set(false);
    expect(p()).toBe(false);
  });

  it('on the server it is never paused, even inside a boundary', () => {
    TestBed.configureTestingModule({
      providers: [
        { provide: PLATFORM_ID, useValue: 'server' },
        providePaused(signal(true)),
      ],
    });
    expect(inCtx(injectPaused)()).toBe(false);
  });
});

describe('pausablePureEffect', () => {
  it('is opt-in: with no pause option it runs inside a paused boundary', () => {
    TestBed.configureTestingModule({
      providers: [providePaused(signal(true))],
    });
    const src = signal(0);
    const seen: number[] = [];
    inCtx(() => pausablePureEffect(() => void seen.push(src())));
    TestBed.tick();
    src.set(1);
    TestBed.tick();
    expect(seen).toEqual([0, 1]);
  });
});
