import { type Injector, runInInjectionContext } from '@angular/core';

/**
 * Options shared by every sensor: an optional `debugName` for the produced signal(s) and an
 * optional `Injector` that lifts the injection-context requirement.
 */
export type SensorRunOptions = {
  /** Optional debug name for the produced signal(s). */
  debugName?: string;
  /**
   * Injector used to resolve the sensor's dependencies (`PLATFORM_ID`, `DestroyRef`, default
   * `ElementRef` targets, ...). Provide it when creating the sensor outside an injection
   * context — e.g. in `ngOnInit`, an event handler, or an effect body. When omitted, the
   * sensor must be created in an injection context (a constructor / field initializer).
   */
  injector?: Injector;
};

/**
 * @internal Run a sensor factory inside `injector` when provided, else in the ambient
 * injection context. Keeps every sensor's escape hatch identical and in one place.
 */
export function runInSensorContext<T>(
  injector: Injector | undefined,
  fn: () => T,
): T {
  return injector ? runInInjectionContext(injector, fn) : fn();
}

/**
 * @internal Normalize the legacy positional `debugName: string` form into {@link SensorRunOptions}.
 */
export function coerceSensorOptions(
  opt?: string | SensorRunOptions,
): SensorRunOptions {
  return typeof opt === 'string' ? { debugName: opt } : (opt ?? {});
}
