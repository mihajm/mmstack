import type { WithParams } from './parameterize.type';

/**
 * Power-user escape hatch for ICU messages whose parameters can't be inferred
 * from the message string — typically variables nested inside `plural` /
 * `select` / `selectordinal` arms, which the type-level extractor skips.
 *
 * Declared params are merged with auto-extracted ones; on key conflict, the
 * declared params win. Non-default locales for a key wrapped with `withParams`
 * may be plain strings — they don't need to repeat the wrapper.
 *
 * @example
 * ```ts
 * const ns = createNamespace('quote', {
 *   // auto-extracts `count`; `name` is declared explicitly because it
 *   // lives inside the plural arms and can't be inferred
 *   stats: withParams<{ name: string }>(
 *     '{count, plural, one {1 quote from {name}} other {# quotes from {name}}}',
 *   ),
 * });
 *
 * // t inferred as: (key, { count: number; name: string }) => string
 * t('quote.stats', { count: 3, name: 'Alice' });
 * ```
 */
export function withParams<
  const P extends Record<string, unknown>,
  const S extends string = string,
>(message: S): WithParams<P, S> {
  return message as unknown as WithParams<P, S>;
}
