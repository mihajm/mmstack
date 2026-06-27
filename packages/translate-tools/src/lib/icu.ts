import {
  type MessageFormatElement,
  parse,
  TYPE,
} from '@formatjs/icu-messageformat-parser';

export type IcuValidation = { ok: true } | { ok: false; error: string };

/** Validate an ICU message string; returns the parser's error message when invalid. */
export function validateMessage(message: string): IcuValidation {
  try {
    parse(message);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/**
 * Collect every argument/placeholder name an ICU message references, including names nested inside
 * plural/select options and tag children (e.g. `{count, plural, one {# by {author}} ...}` → count,
 * author). Throws if the message is not valid ICU — call {@link validateMessage} first.
 */
export function extractPlaceholders(message: string): Set<string> {
  const names = new Set<string>();

  const walk = (elements: MessageFormatElement[]): void => {
    for (const el of elements) {
      switch (el.type) {
        case TYPE.argument:
        case TYPE.number:
        case TYPE.date:
        case TYPE.time:
          names.add(el.value);
          break;
        case TYPE.select:
        case TYPE.plural:
          names.add(el.value);
          for (const opt of Object.values(el.options)) walk(opt.value);
          break;
        case TYPE.tag:
          names.add(el.value);
          walk(el.children);
          break;
        default:
          break; // literal / pound carry no placeholder name
      }
    }
  };

  walk(parse(message));
  return names;
}

export type ParityResult =
  | { ok: true }
  | { ok: false; missing: string[]; extra: string[] };

/**
 * Check a translated message references exactly the same placeholders as its source — the common
 * way a translation silently breaks (a dropped `{name}`, or a renamed one). `missing` are present in
 * the source but not the target; `extra` are in the target but not the source.
 */
export function placeholderParity(source: string, target: string): ParityResult {
  const s = extractPlaceholders(source);
  const t = extractPlaceholders(target);
  const missing = [...s].filter((name) => !t.has(name));
  const extra = [...t].filter((name) => !s.has(name));
  if (missing.length === 0 && extra.length === 0) return { ok: true };
  return { ok: false, missing, extra };
}
