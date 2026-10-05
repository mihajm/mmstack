import {
  DestroyRef,
  inject,
  makeEnvironmentProviders,
  provideEnvironmentInitializer,
  untracked,
  type EnvironmentProviders,
} from '@angular/core';
import { setErrorReporter, type ErrorMintReport } from '@mmstack/primitives';
import { TELEMETRY } from './telemetry';

/** The finding code an error sentinel mint is reported under. */
export const SENTINEL_ERROR_FINDING = 'SENTINEL_ERROR';

function causeType(cause: unknown): string {
  if (cause instanceof Error) return cause.name;
  return cause === null ? 'null' : typeof cause;
}

/**
 * Reports every error sentinel mint as one `SENTINEL_ERROR` finding: path `sentinel.<origin>`,
 * node = the subclass, data = origin, subclass and the cause's type (its `name` when it is an
 * `Error`, else `typeof`). The cause itself is runtime data and stays out of the finding.
 *
 * Installs the reporter with `setErrorReporter` when the injector is created and clears it when
 * the injector is destroyed. The reporter is one module variable per copy of `@mmstack/primitives`,
 * so the last installed wins; without this provider `setErrorReporter` remains the no-DI way in.
 */
export function provideSentinelTelemetry(): EnvironmentProviders {
  return makeEnvironmentProviders([
    provideEnvironmentInitializer(() => {
      const telemetry = inject(TELEMETRY);
      // A mint can happen inside a computed: report outside its reactive context.
      setErrorReporter((report: ErrorMintReport) =>
        untracked(() =>
          telemetry.finding(SENTINEL_ERROR_FINDING, {
            severity: 'error',
            path: `sentinel.${report.origin}`,
            node: report.subclass,
            message:
              'A failure was contained as an error value. Check the cause at its source.',
            data: {
              origin: report.origin,
              subclass: report.subclass,
              causeType: causeType(report.cause),
            },
          }),
        ),
      );
      inject(DestroyRef).onDestroy(() => setErrorReporter(undefined));
    }),
  ]);
}
