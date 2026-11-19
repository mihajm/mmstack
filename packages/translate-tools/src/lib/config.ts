import * as fs from 'node:fs';
import * as path from 'node:path';
import { Node, Project } from 'ts-morph';
import { type DiscoveredNamespace } from './discover';

/** The config `mmtranslate` reads from `mmtranslate.config.ts` (or `--config <file>`). Every field
 * is optional; a command-line flag wins over the config. */
export type MmtranslateConfig = {
  /** Source globs to scan, relative to the config file. Default for `--src`. */
  src?: string[];
  /** Label for the source translation. Default for `--source-locale`. */
  sourceLocale?: string;
  /** Limit every command except `generate-manifest` to these namespaces. */
  namespaces?: string[];
};

export const DEFAULT_CONFIG_FILE = 'mmtranslate.config.ts';

const KEYS = ['src', 'sourceLocale', 'namespaces'];

/** Statically read a config module (no code runs). Accepts `export default { ... }`, optionally
 * through a const or a `satisfies` / `as` clause, and the 1.1 manifest (an array of entries). */
export function parseConfig(text: string, fileName: string): MmtranslateConfig {
  const fail = (why: string): never => {
    throw new Error(`Invalid config ${fileName}: ${why}`);
  };
  const sf = new Project({ useInMemoryFileSystem: true }).createSourceFile(
    'config.ts',
    text,
  );
  let expr: Node | undefined = sf
    .getExportAssignment((a) => !a.isExportEquals())
    ?.getExpression();
  if (expr) expr = unwrap(expr);
  if (expr && Node.isIdentifier(expr)) {
    const init = sf.getVariableDeclaration(expr.getText())?.getInitializer();
    expr = init && unwrap(init);
  }
  if (!expr) return fail('expected `export default { ... }`');

  if (Node.isArrayLiteralExpression(expr)) {
    const entries = expr.getElements().map((e) => entryOf(e, fail));
    const locales = new Set(entries.map((e) => e.sourceLocale));
    const [only] = locales;
    return {
      namespaces: entries.map((e) => e.namespace),
      ...(locales.size === 1 && only !== undefined
        ? { sourceLocale: only }
        : {}),
    };
  }
  if (!Node.isObjectLiteralExpression(expr))
    return fail('the default export must be an object literal');

  const config: MmtranslateConfig = {};
  for (const prop of expr.getProperties()) {
    if (!Node.isPropertyAssignment(prop))
      return fail(`unsupported entry ${prop.getText()}`);
    const key = literalText(prop.getNameNode()) ?? prop.getName();
    const value = unwrap(prop.getInitializerOrThrow());
    if (key === 'src') {
      const single = literalText(value);
      config.src =
        single !== undefined
          ? [single]
          : (stringArray(value) ??
            fail('"src" must be a string or an array of strings'));
    } else if (key === 'sourceLocale') {
      config.sourceLocale =
        literalText(value) ?? fail('"sourceLocale" must be a string');
    } else if (key === 'namespaces') {
      if (!Node.isArrayLiteralExpression(value))
        return fail('"namespaces" must be an array');
      config.namespaces = value
        .getElements()
        .map((e) => literalText(unwrap(e)) ?? entryOf(e, fail).namespace);
    } else {
      return fail(`unknown key "${key}" (known: ${KEYS.join(', ')})`);
    }
  }
  return config;
}

export type LoadedConfig = { config: MmtranslateConfig; filePath: string };

/** Load `explicit` (relative to `cwd`; must exist), else `mmtranslate.config.ts` in `cwd` if
 * present. Relative `src` globs are resolved against the config file's directory. */
export function loadConfig(
  cwd: string,
  explicit?: string,
): LoadedConfig | undefined {
  const filePath = path.resolve(cwd, explicit ?? DEFAULT_CONFIG_FILE);
  if (!fs.existsSync(filePath)) {
    if (explicit) throw new Error(`Config file not found: ${filePath}`);
    return undefined;
  }
  const config = parseConfig(fs.readFileSync(filePath, 'utf8'), filePath);
  const dir = path.dirname(filePath);
  if (config.src)
    config.src = config.src.map((g) =>
      path.isAbsolute(g) ? g : path.join(dir, g),
    );
  return { config, filePath };
}

/** Keep the listed namespaces (all when `names` is undefined), warning about each discovered
 * namespace left out and each listed one that was not found. */
export function pinNamespaces(
  found: DiscoveredNamespace[],
  names: readonly string[] | undefined,
  warn: (message: string) => void,
): DiscoveredNamespace[] {
  if (!names) return found;
  const wanted = new Set(names);
  const seen = new Set(found.map((n) => n.namespace));
  for (const name of names)
    if (!seen.has(name))
      warn(
        `Namespace "${name}" is listed in the config but was not discovered`,
      );
  return found.filter((n) => {
    if (wanted.has(n.namespace)) return true;
    warn(
      `Namespace "${n.namespace}" is not listed in the config's namespaces; skipped`,
    );
    return false;
  });
}

function unwrap(node: Node): Node {
  let cur = node;
  while (
    Node.isParenthesizedExpression(cur) ||
    Node.isAsExpression(cur) ||
    Node.isSatisfiesExpression(cur)
  )
    cur = cur.getExpression();
  return cur;
}

function literalText(node: Node): string | undefined {
  return Node.isStringLiteral(node) ||
    Node.isNoSubstitutionTemplateLiteral(node)
    ? node.getLiteralText()
    : undefined;
}

function stringArray(node: Node): string[] | undefined {
  if (!Node.isArrayLiteralExpression(node)) return undefined;
  const out: string[] = [];
  for (const el of node.getElements()) {
    const text = literalText(unwrap(el));
    if (text === undefined) return undefined;
    out.push(text);
  }
  return out;
}

function entryOf(
  node: Node,
  fail: (why: string) => never,
): { namespace: string; sourceLocale?: string } {
  const obj = unwrap(node);
  if (!Node.isObjectLiteralExpression(obj))
    return fail(`expected a namespace name or entry, got ${node.getText()}`);
  const read = (name: string) => {
    for (const prop of obj.getProperties())
      if (
        Node.isPropertyAssignment(prop) &&
        (literalText(prop.getNameNode()) ?? prop.getName()) === name
      )
        return literalText(unwrap(prop.getInitializerOrThrow()));
    return undefined;
  };
  const namespace = read('namespace');
  if (typeof namespace !== 'string')
    return fail(`entry ${obj.getText()} needs a string "namespace"`);
  const sourceLocale = read('sourceLocale');
  return typeof sourceLocale === 'string'
    ? { namespace, sourceLocale }
    : { namespace };
}
