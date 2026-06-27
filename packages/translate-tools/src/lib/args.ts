/** Minimal argv option readers shared by the CLI. Both guard against a missing value so a typo
 * (`--out --in i18n`) throws instead of silently swallowing the next flag as the option's value. */

/** Read a `--name value` option; throws if the value is missing or is itself a flag. Returns
 * undefined when the option is absent. */
export function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(`--${name}`);
  if (i < 0) return undefined;
  const value = args[i + 1];
  if (value === undefined || value.startsWith('--'))
    throw new Error(`Missing value for --${name}`);
  return value;
}

/** Read a repeatable `--name value` option into an array; throws on any missing value. */
export function multiFlag(args: string[], name: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] !== `--${name}`) continue;
    const value = args[i + 1];
    if (value === undefined || value.startsWith('--'))
      throw new Error(`Missing value for --${name}`);
    out.push(value);
    i += 1;
  }
  return out;
}
