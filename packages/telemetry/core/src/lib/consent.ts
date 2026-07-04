import {
  computed,
  isDevMode,
  signal,
  type Signal,
  untracked,
} from '@angular/core';

/**
 * Headless, reactive consent (RFC §7). The consumer declares what the app wants
 * to track as {@link TrackingRequirement}s; the facade exposes `requirements` /
 * `pending` / `consent` signals plus `decide()`, and gates categorized emits on
 * the decisions. No UI ships here — the prompt/flow is the consumer's.
 */

export type ConsentDecision = 'granted' | 'denied';

export type TrackingRequirement = {
  /** Decision key — `decide(id, …)` and the persisted record are keyed by this. */
  readonly id: string;
  /** The category this requirement covers; emits opt in via `EmitOptions.category`. */
  readonly category: string;
  /** Restrict to one sink (by name). Omitted = applies to every sink. */
  readonly sink?: string;
  /** Human-readable purpose, for the consumer's consent prompt. */
  readonly purpose: string;
};

/**
 * Persistence for consent decisions. `get` may return the record synchronously
 * (no hydration gap) or as a promise; while an async `get` is in flight,
 * categorized emits whose decision is still unknown are deferred and drained
 * once hydration settles. `set` is fire-and-forget.
 */
export interface ConsentStore {
  get():
    | PromiseLike<Readonly<Record<string, ConsentDecision>> | null | undefined>
    | Readonly<Record<string, ConsentDecision>>
    | null
    | undefined;
  set(
    decisions: Readonly<Record<string, ConsentDecision>>,
  ): PromiseLike<void> | void;
}

export type ConsentConfig = {
  /** What the app wants to track. Signal-backed for dynamic/SDUI delta re-consent. */
  readonly requirements:
    | readonly TrackingRequirement[]
    | Signal<readonly TrackingRequirement[]>;
  /**
   * `'required'` (default): a categorized emit needs an explicit grant — undecided
   * or unknown categories are dropped. `'implicit'`: emits flow unless denied.
   */
  readonly mode?: 'required' | 'implicit';
  readonly store?: ConsentStore;
  /** How long to defer undecided emits while an async store hydrates (default 5s). */
  readonly hydrationTimeoutMs?: number;
};

/** localStorage-backed {@link ConsentStore}; a no-op off the browser. */
export function localStorageConsentStore(
  key = 'mmstack:telemetry-consent',
): ConsentStore {
  const storage = (): Storage | null => {
    try {
      return typeof localStorage === 'undefined' ? null : localStorage;
    } catch {
      return null;
    }
  };
  return {
    get: () => {
      const raw = storage()?.getItem(key);
      if (!raw) return null;
      try {
        return JSON.parse(raw) as Record<string, ConsentDecision>;
      } catch {
        return null;
      }
    },
    set: (decisions) => {
      try {
        storage()?.setItem(key, JSON.stringify(decisions));
      } catch {
        // quota/privacy-mode failures must never break telemetry
      }
    },
  };
}

export type ConsentVerdict = 'allow' | 'drop' | 'defer';

export type ConsentState = {
  readonly requirements: Signal<readonly TrackingRequirement[]>;
  readonly pending: Signal<readonly TrackingRequirement[]>;
  readonly consent: Signal<Readonly<Record<string, ConsentDecision>>>;
  decide(id: string, grant: boolean): void;
  /** Verdict for delivering an emit with `category` to the sink named `sink`. */
  gate(category: string | undefined, sink: string): ConsentVerdict;
  /** Queue a deferred delivery; it re-gates and runs (or drops) on settle/decide. */
  defer(category: string, sink: string, deliver: () => void): void;
  destroy(): void;
};

const isThenable = (v: unknown): v is PromiseLike<unknown> =>
  v != null && typeof (v as PromiseLike<unknown>).then === 'function';

/** Consent disabled (no config): everything is allowed, signals stay empty. */
export function createNoopConsent(): ConsentState {
  const empty = computed(() => []);
  return {
    requirements: empty,
    pending: empty,
    consent: computed(() => ({})),
    decide: () => undefined,
    gate: () => 'allow',
    defer: () => undefined,
    destroy: () => undefined,
  };
}

