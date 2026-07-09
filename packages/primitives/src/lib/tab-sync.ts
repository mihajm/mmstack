import { isPlatformServer } from '@angular/common';
import {
  DestroyRef,
  effect,
  inject,
  Injectable,
  Injector,
  isDevMode,
  PLATFORM_ID,
  untracked,
  type WritableSignal,
} from '@angular/core';
import { STORE_KIND, type StoreKind } from './store/internals';
import {
  opSync,
  type MergePolicyEntry,
  type OpEnvelope,
  type OpSyncCheckpoint,
} from './store/op-sync';

type TabMsg =
  | { t: 'env'; env: OpEnvelope }
  | { t: 'hello'; from: string; wm: Record<string, number> }
  // a checkpoint (root + register state + watermark), NOT a bare value: the joiner must
  // inherit supersession state or already-superseded stragglers would resurrect on it
  | { t: 'state'; to: string; state: OpSyncCheckpoint<object> }
  | { t: 'uptodate'; to: string };

/** Op-mode sync for a writable store: hello exchange, then live envelopes. */
function storeTabSync(
  sig: WritableSignal<object>,
  opt: StoreTabSyncOptions & { id: string },
  bus: TabSyncBus,
  injector: Injector,
): void {
  const sync = opSync(sig, {
    writer: opt.writer ?? 'local',
    policies: opt.policies,
    injector,
  });
  const helloTimeoutMs = opt.helloTimeoutMs ?? 250;
  const jitterMs = opt.jitterMs ?? 25;

  let phase: 'joining' | 'live' = 'joining';
  const joinBuffer: OpEnvelope[] = [];
  const responseTimers = new Map<string, ReturnType<typeof setTimeout>>();
  let helloTimer: ReturnType<typeof setTimeout> | undefined;

  function goLive(): void {
    if (phase === 'live') return;
    phase = 'live';
    if (helloTimer !== undefined) {
      clearTimeout(helloTimer);
      helloTimer = undefined;
    }
    for (const env of joinBuffer.splice(0)) sync.receive(env);
  }

  const { unsub, post } = bus.subscribe<TabMsg>(opt.id, (msg) => {
    if (!msg || typeof msg !== 'object') return;
    switch (msg.t) {
      case 'env':
        if (phase === 'joining') joinBuffer.push(msg.env);
        else sync.receive(msg.env);
        return;
      case 'hello': {
        if (phase !== 'live' || msg.from === sync.origin) return;
        // first responder wins: jittered answer, cancelled when someone else answers first
        const timer = setTimeout(() => {
          responseTimers.delete(msg.from);
          const snap = sync.snapshot();
          const covered = Object.entries(snap.wm).every(
            ([origin, v]) => (msg.wm[origin] ?? 0) >= v,
          );
          post(
            covered
              ? { t: 'uptodate', to: msg.from }
              : { t: 'state', to: msg.from, state: snap },
          );
        }, Math.random() * jitterMs);
        responseTimers.set(msg.from, timer);
        return;
      }
      case 'state':
      case 'uptodate': {
        const scheduled = responseTimers.get(msg.to);
        if (scheduled !== undefined) {
          clearTimeout(scheduled);
          responseTimers.delete(msg.to);
        }
        if (msg.to !== sync.origin || phase !== 'joining') return;
        if (msg.t === 'state') sync.hydrate(msg.state);
        goLive();
        return;
      }
    }
  });

  const unsubEnv = sync.subscribe((env) => post({ t: 'env', env }));
  post({ t: 'hello', from: sync.origin, wm: sync.watermark() });
  helloTimer = setTimeout(goLive, helloTimeoutMs);

  injector.get(DestroyRef).onDestroy(() => {
    if (helloTimer !== undefined) clearTimeout(helloTimer);
    for (const timer of responseTimers.values()) clearTimeout(timer);
    responseTimers.clear();
    unsubEnv();
    unsub();
    sync.destroy();
  });
}

/**
 * The cross-tab transport `tabSync` rides. The default is {@link MessageBus} (a `BroadcastChannel`);
 * pass a custom one through `tabSync`'s `bus` option to route over a different channel, or to drive
 * tabs deterministically in a test. `subscribe` returns an unsubscribe handle plus a `post` that
 * fans the value to every OTHER tab on the same `id`.
 */
