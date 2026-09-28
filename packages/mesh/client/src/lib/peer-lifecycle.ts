/**
 * The per-origin lifecycle of peer links as a pure reducer. `peerLinks` feeds it every
 * membership and link event and executes the effects it returns, in order; nothing else
 * decides when a link is built, dropped or rebuilt.
 *
 * While the links are open, every listed origin is in exactly one state: `linking` (a peer, an
 * open timeout armed), `open` (a peer, every channel open, no timer) or `waiting` (no peer, a
 * rebuild timer armed). An unlisted origin has no state. After `close` nothing happens again.
 */
export type LinkState = 'linking' | 'open' | 'waiting';

export type LifecycleEvent =
  /** A member joined, or a waiting member's announce arrived: build now. */
  | { readonly t: 'listed'; readonly origin: string }
  | { readonly t: 'welcome'; readonly members: readonly string[] }
  | { readonly t: 'gone'; readonly origin: string }
  | { readonly t: 'opened'; readonly origin: string }
  /** A channel closed, the connector reported the link gone, or the open timeout fired. */
  | { readonly t: 'lost'; readonly origin: string }
  /** The rebuild timer fired. */
  | { readonly t: 'due'; readonly origin: string }
  | { readonly t: 'close' };

export type LifecycleEffect =
  | { readonly t: 'build'; readonly origin: string }
  | { readonly t: 'drop'; readonly origin: string }
  | { readonly t: 'armOpen'; readonly origin: string }
  | {
      readonly t: 'armRetry';
      readonly origin: string;
      readonly attempt: number;
    }
  | { readonly t: 'disarm'; readonly origin: string };

export type LinkEntry = {
  readonly state: LinkState;
  /** Losses since the link last opened. */
  readonly attempt: number;
  /** Lost at least once since it last opened. */
  readonly stalled: boolean;
};

export type Lifecycle = ReadonlyMap<string, LinkEntry>;

export type LifecycleStep = {
  readonly next: Lifecycle;
  readonly effects: readonly LifecycleEffect[];
};

/** The starting value: nothing listed. */
export const emptyLifecycle: Lifecycle = new Map();

/** The value after `close`; `step` recognises it by identity and ignores every later event. */
export const closedLifecycle: Lifecycle = new Map();

const hasPeer = (e: LinkEntry | undefined): boolean =>
  e?.state === 'linking' || e?.state === 'open';

const hasTimer = (e: LinkEntry | undefined): boolean =>
  e?.state === 'linking' || e?.state === 'waiting';

/**
 * Builds now for a listed origin with no peer; keeps an existing one. The open timeout is
 * armed before the build so a link that opens while it is being built cancels it.
 */
const listOne = (
  s: Map<string, LinkEntry>,
  origin: string,
  effects: LifecycleEffect[],
): void => {
  const cur = s.get(origin);
  if (hasPeer(cur)) return;
  if (cur) effects.push({ t: 'disarm', origin });
  effects.push({ t: 'armOpen', origin }, { t: 'build', origin });
  s.set(origin, {
    state: 'linking',
    attempt: cur?.attempt ?? 0,
    stalled: cur?.stalled ?? false,
  });
};

const unlistOne = (
  s: Map<string, LinkEntry>,
  origin: string,
  effects: LifecycleEffect[],
): void => {
  const cur = s.get(origin);
  if (!cur) return;
  if (hasPeer(cur)) effects.push({ t: 'drop', origin });
  effects.push({ t: 'disarm', origin });
  s.delete(origin);
};

const none = (s: Lifecycle): LifecycleStep => ({ next: s, effects: [] });

/** One transition. Pure and total: an event that does not apply returns `s` and no effects. */
export function step(s: Lifecycle, e: LifecycleEvent): LifecycleStep {
  if (s === closedLifecycle) return none(s);
  const effects: LifecycleEffect[] = [];
  const next = new Map(s);
  switch (e.t) {
    case 'listed':
      if (hasPeer(s.get(e.origin))) return none(s);
      listOne(next, e.origin, effects);
      break;
    case 'welcome': {
      const listed = new Set(e.members);
      for (const origin of s.keys())
        if (!listed.has(origin)) unlistOne(next, origin, effects);
      for (const origin of listed) listOne(next, origin, effects);
      break;
    }
    case 'gone':
      if (!s.has(e.origin)) return none(s);
      unlistOne(next, e.origin, effects);
      break;
    case 'opened': {
      const cur = s.get(e.origin);
      if (cur?.state !== 'linking') return none(s);
      next.set(e.origin, { state: 'open', attempt: 0, stalled: false });
      effects.push({ t: 'disarm', origin: e.origin });
      break;
    }
    case 'lost': {
      const cur = s.get(e.origin);
      if (!cur || !hasPeer(cur)) return none(s);
      next.set(e.origin, {
        state: 'waiting',
        attempt: cur.attempt + 1,
        stalled: true,
      });
      effects.push(
        { t: 'drop', origin: e.origin },
        { t: 'armRetry', origin: e.origin, attempt: cur.attempt },
      );
      break;
    }
    case 'due': {
      const cur = s.get(e.origin);
      if (cur?.state !== 'waiting') return none(s);
      next.set(e.origin, { ...cur, state: 'linking' });
      effects.push(
        { t: 'armOpen', origin: e.origin },
        { t: 'build', origin: e.origin },
      );
      break;
    }
    case 'close':
      for (const [origin, cur] of s) {
        if (hasPeer(cur)) effects.push({ t: 'drop', origin });
        if (hasTimer(cur)) effects.push({ t: 'disarm', origin });
      }
      return { next: closedLifecycle, effects };
  }
  return { next, effects };
}

/**
 * The wait before rebuild number `attempt` (0-based): equal jitter over a capped exponential,
 * so every delay lies in `[base / 2, base)` with `base = min(minMs * 2^attempt, maxMs)`.
 */
export function retryDelay(
  attempt: number,
  bounds: { readonly minMs: number; readonly maxMs: number },
  random: () => number,
): number {
  const base = Math.min(bounds.minMs * 2 ** attempt, bounds.maxMs);
  return base / 2 + random() * (base / 2);
}
