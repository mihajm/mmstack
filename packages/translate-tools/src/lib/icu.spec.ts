import { extractPlaceholders, placeholderParity, validateMessage } from './icu';

describe('validateMessage', () => {
  it('accepts plain text, simple args, plural, select, selectordinal, and tags', () => {
    for (const msg of [
      'plain text',
      'Hello {name}',
      '{n, plural, one {# item} other {# items}}',
      '{g, select, male {he} female {she} other {they}}',
      '{n, selectordinal, one {#st} two {#nd} other {#th}}',
      '<b>{x}</b> and {y}',
      "5 o''clock", // escaped apostrophe
      "'{' literal brace",
    ]) {
      expect(validateMessage(msg).ok).toBe(true);
    }
  });

  it('rejects malformed ICU', () => {
    expect(validateMessage('{n, plural, one {# item}').ok).toBe(false); // unclosed
    expect(validateMessage('{}').ok).toBe(false); // empty arg
  });
});

describe('extractPlaceholders', () => {
  it('returns an empty set for messages with no placeholders', () => {
    expect(extractPlaceholders('plain').size).toBe(0);
    expect(extractPlaceholders("5 o''clock").size).toBe(0);
  });

  it('extracts simple, plural, select, and selectordinal argument names', () => {
    expect(extractPlaceholders('Hi {name}')).toEqual(new Set(['name']));
    expect(extractPlaceholders('{n, plural, one {#} other {#}}')).toEqual(new Set(['n']));
    expect(extractPlaceholders('{g, select, male {x} other {y}}')).toEqual(new Set(['g']));
    expect(extractPlaceholders('{n, selectordinal, one {#st} other {#th}}')).toEqual(
      new Set(['n']),
    );
  });

  it('extracts names nested inside plural/select arms and tag children', () => {
    expect(
      extractPlaceholders('{count, plural, one {# by {author}} other {# by {author}}}'),
    ).toEqual(new Set(['count', 'author']));
    expect(extractPlaceholders('<b>{x}</b> {y}')).toEqual(new Set(['b', 'x', 'y']));
  });
});

describe('placeholderParity', () => {
  it('passes when the same placeholders appear (order/count irrelevant)', () => {
    expect(placeholderParity('Hi {name}', 'Hallo {name}').ok).toBe(true);
    expect(
      placeholderParity(
        '{count, plural, one {1 by {author}} other {# by {author}}}',
        '{count, plural, one {1 von {author}} other {# von {author}}}',
      ).ok,
    ).toBe(true);
  });

  it('reports a dropped placeholder as missing', () => {
    const r = placeholderParity('Hi {name}', 'Hallo');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.missing).toEqual(['name']);
  });

  it('reports a renamed placeholder as both missing and extra', () => {
    const r = placeholderParity('Hi {name}', 'Hallo {naam}');
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.missing).toContain('name');
      expect(r.extra).toContain('naam');
    }
  });
});