export function createConsentState(config: ConsentConfig): ConsentState {
  const mode = config.mode ?? 'required';
  const requirements: Signal<readonly TrackingRequirement[]> =
    typeof config.requirements === 'function'
      ? config.requirements
      : signal(config.requirements).asReadonly();

  const decisions = signal<Readonly<Record<string, ConsentDecision>>>({});
  const pending = computed(() => {
    const decided = decisions();
    return requirements().filter((r) => decided[r.id] === undefined);
  });

  let hydrating = false;
  let hydrationTimer: ReturnType<typeof setTimeout> | undefined;
  const deferred: { category: string; sink: string; deliver: () => void }[] =
    [];
  const warned = new Set<string>();

  const settleHydration = (): void => {
    if (!hydrating) return;
    hydrating = false;
    if (hydrationTimer !== undefined) {
      clearTimeout(hydrationTimer);
      hydrationTimer = undefined;
    }
    drainDeferred();
  };

  const drainDeferred = (): void => {
    for (let i = deferred.length - 1; i >= 0; i--) {
      const item = deferred[i];
      const verdict = gate(item.category, item.sink);
      if (verdict === 'defer') continue; // still hydrating + undecided
      deferred.splice(i, 1);
      if (verdict === 'allow') item.deliver();
    }
  };

  const gate = (category: string | undefined, sink: string): ConsentVerdict => {
    if (category === undefined) return 'allow'; // uncategorized telemetry is not consent-gated
    const decided = untracked(decisions);
    const relevant = untracked(requirements).filter(
      (r) =>
        r.category === category && (r.sink === undefined || r.sink === sink),
    );

    if (relevant.length === 0) {
      if (mode === 'implicit') return 'allow';
      // required mode: an undeclared category can never be granted — likely a config bug
      if (isDevMode() && !warned.has(category)) {
        warned.add(category);
        console.warn(
          `[telemetry] emit category "${category}" has no declared TrackingRequirement — dropped (mode: required)`,
        );
      }
      return 'drop';
    }

    let undecided = false;
    for (const r of relevant) {
      const d = decided[r.id];
      if (d === 'denied') return 'drop';
      if (d === undefined) undecided = true;
    }
    if (!undecided) return 'allow'; // every relevant requirement granted
    // Undecided: during hydration a stored decision may still arrive — defer either
    // mode (an implicit-mode emit must not race a stored denial). Settled: the mode rules.
    if (hydrating) return 'defer';
    return mode === 'implicit' ? 'allow' : 'drop';
  };

  const persist = (): void => {
    if (!config.store) return;
    try {
      const result = config.store.set(untracked(decisions));
      if (isThenable(result)) {
        result.then(undefined, (err: unknown) => {
          if (isDevMode())
            console.warn('[telemetry] ConsentStore.set failed', err);
        });
      }
    } catch (err) {
      if (isDevMode()) console.warn('[telemetry] ConsentStore.set failed', err);
    }
  };

  // hydrate stored decisions (sync stores settle immediately — no deferral window)
  if (config.store) {
    let stored: ReturnType<ConsentStore['get']>;
    try {
      stored = config.store.get();
    } catch (err) {
      if (isDevMode()) console.warn('[telemetry] ConsentStore.get failed', err);
      stored = null;
    }
    if (isThenable(stored)) {
      hydrating = true;
      hydrationTimer = setTimeout(
        () => settleHydration(),
        config.hydrationTimeoutMs ?? 5_000,
      );
      stored.then(
        (value) => {
          if (value) decisions.update((curr) => ({ ...value, ...curr }));
          settleHydration();
        },
        (err: unknown) => {
          if (isDevMode())
            console.warn('[telemetry] ConsentStore.get failed', err);
          settleHydration();
        },
      );
    } else if (stored) {
      decisions.set({ ...stored });
    }
  }

  return {
    requirements,
    pending,
    consent: decisions.asReadonly(),
    decide: (id, grant) => {
      decisions.update((curr) => ({
        ...curr,
        [id]: grant ? 'granted' : 'denied',
      }));
      persist();
      drainDeferred(); // a decision may release (or drop) deferred deliveries early
    },
    gate,
    defer: (category, sink, deliver) => {
      deferred.push({ category, sink, deliver });
    },
    destroy: () => {
      if (hydrationTimer !== undefined) {
        clearTimeout(hydrationTimer);
        hydrationTimer = undefined;
      }
      hydrating = false;
      deferred.length = 0;
    },
  };
}
