/**
 * @internal
 * Type guard for an array-index-like property key: a non-empty string that parses to a finite
 * number (e.g. `'0'`, `'42'`). Used to choose array-vs-object shape during autovivification and
 * deep store proxying.
 */
export function isIndexProp(prop: PropertyKey): prop is `${number}` {
  return typeof prop === 'string' && prop.trim() !== '' && !isNaN(+prop);
}
