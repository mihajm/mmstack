import {
  DestroyRef,
  effect,
  EffectRef,
  inject,
  Injector,
  runInInjectionContext,
  Signal,
  untracked,
} from '@angular/core';

export type UntilOptions = {
  /**
   * Optional timeout in milliseconds. If the condition is not met
   * within this period, the promise will reject.
   */
  timeout?: number;
  /**
   * Optional DestroyRef. If provided and the component/context is destroyed
   * before the condition is met or timeout occurs, the promise will reject.
   * If not provided, it will attempt to inject one if called in an injection context.
   */
  destroyRef?: DestroyRef;
  injector?: Injector;
};

/**
 * Creates a Promise that resolves when a signal's value satisfies a given predicate.
 *
 * This is useful for imperatively waiting for a reactive state to change,
 * for example, in tests or to orchestrate complex asynchronous operations.
 *
 * @template T The type of the signal's value.
 * @param sourceSignal The signal to observe.
 * @param predicate A function that takes the signal's value and returns `true` if the condition is met.
 * @param options Optional configuration for timeout and explicit destruction.
 * @returns A Promise that resolves with the signal's value when the predicate is true,
 * or rejects on timeout or context destruction.
 *
 * @example
 * ```ts
 * const count = signal(0);
 *
 * async function waitForCount() {
 * console.log('Waiting for count to be >= 3...');
 * try {
 * const finalCount = await until(count, c => c >= 3, { timeout: 5000 });
 * console.log(`Count reached: ${finalCount}`);
 * } catch (e: any) { // Ensure 'e' is typed if you access properties like e.message
 * console.error(e.message); // e.g., "until: Timeout after 5000ms."
 * }
 * }
 *
 * // Simulate updates
 * setTimeout(() => count.set(1), 500);
 * setTimeout(() => count.set(2), 1000);
 * setTimeout(() => count.set(3), 1500);
 *
 * waitForCount();
 * ```
 */
export function until<T>(
  sourceSignal: Signal<T>,
  predicate: (value: T) => boolean,
  options: UntilOptions = {},
): Promise<T> {
  const injector = options.injector ?? inject(Injector);
  return new Promise<T>((resolve, reject) => {
    let effectRef: EffectRef | undefined;
    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    let settled = false;

    const cleanupAndReject = (reason: string) => {
      if (!settled) {
        settled = true;
        if (timeoutId) clearTimeout(timeoutId);
        effectRef?.destroy();
        reject(new Error(reason));
      }
    };

    const cleanupAndResolve = (value: T) => {
      if (!settled) {
        settled = true;
        if (timeoutId) clearTimeout(timeoutId);
        effectRef?.destroy();
        resolve(value);
      }
    };

    try {
      const destroyRef =
        options.destroyRef ?? inject(DestroyRef, { optional: true });

      destroyRef?.onDestroy(() => {
        cleanupAndReject(
          'until: Operation cancelled due to context destruction.',
        );
      });
    } catch {
      // noop
    }

    const initialValue = untracked(sourceSignal);
    if (predicate(initialValue)) {
      cleanupAndResolve(initialValue);
      return;
    }

    if (options?.timeout !== undefined) {
      timeoutId = setTimeout(
        () => cleanupAndReject(`until: Timeout after ${options.timeout}ms.`),
        options.timeout,
      );
    }

    runInInjectionContext(injector, () => {
      effectRef = effect(() => {
        if (settled) {
          return effectRef?.destroy();
        }

        const currentValue = sourceSignal();
        if (predicate(currentValue)) {
          cleanupAndResolve(currentValue);
        }
      });
    });
  });
}
