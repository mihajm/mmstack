import { isPlatformServer } from '@angular/common';
import {
  computed,
  DestroyRef,
  effect,
  ElementRef,
  inject,
  Injector,
  isSignal,
  PLATFORM_ID,
  signal,
  type Signal,
  untracked,
} from '@angular/core';

/**
 * Options for {@link signalFromEvent}. Extends the native
 * `AddEventListenerOptions` so callers can opt into `capture`, `passive`, etc.
 */
export type SignalFromEventOptions = AddEventListenerOptions & {
  /** Optional debug name for the produced signal. */
  debugName?: string;
  /** Override the DestroyRef used to remove the listener on teardown. */
  destroyRef?: DestroyRef;
  /** Override the Injector used to inject dependencies. */
  injector?: Injector;
};

type EventTargetLike = EventTarget | ElementRef<EventTarget>;
type ResolvableTarget = EventTargetLike | Signal<EventTargetLike | null>;

function unwrap(t: EventTargetLike | null): EventTarget | null {
  if (!t) return null;
  return t instanceof ElementRef ? (t.nativeElement as EventTarget) : t;
}

/**
 * Creates a read-only signal that emits the latest event dispatched on a
 * target. The target can be a static `EventTarget`, an `ElementRef`, or a
 * `Signal` that resolves to one (or `null` to detach).
 *
 * SSR-safe: on the server the signal returns the provided `initial` value and
 * no listener is registered.
 *
 * @example
 * ```ts
 * const click = signalFromEvent(document, 'click', null);
 * ```
 *
 * @example
 * ```ts
 * // With a projection — store just the coordinates.
 * const point = signalFromEvent<MouseEvent, { x: number; y: number }>(
 *   document,
 *   'mousemove',
 *   { x: 0, y: 0 },
 *   (e) => ({ x: e.clientX, y: e.clientY }),
 * );
 * ```
 */
export function signalFromEvent<TEvent extends Event>(
  target: ResolvableTarget,
  eventName: string,
  initial: TEvent | null,
  opt?: SignalFromEventOptions,
): Signal<TEvent | null>;

export function signalFromEvent<TEvent extends Event, U>(
  target: ResolvableTarget,
  eventName: string,
  initial: U,
  project: (event: TEvent) => U,
  opt?: SignalFromEventOptions,
): Signal<U>;

export function signalFromEvent<TEvent extends Event, U>(
  target: ResolvableTarget,
  eventName: string,
  initial: U | TEvent | null,
  projectOrOpt?: ((event: TEvent) => U) | SignalFromEventOptions,
  maybeOpt?: SignalFromEventOptions,
): Signal<U | TEvent | null> {
  const project = typeof projectOrOpt === 'function' ? projectOrOpt : undefined;
  const opt = typeof projectOrOpt === 'function' ? maybeOpt : projectOrOpt;
  const injector = opt?.injector ?? inject(Injector);

  if (isPlatformServer(injector.get(PLATFORM_ID))) {
    return computed(() => initial, { debugName: opt?.debugName });
  }

  const state = signal<U | TEvent | null>(initial, {
    debugName: opt?.debugName,
  });

  const handler = (event: Event) => {
    if (project) state.set(project(event as TEvent));
    else state.set(event as TEvent);
  };

  const {
    destroyRef: providedDestroyRef,
    // strip non-listener keys so they don't leak into addEventListener options
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    injector: _injector,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    debugName: _debugName,
    ...listenerOpts
  } = opt ?? {};

  if (isSignal(target)) {
    const targetSig = target;
    const effectRef = effect(
      (cleanup) => {
        const resolved = unwrap(targetSig());
        if (!resolved) return;
        resolved.addEventListener(eventName, handler, listenerOpts);
        cleanup(() =>
          resolved.removeEventListener(eventName, handler, listenerOpts),
        );
      },
      { injector },
    );
    // honor an explicit destroyRef for signal targets too — the effect would otherwise
    // only follow the injector's lifetime, contradicting the documented option
    providedDestroyRef?.onDestroy(() => effectRef.destroy());
  } else {
    const resolved = unwrap(target);
    if (resolved) {
      resolved.addEventListener(eventName, handler, listenerOpts);
      const destroyRef = providedDestroyRef ?? injector.get(DestroyRef);
      destroyRef.onDestroy(() =>
        resolved.removeEventListener(eventName, handler, listenerOpts),
      );
    }
  }

  return untracked(() => state.asReadonly());
}