export type TabSyncBus = {
  subscribe<T>(
    id: string,
    listener: (data: T) => void,
  ): { unsub: () => void; post: (value: T) => void };
};

@Injectable({
  providedIn: 'root',
})
export class MessageBus implements TabSyncBus {
  private readonly channel = new BroadcastChannel('mmstack-tab-sync-bus');
  private readonly listeners = new Map<
    string,
    Set<(ev: MessageEvent) => void>
  >();

  constructor() {
    inject(DestroyRef).onDestroy(() => {
      this.channel.close();
      this.listeners.clear();
    });
  }

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
  /**
   * Injector used when `tabSync` is called outside an injection context.
   *
   * NOTE: `tabSync` is intentionally NOT pausable. Pausing the outbound broadcast would let its
   * mount-time echo guard swallow a value changed while hidden, so other tabs would silently miss
   * it — a cross-tab consistency gap not worth the negligible saving. The channel stays live.
   */
  injector?: Injector;
  /** Cross-tab transport. Defaults to the injected {@link MessageBus} (a `BroadcastChannel`). */
  bus?: TabSyncBus;
};

/**
 * Store mode (`tabSync(store, …)`): syncs structural OPS instead of whole values — concurrent
 * edits to different leaves merge instead of clobbering, and a joining tab hydrates from a
 * peer via the hello exchange.
 */
export type StoreTabSyncOptions = SyncSignalOptions & {
  /** Principal pseudonym on emitted envelopes. Tabs share one user, so a default is fine. */
  writer?: string;
  /** Per-path merge policies (`lww` default; `mergeThree`, `preserve`, or custom). */
  policies?: readonly MergePolicyEntry[];
  /** How long a joining tab waits for a peer's answer before deciding it IS the base. */
  helloTimeoutMs?: number;
  /** Max response jitter — first responder wins, others cancel. */
  jitterMs?: number;
};

/**
 * @example tabSync(signal('dark'), { id: 'theme' })
 */
export function tabSync<T extends WritableSignal<any>>(
  sig: T,
  opt: StoreTabSyncOptions | SyncSignalOptions | string,
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
  const optObj =
    typeof opt === 'object' ? (opt as SyncSignalOptions) : undefined;
  const injector = optObj?.injector ?? inject(Injector);

  if (isPlatformServer(injector.get(PLATFORM_ID))) return sig;

  const id =
    typeof opt === 'string' ? opt : (opt?.id ?? generateDeterministicID());

  const bus = optObj?.bus ?? injector.get(MessageBus);

  const storeKind = (sig as { [STORE_KIND]?: StoreKind })[STORE_KIND];
  if (storeKind === 'writable') {
    storeTabSync(
      sig as WritableSignal<object>,
      { ...(optObj as StoreTabSyncOptions), id },
      bus,
      injector,
    );
    return sig;
  }
  if (storeKind === 'readonly') {
    if (isDevMode()) {
      console.warn(
        '[@mmstack/primitives] tabSync: a readonly store cannot receive remote ops — not synced.',
      );
    }
    return sig;
  }
  if (storeKind === 'mutable' && isDevMode()) {
    console.warn(
      '[@mmstack/primitives] tabSync: mutable stores fall back to whole-value sync (op diffing needs copy-on-write).',
    );
  }

  const NONE = Symbol();
  let received: unknown = NONE;
  let last: unknown = untracked(sig);
  const { unsub, post } = bus.subscribe(id, (next) => {
    const before = untracked(sig);
    received = next;
    sig.set(next);
    if (untracked(sig) === before) received = NONE;
  });

  const effectRef = effect(
    () => {
      const val = sig();
      if (val === last) return; // unchanged since last seen → nothing to post
      last = val;
      // came from bus → don't echo
      if (val === received) {
        received = NONE;
        return;
      }
      received = NONE;
      post(val);
    },
    { injector },
  );

  injector.get(DestroyRef).onDestroy(() => {
    effectRef.destroy();
    unsub();
  });

  return sig;
}
