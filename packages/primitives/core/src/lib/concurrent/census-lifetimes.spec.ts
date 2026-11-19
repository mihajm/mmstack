import { Component, Injector, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { describe, expect, it } from 'vitest';
import { memberId, type CensusError, type CensusRegistry } from './census';
import { censusResource } from './census-resource';
import { BOUNDARY_CENSUS, provideCensus } from './census-token';

const params = signal('first');
let loads = 0;

@Component({ selector: 'census-owner', template: `` })
class Owner {
  readonly ref = censusResource({
    site: 'lifetime',
    displayName: 'asset',
    params: () => params(),
    loader: () => {
      loads++;
      return new Promise<string>(() => undefined);
    },
  });
}

const pump = async () => {
  for (let i = 0; i < 3; i++) {
    TestBed.tick();
    await Promise.resolve();
  }
};

describe('census lifetimes', () => {
  it('a censusResource dies with the component that created it', async () => {
    loads = 0;
    params.set('first');
    const fixture = TestBed.createComponent(Owner);
    await pump();
    expect(loads).toBe(1);

    fixture.destroy();
    params.set('second');
    await pump();
    expect(loads).toBe(1);
  });

  it('a census from provideCensus settles a retry round called outside an injection context', async () => {
    TestBed.configureTestingModule({ providers: [provideCensus()] });
    const census =
      TestBed.inject(Injector).get<CensusRegistry>(BOUNDARY_CENSUS);
    const inFlight = signal(false);
    census.register({
      id: memberId('m', 0),
      displayName: 'm',
      readiness: true,
      paused: signal(false),
      pending: signal(false),
      inFlight,
      failure: signal<CensusError | undefined>(undefined),
      retry: { retry: () => inFlight.set(true) },
    });

    const round = census.retryAll();
    expect(round.dispatched).toBe(1);
    let done = false;
    let failed: unknown;
    round.settled().then(
      () => (done = true),
      (e) => (failed = e),
    );
    inFlight.set(false);
    for (let i = 0; i < 4 && !done; i++) {
      TestBed.tick();
      await new Promise((r) => setTimeout(r));
    }
    expect(failed).toBeUndefined();
    expect(done).toBe(true);
  });
});
