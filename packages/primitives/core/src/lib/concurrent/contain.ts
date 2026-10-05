/**
 * Contained-but-loud delivery to an observer or callback. A throwing callback is a caller bug: it
 * must never perturb the calling primitive's semantics, but it must stay visible. Delivery is
 * wrapped so a throw (or a rejected returned promise) is caught and rethrown out-of-band via
 * `queueMicrotask`, surfacing at the global unhandled-error handler while the calling path
 * continues undisturbed.
 */
export function deliverContained<T>(
  observer: (event: T) => void,
  event: T,
): void {
  try {
    const result = observer(event) as unknown;
    if (
      result != null &&
      typeof (result as PromiseLike<unknown>).then === 'function'
    ) {
      void (result as PromiseLike<unknown>).then(
        undefined,
        (error: unknown) => {
          queueMicrotask(() => {
            throw error;
          });
        },
      );
    }
  } catch (error) {
    queueMicrotask(() => {
      throw error;
    });
  }
}
