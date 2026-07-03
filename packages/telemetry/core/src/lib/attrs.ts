// Attributes are plain key/values the consumer passes — the core sends what you
// give it (privacy is a consumer policy, applied via AttributePolicy; see RFC §6).

export type AttrValue = string | number | boolean | null | undefined;
export type Attrs = Record<string, AttrValue>;

export interface AttrMeta {
  readonly kind: 'span' | 'event' | 'error' | 'metric' | 'log';
  readonly name: string;
  readonly sink: string;
}

/** Pure transform applied to attributes before a sink receives them. */
export type AttributePolicy = (attrs: Attrs, meta: AttrMeta) => Attrs;

/** Default: send what you pass. */
export const identityPolicy: AttributePolicy = (attrs) => attrs;

/** Keep only the listed keys. */
export function allowOnly(keys: readonly string[]): AttributePolicy {
  const set = new Set(keys);
  return (attrs) => {
    const out: Attrs = {};
    for (const key of Object.keys(attrs)) {
      if (set.has(key)) out[key] = attrs[key];
    }
    return out;
  };
}

/** Drop the listed keys. */
export function deny(keys: readonly string[]): AttributePolicy {
  const set = new Set(keys);
  return (attrs) => {
    const out: Attrs = {};
    for (const key of Object.keys(attrs)) {
      if (!set.has(key)) out[key] = attrs[key];
    }
    return out;
  };
}

/** Replace the listed keys' values (default: `[redacted]`). */
export function redactKeys(
  keys: readonly string[],
  redactor: (value: AttrValue, key: string) => AttrValue = () => '[redacted]',
): AttributePolicy {
  const set = new Set(keys);
  return (attrs) => {
    const out: Attrs = { ...attrs };
    for (const key of Object.keys(out)) {
      if (set.has(key)) out[key] = redactor(out[key], key);
    }
    return out;
  };
}

/** Hash the listed keys' values via the provided hasher. */
export function hashKeys(keys: readonly string[], hash: (value: AttrValue) => string): AttributePolicy {
  const set = new Set(keys);
  return (attrs) => {
    const out: Attrs = { ...attrs };
    for (const key of Object.keys(out)) {
      if (set.has(key)) out[key] = hash(out[key]);
    }
    return out;
  };
}

/** Left-to-right composition: `compose(a, b)` applies `a` then `b`. */
export function compose(...policies: readonly AttributePolicy[]): AttributePolicy {
  return (attrs, meta) => policies.reduce((acc, policy) => policy(acc, meta), attrs);
}
