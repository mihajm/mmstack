import { createEnvironmentInjector, EnvironmentInjector } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  isStrictSentinels,
  loading,
  SentinelLeakError,
  setStrictSentinels,
} from './sentinel';
import { provideStrictSentinels } from './strict-sentinels';

describe('provideStrictSentinels', () => {
  afterEach(() => {
    TestBed.resetTestingModule();
    setStrictSentinels(false);
  });

  it('is soft without the provider: a coercion renders, it does not throw', () => {
    TestBed.configureTestingModule({});
    TestBed.inject(EnvironmentInjector);
    expect(isStrictSentinels()).toBe(false);
    expect(String(loading('t'))).toBe('[mmstack loading]');
  });

  it('turns the policy strict for the life of the providing injector and restores it on destroy', () => {
    const root = TestBed.inject(EnvironmentInjector);
    const env = createEnvironmentInjector([provideStrictSentinels()], root);
    expect(isStrictSentinels()).toBe(true);
    expect(() => String(loading('t'))).toThrow(SentinelLeakError);
    env.destroy();
    expect(isStrictSentinels()).toBe(false);
    expect(String(loading('t'))).toBe('[mmstack loading]');
  });

  it('a nested injector can relax it and hands the outer policy back when it goes', () => {
    const root = TestBed.inject(EnvironmentInjector);
    const strict = createEnvironmentInjector([provideStrictSentinels()], root);
    const soft = createEnvironmentInjector(
      [provideStrictSentinels(false)],
      strict,
    );
    expect(isStrictSentinels()).toBe(false);
    soft.destroy();
    expect(isStrictSentinels()).toBe(true);
    strict.destroy();
    expect(isStrictSentinels()).toBe(false);
  });

  it('restores what was set imperatively before it, not a hard-coded default', () => {
    setStrictSentinels(true);
    const root = TestBed.inject(EnvironmentInjector);
    const env = createEnvironmentInjector(
      [provideStrictSentinels(false)],
      root,
    );
    expect(isStrictSentinels()).toBe(false);
    env.destroy();
    expect(isStrictSentinels()).toBe(true);
  });

  it.each([
    [0, 1, 2],
    [0, 2, 1],
    [1, 0, 2],
    [1, 2, 0],
    [2, 0, 1],
    [2, 1, 0],
  ])(
    'preserves live overrides when siblings close in order %i, %i, %i',
    (...order) => {
      const root = TestBed.inject(EnvironmentInjector);
      for (const base of [false, true]) {
        for (let mask = 0; mask < 8; mask++) {
          setStrictSentinels(base);
          const policies = [0, 1, 2].map((i) => Boolean(mask & (1 << i)));
          const envs = policies.map((strict) =>
            createEnvironmentInjector([provideStrictSentinels(strict)], root),
          );
          const live = new Set([0, 1, 2]);
          try {
            expect(isStrictSentinels()).toBe(policies[2]);
            for (const i of order) {
              envs[i].destroy();
              live.delete(i);
              const newest = Math.max(...live);
              const expected = live.size ? policies[newest] : base;
              expect(isStrictSentinels()).toBe(expected);
              if (expected)
                expect(() => String(loading())).toThrow(SentinelLeakError);
              else expect(String(loading())).toBe('[mmstack loading]');
            }
          } finally {
            for (const i of live) envs[i].destroy();
          }
        }
      }
    },
  );

  it('keeps a live provider authoritative while imperative writes update the fallback', () => {
    const root = TestBed.inject(EnvironmentInjector);
    const env = createEnvironmentInjector(
      [provideStrictSentinels(false)],
      root,
    );
    try {
      setStrictSentinels(true);
      expect(isStrictSentinels()).toBe(false);
      expect(String(loading())).toBe('[mmstack loading]');
    } finally {
      env.destroy();
    }
    expect(isStrictSentinels()).toBe(true);
    expect(() => String(loading())).toThrow(SentinelLeakError);
  });

  it('shares ownership across module copies and makes release idempotent', async () => {
    const root = TestBed.inject(EnvironmentInjector);
    const env = createEnvironmentInjector([provideStrictSentinels()], root);
    vi.resetModules();
    const other = await import('./sentinel');
    const release = other.registerStrictSentinels(false);
    try {
      expect(isStrictSentinels()).toBe(false);
      env.destroy();
      expect(other.isStrictSentinels()).toBe(false);
      release();
      expect(isStrictSentinels()).toBe(false);
      other.setStrictSentinels(true);
      release(); // an old disposer must not change a subsequent policy
      expect(isStrictSentinels()).toBe(true);
    } finally {
      if (!env.destroyed) env.destroy();
      release();
    }
  });
});
