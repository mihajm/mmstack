/** What kind of external cause started a unit of work. */
export type OriginKind =
  'interaction' | 'navigation' | 'request' | 'action' | 'external';

/**
 * The external cause of work: a click, a navigation, a request, an action step, a timer.
 * While active (see `Telemetry.withOrigin`), it is folded into the attrs of every emit as
 * `origin.kind`, `origin.name`, and `origin.target`.
 */
export interface Origin {
  readonly kind: OriginKind;
  /** e.g. 'click', 'route-change', 'GET /users', 'save', 'timer' */
  readonly name: string;
  /** e.g. 'button#next "Next →"', '/users/:id' — optional */
  readonly target?: string;
}

/** The one label formatter every renderer uses (tracks, findings, dashboards) so labels never drift. */
export function formatOrigin(origin: Origin): string {
  if (origin.kind === 'interaction') {
    return origin.target ? `${origin.name} on ${origin.target}` : origin.name;
  }
  const base = `${origin.kind} ${origin.name}`;
  return origin.target ? `${base} → ${origin.target}` : base;
}
