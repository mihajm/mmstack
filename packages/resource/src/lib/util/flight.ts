import { type HttpResourceRef } from '@angular/common/http';
import {
  effect,
  type Injector,
  isDevMode,
  type ResourceStatus,
  type Signal,
  signal,
  untracked,
} from '@angular/core';

/** One step of a query fetch's lifecycle. */
export type FlightPhase =
  'start' | 'landed' | 'failed' | 'superseded' | 'aborted';

/**
 * A fetch lifecycle edge. Every generation gets exactly one `start` and exactly one terminal
 * edge (`landed`, `failed`, `superseded` or `aborted`).
 */
export interface FlightEdge {
  readonly phase: FlightPhase;
  /** 1-based, increments on every fetch start of this resource instance */
  readonly generation: number;
}

/** @internal */
export type FlightTracker = {
  /** Counts successful non-retry reloads as new generations. Wrap below `refresh`. */
  wrap<T>(resource: HttpResourceRef<T>): HttpResourceRef<T>;
  /** Marks the next reload as a retry of the open generation. */
  markRetry(): void;
  /** The final `onError` of the open generation. */
  fail(): void;
  /** Closes an open generation as `aborted` and stops observing. */
  destroy(): void;
};

/**
 * @internal A generation is keyed on the stable request identity plus the count of non-retry
 * reloads: the projected status alone stays `loading` when a request changes mid-flight.
 */
export function trackFlights(
  onFlight: (edge: FlightEdge) => void,
  status: Signal<ResourceStatus>,
  request: Signal<unknown>,
  injector?: Injector,
): FlightTracker {
  const runs = signal(0);
  let retryPending = false;

  let generation = 0;
  let open = false;
  let lastRequest: unknown = undefined;
  let lastRun = 0;

  const emit = (phase: FlightPhase) => {
    const edge: FlightEdge = { phase, generation };
    try {
      untracked(() => onFlight(edge));
    } catch (err) {
      if (isDevMode())
        console.error('[@mmstack/resource]: onFlight threw', err);
    }
  };

  const close = (phase: Exclude<FlightPhase, 'start'>) => {
    open = false;
    emit(phase);
  };

  const reconcile = (req: unknown, run: number, s: ResourceStatus) => {
    const changed = req !== lastRequest || run !== lastRun;
    lastRequest = req;
    lastRun = run;

    const inFlight = s === 'loading' || s === 'reloading';
    if ((changed && req !== undefined && s !== 'idle') || (!open && inFlight)) {
      if (open) close('superseded');
      generation++;
      open = true;
      emit('start');
    }

    if (!open) return;
    // 'error' closes through fail(): only the final attempt is a failure
    if (s === 'resolved') close('landed');
    else if (s === 'idle' || s === 'local') close('aborted');
  };

  const reconcileNow = () =>
    untracked(() => reconcile(request(), runs(), status()));

  const ref = effect(() => reconcile(request(), runs(), status()), {
    injector,
  });

  return {
    wrap: (resource) => ({
      ...resource,
      reload: () => {
        const isRetry = retryPending;
        retryPending = false;
        const reloaded = resource.reload();
        if (reloaded && !isRetry) runs.update((n) => n + 1);
        return reloaded;
      },
    }),
    markRetry: () => {
      retryPending = true;
    },
    fail: () => {
      reconcileNow();
      if (open) close('failed');
    },
    destroy: () => {
      ref.destroy();
      if (open) close('aborted');
    },
  };
}
