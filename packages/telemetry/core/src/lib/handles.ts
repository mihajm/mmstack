import { computed, Injectable, signal, type Signal } from '@angular/core';

/**
 * Signal-based registry for **vendor handles** — replay session URLs, feature-flag
 * snapshots, anything one adapter wants to expose to others (or to the app)
 * without them knowing about each other. Reactive: a handle can appear mid-session.
 *
 * Adapters `publish('replay.url', urlSignal)`; consumers `get('replay.url')()`.
 */
@Injectable({ providedIn: 'root' })
export class TelemetryHandles {
  private readonly registry = signal<Record<string, Signal<unknown>>>({});

  publish<T>(key: string, value: Signal<T>): void {
    this.registry.update((current) => ({ ...current, [key]: value as Signal<unknown> }));
  }

  /** Reactive read — `undefined` until the key is published, then tracks its signal. */
  get<T = unknown>(key: string): Signal<T | undefined> {
    return computed(() => this.registry()[key]?.() as T | undefined);
  }

  keys(): Signal<readonly string[]> {
    return computed(() => Object.keys(this.registry()));
  }
}
