import { isPlatformServer } from '@angular/common';
import {
  DestroyRef,
  effect,
  inject,
  Injectable,
  PLATFORM_ID,
  WritableSignal,
} from '@angular/core';

@Injectable({
  providedIn: 'root',
})
export class MessageBus {
  private readonly channel = new BroadcastChannel('mmstack-tab-sync-bus');
  private readonly listeners = new Map<string, (ev: MessageEvent) => void>();

  subscribe<T>(id: string, listener: (data: T) => void) {
    this.unsubscribe(id); // Ensure no duplicate listeners
    const wrapped = (ev: MessageEvent) => {
      try {
        if (ev.data?.id === id) listener(ev.data?.value);
      } catch {
        // noop
      }
    };
    this.channel.addEventListener('message', wrapped);
    this.listeners.set(id, wrapped);

    return {
      unsub: (() => this.unsubscribe(id)).bind(this),
      post: ((value: T) => this.channel.postMessage({ id, value })).bind(this),
    };
  }

  private unsubscribe(id: string) {
    const listener = this.listeners.get(id);
    if (!listener) return;
    this.channel.removeEventListener('message', listener);
    this.listeners.delete(id);
  }
}

export function generateDeterministicID(): string {
  const stack = new Error().stack;
  if (stack) {
    // Look for the actual caller (first non-internal frame)
    const lines = stack.split('\n');
    for (let i = 2; i < lines.length; i++) {
      const line = lines[i];
      if (line && !line.includes('tabSync') && !line.includes('MessageBus')) {
        let hash = 0;
        for (let j = 0; j < line.length; j++) {
          const char = line.charCodeAt(j);
          hash = (hash << 5) - hash + char;
          hash = hash & hash;
        }
        return `auto-${Math.abs(hash)}`;
      }
    }
  }
  throw new Error(
    'Could not generate deterministic ID, please provide one manually.',
  );
}

type SyncSignalOptions = {
  id?: string;
};

/**
 * Synchronizes a WritableSignal across browser tabs using BroadcastChannel API.
 *
 * Creates a shared signal that automatically syncs its value between all tabs
 * of the same application. When the signal is updated in one tab, all other
 * tabs will receive the new value automatically.
 *
 * @template T - The type of the WritableSignal
 * @param sig - The WritableSignal to synchronize across tabs
 * @param opt - Optional configuration object
 * @param opt.id - Explicit channel ID for synchronization. If not provided,
 *                 a deterministic ID is generated based on the call site.
 *                 Use explicit IDs in production for reliability.
 *
 * @returns The same WritableSignal instance, now synchronized across tabs
 *
 * @throws {Error} When deterministic ID generation fails and no explicit ID is provided
 *
 * @example
 * ```typescript
 * // Basic usage - auto-generates channel ID from call site
 * const theme = tabSync(signal('dark'));
 *
 * // With explicit ID (recommended for production)
 * const userPrefs = tabSync(signal({ lang: 'en' }), { id: 'user-preferences' });
 *
 * // Changes in one tab will sync to all other tabs
 * theme.set('light'); // All tabs will update to 'light'
 * ```
 *
 * @remarks
 * - Only works in browser environments (returns original signal on server)
 * - Uses a single BroadcastChannel for all synchronized signals
 * - Automatically cleans up listeners when the injection context is destroyed
 * - Initial signal value after sync setup is not broadcasted to prevent loops
 *
 */
export function tabSync<T extends WritableSignal<any>>(
  sig: T,
  opt?: SyncSignalOptions,
): T {
  if (isPlatformServer(inject(PLATFORM_ID))) return sig;

  const id = opt?.id || generateDeterministicID();

  const bus = inject(MessageBus);

  const { unsub, post } = bus.subscribe(id, (next) => sig.set(next));

  let first = false;

  const effectRef = effect(() => {
    const val = sig();
    if (!first) {
      first = true;
      return;
    }
    post(val);
  });

  inject(DestroyRef).onDestroy(() => {
    effectRef.destroy();
    unsub();
  });

  return sig;
}
