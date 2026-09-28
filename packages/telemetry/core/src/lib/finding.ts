import { type Attrs } from './attrs';

export type FindingSeverity = 'info' | 'warn' | 'error';

/** An issue to report, minus its identity (the code is passed separately to `finding()`). */
export interface FindingSpec {
  readonly severity: FindingSeverity;
  /** where in the consumer's own model the issue sits (a dotted path, a route, a component id) */
  readonly path: string;
  readonly node?: string;
  /** the repair, in the author's register — what to change, not what went wrong */
  readonly message: string;
  /** structured, value-free metadata only */
  readonly data?: Attrs;
}

/** A reported issue with a stable code and a grouping fingerprint. */
export interface Finding extends FindingSpec {
  readonly code: string;
  /** `${code}|${path}|${node ?? ''}` — the grouping identity */
  readonly fingerprint: string;
}

/** The grouping identity of a finding, so vendors bucket recurrences together. */
export function fingerprintOf(
  code: string,
  path: string,
  node?: string,
): string {
  return `${code}|${path}|${node ?? ''}`;
}
