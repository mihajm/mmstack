const KEY_DELIM = '::MMT_DELIM::';

export function prependDelim(prefix: string, key: string): string {
  return `${prefix}${KEY_DELIM}${key}`;
}

export function replaceWithDelim(str: string, repl = '.'): string {
  return str.replaceAll(KEY_DELIM, repl);
}
