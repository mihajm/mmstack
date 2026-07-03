import {
  computed,
  DestroyRef,
  effect,
  inject,
  Injector,
  PLATFORM_ID,
  runInInjectionContext,
  signal,
  untracked,
  type ResourceStatus,
  type Signal,
  type ValueEqualityFn,
} from '@angular/core';
import { injectTransitionScope } from '@mmstack/primitives';
import { WorkerAbortError, type WorkerRef } from './connect-worker';

/** Returned from a paused `params` fn to HOLD (keep the current value/status, run nothing). */
export const PAUSED: unique symbol = Symbol('@mmstack/worker:PAUSED');

export type WorkerRequestContext = { readonly paused: typeof PAUSED };

/**
 * Reactive input producer. Reads signals to derive the task input; return `undefined` to disable
 * (idle, no run), or `ctx.paused` to hold. Re-runs when the returned input changes (by `Object.is`).
 */
export type WorkerParamsFn<TInput> = (
  ctx: WorkerRequestContext,
) => TInput | undefined | void | typeof PAUSED;

export type WorkerResourceOptions<TResult> = {
  readonly injector?: Injector;
  /** Equality for the result value — a run resolving equal to the held value emits no notification. */
  readonly equal?: ValueEqualityFn<TResult>;
  readonly defaultValue?: TResult;
  /**
   * Hold the previous value through a re-run (status `'reloading'`) instead of clearing it. Default
   * TRUE — a `workerResource` is an async derivation, not a fetch; flashing empty mid-recompute is
   * rarely wanted.
   */
  readonly keepPrevious?: boolean;
  /** Register into the nearest transition scope: `'indicator'` drives pending, `'suspend'` also gates first paint. */
  readonly register?: false | 'indicator' | 'suspend';
  /** The connected worker whose host exposes the task. */
  readonly worker: WorkerRef;
  /** The name of the task to run (as declared in `createWorkerHost({ tasks })`). */
  readonly task: string;
};

export type WorkerResourceRef<T> = {
  /** The latest successfully-computed value (held through re-runs per `keepPrevious`). */
  readonly value: Signal<T | undefined>;
  readonly status: Signal<ResourceStatus>;
  readonly error: Signal<unknown>;
  readonly isLoading: Signal<boolean>;
  hasValue(): boolean;
  /** Re-run with the current input, bypassing input de-duplication. */
  reload(): void;
  /** Cancel the in-flight run; the value is KEPT and status becomes `'local'`. */
  abort(): void;
  destroy(): void;
};

/**
 * Runs a named task on a connected worker, exposed with the standard resource surface so heavy
 * compute makes the UI *pending*, not *frozen*. `params` reactively derives the input; latest-wins
 * (a changed input supersedes and aborts the in-flight run); the result surfaces as
 * `value`/`status`/`error`, and — with `register` — participates in transition scopes. No-ops on the
 * server.
 */
export function workerResource<TInput, TResult>(
  params: WorkerParamsFn<TInput>,
  options: WorkerResourceOptions<TResult>,
): WorkerResourceRef<TResult> {
  const injector = options.injector ?? inject(Injector);
  return runInInjectionContext(injector, () => build<TInput, TResult>(params, options));
}

function build<TInput, TResult>(
  params: WorkerParamsFn<TInput>,
  options: WorkerResourceOptions<TResult>,
): WorkerResourceRef<TResult> {
  const isServer = inject(PLATFORM_ID) === 'server';
  const keepPrevious = options.keepPrevious ?? true;
  const userEqual = options.equal;
  const { worker, task } = options;

  const runTask = (input: TInput, signal: AbortSignal): Promise<TResult> =>
    worker.runTask(task, input, { signal }) as Promise<TResult>;

  const value = signal<TResult | undefined>(options.defaultValue, {
    equal: userEqual
      ? (a, b) => (a === undefined || b === undefined ? a === b : userEqual(a, b))
      : undefined,
  });
  const status = signal<ResourceStatus>('idle');
  const error = signal<unknown>(undefined);
  const isLoading = computed(() => {
    const s = status();
    return s === 'loading' || s === 'reloading';
  });
  const hasValue = () => value() !== undefined;

  let epoch = 0;
  let inFlight: AbortController | null = null;
  let lastInput: TInput | undefined;
  let hasRun = false;

  const start = (input: TInput): void => {
    const myEpoch = ++epoch;
    inFlight?.abort();
    const ac = new AbortController();
    inFlight = ac;
    lastInput = input;
    hasRun = true;
    status.set(keepPrevious && value() !== undefined ? 'reloading' : 'loading');
    error.set(undefined);

    runTask(input, ac.signal).then(
      (result) => {
        if (inFlight === ac) inFlight = null;
        if (myEpoch !== epoch) return; // superseded — discard
        value.set(result);
        status.set('resolved');
      },
      (err) => {
        if (inFlight === ac) inFlight = null;
        if (myEpoch !== epoch) return;
        if (err instanceof WorkerAbortError || (err as { name?: string })?.name === 'AbortError')
          return;
        error.set(err);
        status.set('error');
      },
    );
  };

  const input = computed(() => params({ paused: PAUSED }));

  const ref = effect(() => {
    const i = input();
    if (isServer || i === PAUSED) return; // server: never run · paused: hold
    if (i === undefined) return; // disabled — keep current value/status
    // dedup: a resume to the same input (e.g. after a pause) does not re-run
    if (Object.is(i, lastInput) && hasRun && untracked(status) !== 'error') return;
    untracked(() => start(i as TInput));
  });

  inject(DestroyRef).onDestroy(() => {
    epoch++;
    inFlight?.abort();
  });

  const self: WorkerResourceRef<TResult> = {
    value,
    status,
    error,
    isLoading,
    hasValue,
    reload: () => {
      const i = untracked(input);
      if (isServer || i === PAUSED || i === undefined) return;
      start(i as TInput);
    },
    abort: () => {
      if (!inFlight) return; // nothing in flight (a scope's abortPending must not disturb a settled value)
      epoch++;
      inFlight.abort();
      inFlight = null;
      status.set('local'); // value kept
    },
    destroy: () => {
      epoch++;
      inFlight?.abort();
      ref.destroy();
    },
  };

  if (options.register) {
    const scope = injectTransitionScope();
    scope.add(self, { suspends: options.register === 'suspend' });
    // deregister on manual destroy() too, not only on context teardown — a
    // long-lived context destroying a ref by hand must not leave a zombie entry
    let removed = false;
    const remove = () => {
      if (removed) return;
      removed = true;
      scope.remove(self);
    };
    inject(DestroyRef).onDestroy(remove);
    const destroy = self.destroy;
    self.destroy = () => {
      remove();
      destroy();
    };
  }

  return self;
}
