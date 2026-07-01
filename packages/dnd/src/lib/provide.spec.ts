import { Injector } from '@angular/core';
import { TestBed } from '@angular/core/testing';

import {
  injectDndConfig,
  provideDnd,
  resolveAutoScroll,
  resolveHitbox,
  resolvePostMoveFlash,
  type AutoScrollPlugin,
  type HitboxPlugin,
  type PostMoveFlash,
} from './provide';

const hitboxA: HitboxPlugin = {
  attachClosestEdge: (d) => d,
  extractClosestEdge: () => 'top',
};
const hitboxB: HitboxPlugin = {
  attachClosestEdge: (d) => d,
  extractClosestEdge: () => 'bottom',
};
const autoScroll: AutoScrollPlugin = () => () => undefined;
const flash: PostMoveFlash = () => undefined;

/** The workspace injector for the current TestBed module. */
const inj = () => TestBed.inject(Injector);

beforeEach(() => TestBed.resetTestingModule());

describe('injectDndConfig', () => {
  it('returns null when provideDnd was never called', () => {
    TestBed.runInInjectionContext(() => expect(injectDndConfig()).toBeNull());
  });

  it('returns the registered config', () => {
    TestBed.configureTestingModule({
      providers: [provideDnd({ plugins: { hitbox: hitboxA } })],
    });
    TestBed.runInInjectionContext(() =>
      expect(injectDndConfig()?.plugins?.hitbox).toBe(hitboxA),
    );
  });
});

describe('plugin resolution order (option → DI → null)', () => {
  it('returns null with neither option nor DI (warn: false to keep it quiet)', () => {
    expect(resolveHitbox(inj(), undefined, false)()).toBeNull();
    expect(resolveAutoScroll(inj(), undefined, false)()).toBeNull();
    expect(resolvePostMoveFlash(inj(), undefined, false)()).toBeNull();
  });

  it('falls back to the DI default', () => {
    TestBed.configureTestingModule({
      providers: [
        provideDnd({
          plugins: { hitbox: hitboxA, autoScroll, postMoveFlash: flash },
        }),
      ],
    });
    expect(resolveHitbox(inj())()).toBe(hitboxA);
    expect(resolveAutoScroll(inj())()).toBe(autoScroll);
    expect(resolvePostMoveFlash(inj())()).toBe(flash);
  });

  it('lets a per-call option override the DI default', () => {
    TestBed.configureTestingModule({
      providers: [provideDnd({ plugins: { hitbox: hitboxA } })],
    });
    expect(resolveHitbox(inj(), hitboxB)()).toBe(hitboxB);
  });

  it('uses a per-call option even with no DI config', () => {
    expect(resolveHitbox(inj(), hitboxB)()).toBe(hitboxB);
  });

  it('memoizes: resolves once, then returns the cached value', () => {
    TestBed.configureTestingModule({
      providers: [provideDnd({ plugins: { hitbox: hitboxA } })],
    });
    const get = resolveHitbox(inj());
    expect(get()).toBe(hitboxA);
    expect(get()).toBe(hitboxA); // second read is cached
  });
});

describe('missing-plugin dev warning (baked into the resolver)', () => {
  it('warns once when a required plugin resolves to null, then no-ops (memoized)', () => {
    const spy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const get = resolveHitbox(inj()); // warn defaults to true
    expect(get()).toBeNull();
    expect(get()).toBeNull(); // memoized → no second warn
    expect(spy).toHaveBeenCalledTimes(1);
    const msg = spy.mock.calls[0]?.[0] as string;
    expect(msg).toContain('hitbox');
    expect(msg).toContain('provideDnd');
    spy.mockRestore();
  });

  it('stays silent when warn: false (opportunistic read / built-in fallback)', () => {
    const spy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    expect(resolveAutoScroll(inj(), undefined, false)()).toBeNull();
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });
});
