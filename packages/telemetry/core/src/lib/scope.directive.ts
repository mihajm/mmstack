import { computed, Directive, inject, input, type Signal } from '@angular/core';

/**
 * Hierarchical-DI lineage primitive (RFC §8.1). Compose onto a component via
 * `hostDirectives` to give it a telemetry "scope" whose `path` is its ancestor
 * chain — so spans/events can be tagged with component lineage *without* ambient
 * context (Angular's injector tree provides the lineage explicitly).
 *
 * `my-btn` inside `my-page` → its `path()` is `['my-page', 'my-btn']`.
 * Headless (no template); mount/auto-tagging is opt-in and layered on top.
 */
@Directive({
  selector: '[mmTelemetryScope]',
})
export class TelemetryScope {
  readonly name = input.required<string>({ alias: 'mmTelemetryScope' });
  private readonly parent = inject(TelemetryScope, { optional: true, skipSelf: true });

  readonly path: Signal<readonly string[]> = computed(() => [
    ...(this.parent?.path() ?? []),
    this.name(),
  ]);
}
