import { isPlatformServer } from '@angular/common';
import {
  computed,
  DestroyRef,
  inject,
  PLATFORM_ID,
  signal,
  type Signal,
} from '@angular/core';
import {
  coerceSensorOptions,
  runInSensorContext,
  type SensorRunOptions,
} from './sensor-options';

type InternalClipboardSignal = Signal<string> & {
  copy: (value: string) => Promise<void>;
  isSupported: Signal<boolean>;
};

export type ClipboardSignal = Signal<string> & {
  /**
   * Writes `value` to the system clipboard. Resolves once the write completes;
   * rejects if the Clipboard API rejects (denied permission, insecure context).
   */
  readonly copy: (value: string) => Promise<void>;
  /** `true` iff the Clipboard API is available in this environment. */
  readonly isSupported: Signal<boolean>;
};

/**
 * Creates a read-only signal mirroring the system clipboard contents.
 *
 * The signal value starts empty and updates whenever a `copy` event fires on
 * the document (or {@link ClipboardSignal.copy} is invoked from this app).
 * SSR-safe — returns `''` and `isSupported: false` on the server.
 *
 * Note: read access requires the Clipboard API and an active permission grant
 * in browsers that gate it. Errors from `navigator.clipboard.readText` are
 * swallowed silently to keep the signal value stable.
 */
export function clipboard(opt?: string | SensorRunOptions): ClipboardSignal {
  const { debugName = 'clipboard', injector } = coerceSensorOptions(opt);
  return runInSensorContext(injector, () => createClipboard(debugName));
}

function createClipboard(debugName: string): ClipboardSignal {
  if (
    isPlatformServer(inject(PLATFORM_ID)) ||
    typeof navigator === 'undefined' ||
    !navigator.clipboard
  ) {
    const sig = computed(() => '', { debugName }) as InternalClipboardSignal;
    sig.copy = () => Promise.resolve();
    sig.isSupported = computed(() => false);
    return sig;
  }

  const state = signal('', { debugName });

  const refresh = () => {
    navigator.clipboard.readText().then(
      (value) => state.set(value),
      () => {
        // permission denied / focus required — ignore
      },
    );
  };

  const abortController = new AbortController();
  const onCopy = () => refresh();
  document.addEventListener('copy', onCopy, { signal: abortController.signal });
  document.addEventListener('cut', onCopy, { signal: abortController.signal });

  inject(DestroyRef).onDestroy(() => abortController.abort());

  const sig = state.asReadonly() as InternalClipboardSignal;
  sig.copy = async (value: string) => {
    await navigator.clipboard.writeText(value);
    state.set(value);
  };
  sig.isSupported = computed(() => true);
  return sig;
}
