import { inject, InjectionToken, Injector, type Provider } from '@angular/core';
import { type CensusRegistry } from './census';
import { createCensus } from './census-registry';

/**
 * The nearest boundary's census. `provideTransitionScope` / `provideForwardingTransitionScope`
 * provide their scope's census here, so members register into the scope's fold.
 */
export const BOUNDARY_CENSUS = new InjectionToken<CensusRegistry>(
  '@mmstack/primitives:boundary-census',
);

/**
 * Provides a bare census with no transition scope around it. Members created below it register
 * into the NEAREST one. A transition scope already provides its own; this is for a census alone.
 */
export function provideCensus(): Provider {
  return {
    provide: BOUNDARY_CENSUS,
    useFactory: () => createCensus({ injector: inject(Injector) }),
  };
}

/** The nearest boundary census (normally the nearest transition scope's), or `null` outside any boundary. */
export function injectCensus(): CensusRegistry | null {
  return inject(BOUNDARY_CENSUS, { optional: true });
}
