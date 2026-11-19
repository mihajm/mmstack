import {
  EnvironmentInjector,
  type ResourceStatus,
  signal,
} from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { error, isError } from '../semantics/sentinel';
import { latest, use, type UseSource } from './latest';
import { getTransitionScope, provideTransitionScope } from './transition-scope';

function source<T>(
  status: ResourceStatus,
  value?: T,
  extra: Partial<UseSource<T>> = {},
): UseSource<T> & { status: ReturnType<typeof signal<ResourceStatus>> } {
  const s = signal(status);
  const v = signal<T | undefined>(value);
  return {
    status: s,
    value: v,
    hasValue: () => v() !== undefined,
    ...extra,
  } as UseSource<T> & { status: ReturnType<typeof signal<ResourceStatus>> };
}

describe('latest: error()', () => {
  it('is the cause of the member whose own error outcome ended the read', () => {
    const cause = new Error('member failed');
    const healthy = source('resolved', 1, { error: signal(undefined) });
    const failing = source<number>('error', undefined, {
      outcome: signal(error('hand minted')),
      error: signal(cause),
    });
    const sum = latest(() => use(healthy) + use(failing));
    expect(sum.status()).toBe('error');
    expect(sum.error()).toBe(cause);
  });

  it('is defined when the derivation throws an error sentinel itself', () => {
    const d = latest((): number => {
      throw error('authored');
    });
    expect(d.status()).toBe('error');
    expect(isError(d.error())).toBe(true);
  });

  it('a healthy member with no error signal reads as no error', () => {
    const r = source('resolved', 2);
    const d = latest(() => use(r) * 2);
    expect(d()).toBe(4);
    expect(d.error()).toBeUndefined();
  });
});

describe('latest: registration', () => {
  it('registers in the current injection context when no injector is given', () => {
    TestBed.configureTestingModule({ providers: [provideTransitionScope()] });
    const scope = getTransitionScope(TestBed.inject(EnvironmentInjector));
    if (!scope) throw new Error('scope not provided');
    const r = source<number>('loading');
    const d = TestBed.runInInjectionContext(() =>
      latest(() => use(r), { register: 'indicator' }),
    );
    expect(scope.resources()).toContain(d);
    expect(scope.pending()).toBe(true);
  });
});
