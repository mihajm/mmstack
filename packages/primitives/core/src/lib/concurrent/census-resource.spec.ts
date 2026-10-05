import {
  createEnvironmentInjector,
  EnvironmentInjector,
  signal,
} from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  BOUNDARY_CENSUS,
  provideCensus as provideBoundaryCensus,
} from './census-token';
import { censusResource } from './census-resource';
import { type CensusRegistry } from './census';

interface Deferred {
  resolve(value: string): void;
  reject(cause: unknown): void;
}

describe('censusResource', () => {
  let pending: Deferred[];
  let params: ReturnType<typeof signal<string>>;

  const pump = async () => {
    TestBed.tick();
    await Promise.resolve();
    TestBed.tick();
    await Promise.resolve();
    TestBed.tick();
  };

  const load = () =>
    new Promise<string>((resolve, reject) => pending.push({ resolve, reject }));

  const create = (injector: EnvironmentInjector) =>
    TestBed.runInInjectionContext(() =>
      censusResource({
        site: 'test-asset',
        displayName: 'asset',
        injector,
        params: () => params(),
        loader: load,
      }),
    );

  beforeEach(() => {
    pending = [];
    params = signal('first');
    TestBed.configureTestingModule({});
  });

  it('[WITNESS enrols-when-ambient] a resource created inside a boundary joins its census as ONE readiness member', async () => {
    const boundary = createEnvironmentInjector(
      [provideBoundaryCensus()],
      TestBed.inject(EnvironmentInjector),
    );
    const census = boundary.get<CensusRegistry>(BOUNDARY_CENSUS);
    create(boundary);
    await pump();

    const members = census.snapshot();
    expect(members).toHaveLength(1);
    expect(members[0].readiness).toBe(true);
    expect(members[0].displayName).toBe('asset');
  });

  it('[WITNESS plain-when-absent] outside every boundary it is an ordinary resource and enrols nowhere', async () => {
    const bare = createEnvironmentInjector(
      [],
      TestBed.inject(EnvironmentInjector),
    );
    const ref = create(bare);
    await pump();

    expect(bare.get(BOUNDARY_CENSUS, null, { optional: true })).toBeNull();
    expect(ref.isLoading()).toBe(true);
    pending[0].resolve('landed');
    await pump();
    expect(ref.value()).toBe('landed');
  });

  it('[WITNESS member-tracks-the-resource] pending, failure and retry all read the resource itself', async () => {
    const boundary = createEnvironmentInjector(
      [provideBoundaryCensus()],
      TestBed.inject(EnvironmentInjector),
    );
    const census = boundary.get<CensusRegistry>(BOUNDARY_CENSUS);
    const ref = create(boundary);
    await pump();

    const member = census.snapshot()[0];
    expect(member.pending()).toBe(true);
    expect(member.inFlight()).toBe(true);

    pending[0].reject(new Error('gone'));
    await pump();
    expect(member.pending()).toBe(false);
    expect(member.failure()).toMatchObject({
      displayName: 'asset',
      message: undefined,
    });

    const before = pending.length;
    member.retry?.retry();
    await pump();
    expect(pending.length).toBe(before + 1);

    pending[before].resolve('second try');
    await pump();
    expect(member.failure()).toBeUndefined();
    expect(ref.value()).toBe('second try');
  });

  it('[WITNESS leaves-at-destroy] the member is gone when its injector is, and not before', async () => {
    const boundary = createEnvironmentInjector(
      [provideBoundaryCensus()],
      TestBed.inject(EnvironmentInjector),
    );
    const census = boundary.get<CensusRegistry>(BOUNDARY_CENSUS);
    const owner = createEnvironmentInjector([], boundary);
    create(owner);
    await pump();

    pending[0].resolve('landed');
    await pump();
    expect(census.snapshot()).toHaveLength(1);

    owner.destroy();
    expect(census.snapshot()).toHaveLength(0);
  });
});
