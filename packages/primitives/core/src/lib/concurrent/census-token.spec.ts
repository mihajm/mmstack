import {
  createEnvironmentInjector,
  EnvironmentInjector,
  Injector,
} from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { describe, expect, it } from 'vitest';
import {
  BOUNDARY_CENSUS,
  type CensusRegistry,
  censusResource,
  injectCensus,
  provideCensus,
} from '../../index';

describe('census token (public surface)', () => {
  it('provideCensus() + injectCensus() round-trip through the token', () => {
    const boundary = createEnvironmentInjector(
      [provideCensus()],
      TestBed.inject(EnvironmentInjector),
    );
    const provided = boundary.get<CensusRegistry>(BOUNDARY_CENSUS);
    const injected = boundary.runInContext(() => injectCensus());
    expect(injected).toBe(provided);
    expect(TestBed.runInInjectionContext(() => injectCensus())).toBeNull();
    boundary.destroy();
  });

  it('censusResource registers into a census provided by provideCensus() alone (no scope)', () => {
    const boundary = createEnvironmentInjector(
      [provideCensus()],
      TestBed.inject(EnvironmentInjector),
    );
    const census = boundary.get<CensusRegistry>(BOUNDARY_CENSUS);
    const before = census.snapshot().length;
    boundary.runInContext(() =>
      censusResource({
        site: 'token-spec',
        displayName: 'asset',
        injector: boundary.get(Injector),
        params: () => 'x',
        loader: () => new Promise<string>(() => undefined),
      }),
    );
    const members = census.snapshot();
    expect(members.length).toBe(before + 1);
    expect(members.at(-1)?.displayName).toBe('asset');
    boundary.destroy();
  });
});
