/**
 * A translator-facing translation tree: nested objects with string leaves (ICU messages). This is
 * the shape the tool exports to / imports from disk and the shape `createNamespace` /
 * `createTranslation` are authored in — the tool never touches the store's flattened form.
 */
export type NestedTranslation = { [key: string]: string | NestedTranslation };

/** Serialize a nested translation tree to a JSON file body (one namespace, one locale). */
export function toJson(nested: NestedTranslation): string {
  return JSON.stringify(nested, null, 2) + '\n';
}

/** Parse + validate a nested translation JSON file back into a {@link NestedTranslation}. */
export function fromJson(json: string): NestedTranslation {
  const parsed: unknown = JSON.parse(json);
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed))
    throw new Error('Translation JSON must be a plain object.');
  return validate(parsed as Record<string, unknown>, '');
}

/** Walk a tree's string leaves, yielding `[dottedPath, message]` for each (used for validation). */
export function leafEntries(
  nested: NestedTranslation,
  prefix = '',
): [string, string][] {
  const out: [string, string][] = [];
  for (const [key, value] of Object.entries(nested)) {
    const at = prefix ? `${prefix}.${key}` : key;
    if (typeof value === 'string') out.push([at, value]);
    else out.push(...leafEntries(value, at));
  }
  return out;
}

/** A flat `Map<dottedPath, message>` view of a tree, for key-by-key comparison. */
export function leafMap(nested: NestedTranslation): Map<string, string> {
  return new Map(leafEntries(nested));
}

function validate(value: Record<string, unknown>, path: string): NestedTranslation {
  for (const [key, child] of Object.entries(value)) {
    const at = path ? `${path}.${key}` : key;
    if (typeof child === 'string') continue;
    if (child !== null && typeof child === 'object' && !Array.isArray(child)) {
      validate(child as Record<string, unknown>, at);
      continue;
    }
    throw new Error(
      `Invalid translation value at "${at}": expected a string or a nested object.`,
    );
  }
  return value as NestedTranslation;
}
