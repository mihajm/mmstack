import { inject, Injector, isDevMode, makeEnvironmentProviders, type EnvironmentProviders } from '@angular/core';
import { type Sink } from './sink';
import { createTelemetry, TELEMETRY, type TelemetryConfig } from './telemetry';

/**
 * Opt-in factory. Sink entries may be a `Sink` or a `() => Sink` factory; the
 * factories are invoked **here, in this provider's injection context**, so an
 * adapter that needs DI (e.g. `inject(TelemetryHandles)` to publish vendor
 * handles) gets it for free. Falsy entries/results are filtered; with no valid
 * sinks, `TELEMETRY` resolves to the zero-overhead noop.
 */
export function provideTelemetry(config: TelemetryConfig): EnvironmentProviders {
  return makeEnvironmentProviders([
    {
      provide: TELEMETRY,
      useFactory: () => {
        const injector = inject(Injector);
        const sinks: Sink[] = config.sinks
          .map((entry) => {
            // a throwing factory must not take TELEMETRY injection (and with it,
            // e.g. every intercepted HTTP request) down with it
            try {
              return typeof entry === 'function' ? entry() : entry;
            } catch (err) {
              if (isDevMode()) {
                console.warn('[telemetry] sink factory threw — sink skipped', err);
              }
              return null;
            }
          })
          .filter((sink): sink is Sink => sink != null);
        return createTelemetry(sinks, config, injector);
      },
    },
  ]);
}
