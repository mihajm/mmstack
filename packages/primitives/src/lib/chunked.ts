import {
  type Injector,
  type Signal,
  type ValueEqualityFn,
  linkedSignal,
  untracked,
} from '@angular/core';
import { nestedEffect } from './effect';

export type CreateChunkedOptions<T> = {
  /**
   * The number of items to process in each chunk.
   * @default 50
   */
  chunkSize?: number;
  /**
   * The delay between processing each chunk. Can be a number (milliseconds) or 'frame' to use `requestAnimationFrame`.
   * @default 'frame'
   */
  delay?: number | 'frame' | 'microtask';
  /**
   * A custom equality function to determine if the processed chunk has changed. This can help prevent unnecessary updates if the chunk content is the same as the previous one.
   */
  equal?: ValueEqualityFn<T[]>;
  /**
   * An optional `Injector` to use for the internal effect. This allows the effect to have access to dependency injection if needed.
   */
  injector?: Injector;
};

/**
 * Creates a new `Signal` that processes an array of items in time-sliced chunks. This is useful for handling large lists without blocking the main thread.
 *
 * The returned signal will initially contain the first `chunkSize` items from the source array. It will then schedule updates to include additional chunks of items based on the specified `duration`.
 *
 * @template T The type of items in the array.
 * @param source A `Signal` or a function that returns an array of items to be processed in chunks.
 * @param options Configuration options for chunk size, delay duration, equality function, and injector.
 * @returns A `Signal` that emits the current chunk of items being processed.
 *
 * @example
 * const largeList = signal(Array.from({ length: 1000 }, (_, i) => i));
 * const chunkedList = chunked(largeList, { chunkSize: 100, duration: 100 });
 */
export function chunked<T>(
  source: Signal<T[]> | (() => T[]),
  options?: CreateChunkedOptions<T>,
): Signal<T[]> {
  const { chunkSize = 50, delay = 'frame', equal, injector } = options || {};

  let delayFn: (callback: () => void) => () => void;

  if (delay === 'frame') {
    delayFn = (callback) => {
      const num = requestAnimationFrame(callback);
      return () => cancelAnimationFrame(num);
    };
  } else if (delay === 'microtask') {
    delayFn = (cb) => {
      let isCancelled = false;

      queueMicrotask(() => {
        if (isCancelled) return;
        cb();
      });

      return () => {
        isCancelled = true;
      };
    };
  } else {
    delayFn = (cb) => {
      const num = setTimeout(cb, delay);
      return () => clearTimeout(num);
    };
  }

  const internal = linkedSignal<T[], T[]>({
    source,
    computation: (items) => items.slice(0, chunkSize),
    equal,
  });

  nestedEffect(
    (cleanup) => {
      const fullList = source();
      const current = internal();

      if (current.length >= fullList.length) return;

      return cleanup(
        delayFn(() =>
          untracked(() =>
            internal.set(fullList.slice(0, current.length + chunkSize)),
          ),
        ),
      );
    },
    {
      injector: injector,
    },
  );

  return internal.asReadonly();
}
