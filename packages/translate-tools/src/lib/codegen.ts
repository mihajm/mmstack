import { isIdentifier } from './identifier';
import { type NestedTranslation } from './nested';

export type TranslationFileInput = {
  /** The imported source-namespace const (e.g. `quote`), whose `.createTranslation` we call. */
  namespaceVar: string;
  /** The exported const name for the generated locale (e.g. `quoteDe`). */
  exportName: string;
  /** Target locale (e.g. `de`). */
  locale: string;
  /** Import specifier for the source namespace module, relative to the generated file. */
  importPath: string;
  /** Whether the source namespace is the module's default export (→ a default import). */
  defaultImport?: boolean;
  /** The translated tree (plain strings — target locales never need `withParams`). */
  translation: NestedTranslation;
};

function key(k: string): string {
  return isIdentifier(k) ? k : JSON.stringify(k);
}

/**
 * Serialize a nested translation tree to a TypeScript object-literal string. Double-quoted via
 * `JSON.stringify`: correct escaping for ICU (which uses `'` for its own escaping, so single-quoting
 * would be unsafe). A consumer's formatter normalizes quote style/indentation on save.
 */
export function objectLiteralText(obj: NestedTranslation, depth = 1): string {
  const entries = Object.entries(obj);
  if (entries.length === 0) return '{}';
  const inner = '  '.repeat(depth + 1);
  const pad = '  '.repeat(depth);
  const lines = entries.map(([k, value]) => {
    const v =
      typeof value === 'string'
        ? JSON.stringify(value)
        : objectLiteralText(value, depth + 1);
    return `${inner}${key(k)}: ${v},`;
  });
  return `{\n${lines.join('\n')}\n${pad}}`;
}

/**
 * Emit a target-locale TypeScript module that calls `createTranslation` on the source namespace —
 * the TS-first import format. The output is valid TS that round-trips through {@link liftObjectLiteral}.
 */
export function codegenTranslationFile(input: TranslationFileInput): string {
  const importClause = input.defaultImport
    ? input.namespaceVar
    : `{ ${input.namespaceVar} }`;
  return (
    `import ${importClause} from ${JSON.stringify(input.importPath)};\n\n` +
    `export const ${input.exportName} = ${input.namespaceVar}.createTranslation(\n` +
    `  ${JSON.stringify(input.locale)},\n` +
    `  ${objectLiteralText(input.translation, 1)},\n` +
    `);\n`
  );
}
