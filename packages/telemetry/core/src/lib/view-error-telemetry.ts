import {
  ErrorHandler,
  inject,
  makeEnvironmentProviders,
  type EnvironmentProviders,
  type ErrorDetails,
} from '@angular/core';
import { TELEMETRY } from './telemetry';

/** The finding code a view error caught by Angular's `@boundary` is reported under. */
export const VIEW_ERROR_FINDING = 'VIEW_ERROR';

export type ViewErrorTelemetryOptions = {
  /**
   * The handler errors continue to. Defaults to the `ErrorHandler` of the parent injector, else
   * Angular's default `ErrorHandler` (which logs).
   */
  readonly delegate?: () => ErrorHandler;
};

class ViewErrorTelemetryHandler extends ErrorHandler {
  private readonly telemetry = inject(TELEMETRY);

  constructor(private readonly next: ErrorHandler) {
    super();
  }

  override handleError(error: unknown): void {
    this.next.handleError(error);
  }

  override onViewError(error: Error, details: ErrorDetails): void {
    const declaration = details.declarationType.name;
    const boundary = details.boundary?.type.name;
    this.telemetry.finding(VIEW_ERROR_FINDING, {
      severity: 'error',
      path: declaration,
      ...(boundary === undefined ? {} : { node: boundary }),
      message:
        'A view threw while rendering. Fix the template or the data it reads.',
      data: { declarationType: declaration, boundaryType: boundary },
    });
    // the same dispatch Angular applies to a handler
    if (this.next.onViewError) this.next.onViewError(error, details);
    else this.next.handleError(error);
  }
}

/**
 * An `ErrorHandler` that records each view error Angular's `@boundary` catches as one
 * `VIEW_ERROR` finding: path = the declaring component's class name, node = the boundary's host
 * component class name, both also in `data`. Every error then continues to the delegate. Class
 * names are as the bundle has them, so minified in a production build.
 */
export function provideViewErrorTelemetry(
  options: ViewErrorTelemetryOptions = {},
): EnvironmentProviders {
  return makeEnvironmentProviders([
    {
      provide: ErrorHandler,
      useFactory: () =>
        new ViewErrorTelemetryHandler(
          options.delegate?.() ??
            inject(ErrorHandler, { skipSelf: true, optional: true }) ??
            new ErrorHandler(),
        ),
    },
  ]);
}
