/** A bare (unquoted) JavaScript identifier — used by both codegen and registry insertion to decide
 * whether an object key / locale must be string-quoted. Kept in one place so the two emit paths
 * can't disagree on quoting. */
const IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

export function isIdentifier(value: string): boolean {
  return IDENTIFIER.test(value);
}

/** Best-effort valid identifier derived from an arbitrary name (e.g. a namespace). */
export function toIdentifier(name: string): string {
  const cleaned = name.replace(/[^A-Za-z0-9_$]/g, '');
  if (!cleaned) return 'source';
  return isIdentifier(cleaned) ? cleaned : `ns${cleaned}`;
}
