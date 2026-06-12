import { isPlatformServer } from '@angular/common';
import {
  DestroyRef,
  effect,
  inject,
  Injectable,
  PLATFORM_ID,
  untracked,
  type OnDestroy,
  type WritableSignal,
} from '@angular/core';

@Injectable({
  providedIn: 'root',
})
export class MessageBus implements OnDestroy {
  private readonly channel = new BroadcastChannel('mmstack-tab-sync-bus');
  private readonly listeners = new Map<
    string,
    Set<(ev: MessageEvent) => void>
  >();

  subscribe<T>(id: string, listener: (data: T) => void) {
    const wrapped = (ev: MessageEvent) => {
      try {
        if (ev.data?.id === id) listener(ev.data?.value);
      } catch {
        // noop
      }
    };
    this.channel.addEventListener('message', wrapped);
    let set = this.listeners.get(id);
    if (!set) {
      set = new Set();
      this.listeners.set(id, set);
    }
    set.add(wrapped);

    return {
      unsub: () => {
        this.channel.removeEventListener('message', wrapped);
        const cur = this.listeners.get(id);
        if (!cur) return;
        cur.delete(wrapped);
        if (cur.size === 0) this.listeners.delete(id);
      },
      post: (value: T) => this.channel.postMessage({ id, value }),
    };
  }

  ngOnDestroy(): void {
    this.channel.close();
    this.listeners.clear();
  }
}

/**
 * @deprecated The generated id hashes the call-site stack line, which collides when a shared
 * helper calls {@link tabSync} for multiple signals and diverges across minified builds during
 * a rolling deploy. Pass an explicit `{ id }` instead.
 */
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

/*
 * @deprecated Use `SyncSignalOptions` instead and pass it as the second argument to `tabSync`.
 */
type LegacySyncSignalOptions = {
  id?: string;
};

/*
 * Options for configuring the behavior of the `tabSync` function.
 */
export type SyncSignalOptions = {
  /* The channel id used to synchronize across tabs */
  id: string;
};

/**
 * @example tabSync(signal('dark'), { id: 'theme' })
 */
export function tabSync<T extends WritableSignal<any>>(
  sig: T,
  opt: SyncSignalOptions | string,
): T;

/**
 * @deprecated Use `tabSync` with `SyncSignalOptions` instead and pass the options as the second argument
 * @throws {Error} When deterministic ID generation fails and no explicit ID is provided
 */
export function tabSync<T extends WritableSignal<any>>(
  sig: T,
  opt?: LegacySyncSignalOptions,
): T;

/**
 * Synchronizes a WritableSignal across browser tabs using BroadcastChannel API.
 *
 * Creates a shared signal that automatically syncs its value between all tabs
 * of the same application. When the signal is updated in one tab, all other
 * tabs will receive the new value automatically.
 *
 * @template T - The type of the WritableSignal
 * @param sig - The WritableSignal to synchronize across tabs
 * @param opt - configuration object
 * @param opt.id - Explicit channel ID for synchronization.
 *
 * @returns The same WritableSignal instance, now synchronized across tabs
 *
 *
 * @example
 * ```typescript
 * // With explicit ID (recommended)
 * const theme = tabSync(signal('dark'), { id: 'theme' });
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
 * - Received values are not re-broadcast, so tabs never echo each other's updates
 *
 */
export function tabSync<T extends WritableSignal<any>>(
  sig: T,
  opt?: SyncSignalOptions | LegacySyncSignalOptions | string,
): T {
  if (isPlatformServer(inject(PLATFORM_ID))) return sig;

  const id =
    typeof opt === 'string' ? opt : (opt?.id ?? generateDeterministicID());

  const bus = inject(MessageBus);

  // The last value applied from a remote tab. The outbound effect skips (exactly) the run
  // caused by that write — without this, an inbound object (a fresh structured clone, so
  // never reference-equal) would be re-posted, and two tabs would ping-pong forever.
  const NONE = Symbol();
  let received: unknown = NONE;

  const { unsub, post } = bus.subscribe(id, (next) => {
    const before = untracked(sig);
    received = next;
    sig.set(next);
    // Equality-suppressed write (e.g. an identical primitive): no effect run will follow,
    // so clear the marker — it must not swallow a later, genuinely local change.
    if (untracked(sig) === before) received = NONE;
  });

  let first = false;

  const effectRef = effect(() => {
    const val = sig();
    if (!first) {
      first = true;
      return;
    }
    if (val === received) {
      received = NONE;
      return;
    }
    received = NONE;
    post(val);
  });

  inject(DestroyRef).onDestroy(() => {
    effectRef.destroy();
    unsub();
  });

  return sig;
}
