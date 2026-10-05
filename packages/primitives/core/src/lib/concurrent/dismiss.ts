import { type ErroredEntry } from './census';

export type DismissalMap = ReadonlyMap<string, number>;

export const EMPTY_DISMISSALS: DismissalMap = new Map();

export function isDismissable(entry: ErroredEntry): boolean {
  return (
    entry.failure.generation !== undefined && entry.member.retry === undefined
  );
}

export function presentedErrored(
  entries: readonly ErroredEntry[],
  dismissed: DismissalMap,
): readonly ErroredEntry[] {
  return entries.filter(
    (entry) =>
      entry.failure.generation === undefined ||
      dismissed.get(entry.member.id) !== entry.failure.generation,
  );
}

export function dismissEntry(
  dismissed: DismissalMap,
  entry: ErroredEntry,
): DismissalMap {
  const generation = entry.failure.generation;
  if (generation === undefined || !isDismissable(entry)) return dismissed;
  const next = new Map(dismissed);
  next.set(entry.member.id, generation);
  return next;
}

/** The entries a dismiss sweep would actually act on: presented right now, and dismissable. */
export function dismissableEntries(
  dismissed: DismissalMap,
  entries: readonly ErroredEntry[],
): readonly ErroredEntry[] {
  return presentedErrored(entries, dismissed).filter(isDismissable);
}

export function dismissAllEntries(
  dismissed: DismissalMap,
  entries: readonly ErroredEntry[],
): DismissalMap {
  let next = dismissed;
  for (const entry of dismissableEntries(dismissed, entries)) {
    next = dismissEntry(next, entry);
  }
  return next;
}
