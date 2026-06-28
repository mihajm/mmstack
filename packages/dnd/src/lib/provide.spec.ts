import { TestBed } from '@angular/core/testing';

import {
  injectDndConfig,
  missingPluginError,
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

beforeEach(() => TestBed.resetTestingModule());

describe('injectDndConfig', () => {
  it('returns null when provideDnd was never called', () => {
    TestBed.runInInjectionContext(() =>
      expect(injectDndConfig()).toBeNull(),
    );
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
  it('returns null with neither option nor DI', () => {
    TestBed.runInInjectionContext(() => {
      expect(resolveHitbox()).toBeNull();
      expect(resolveAutoScroll()).toBeNull();
      expect(resolvePostMoveFlash()).toBeNull();
    });
  });

  it('falls back to the DI default', () => {
    TestBed.configureTestingModule({
      providers: [
        provideDnd({
          plugins: { hitbox: hitboxA, autoScroll, postMoveFlash: flash },
        }),
      ],
    });
    TestBed.runInInjectionContext(() => {
      expect(resolveHitbox()).toBe(hitboxA);
      expect(resolveAutoScroll()).toBe(autoScroll);
      expect(resolvePostMoveFlash()).toBe(flash);
    });
  });

  it('lets a per-call option override the DI default', () => {
    TestBed.configureTestingModule({
      providers: [provideDnd({ plugins: { hitbox: hitboxA } })],
    });
    TestBed.runInInjectionContext(() =>
      expect(resolveHitbox(hitboxB)).toBe(hitboxB),
    );
  });

  it('uses a per-call option even with no DI config', () => {
    TestBed.runInInjectionContext(() =>
      expect(resolveHitbox(hitboxB)).toBe(hitboxB),
    );
  });

  it('empty provideDnd() resolves plugins to null', () => {
    TestBed.configureTestingModule({ providers: [provideDnd()] });
    TestBed.runInInjectionContext(() =>
      expect(resolveHitbox()).toBeNull(),
    );
  });
});

describe('missingPluginError', () => {
  it('names the plugin and the npm package', () => {
    const err = missingPluginError('hitbox', '@atlaskit/x-hitbox');
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toContain('hitbox');
    expect(err.message).toContain('@atlaskit/x-hitbox');
    expect(err.message).toContain('provideDnd');
  });
});
