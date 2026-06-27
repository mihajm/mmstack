import * as fs from 'node:fs';
import * as path from 'node:path';
import { Project } from 'ts-morph';
import { codegenTranslationFile } from './codegen';
import { type DiscoveredNamespace, discoverFromProject } from './discover';
import { placeholderParity, validateMessage } from './icu';
import { toIdentifier } from './identifier';
import {
  fromJson,
  leafEntries,
  leafMap,
  type NestedTranslation,
  toJson,
} from './nested';
import { addLocaleLoader, findRegisterNamespaceCalls } from './registry';
import { replaceTranslationLiteral } from './update';

export type ExportFile = { fileName: string; content: string };

/** Plan the per-namespace, per-locale JSON files to write (source locale + every target locale). */
export function planExport(namespaces: DiscoveredNamespace[]): ExportFile[] {
  const files: ExportFile[] = [];
  for (const ns of namespaces) {
    files.push({
      fileName: `${ns.namespace}.${ns.source.locale}.json`,
      content: toJson(ns.source.translation),
    });
    for (const loc of ns.locales)
      files.push({
        fileName: `${ns.namespace}.${loc.locale}.json`,
        content: toJson(loc.translation),
      });
  }
  return files;
}

export type ImportIssue = { key: string; message: string };

/** Validate an incoming translation: every leaf is valid ICU, and placeholders match the source. */
export function validateImport(
  translation: NestedTranslation,
  source: NestedTranslation,
): ImportIssue[] {
  const issues: ImportIssue[] = [];
  const src = leafMap(source);
  const present = new Set<string>();

  for (const [key, message] of leafEntries(translation)) {
    present.add(key);
    const valid = validateMessage(message);
    if (!valid.ok) {
      issues.push({ key, message: `invalid ICU — ${valid.error}` });
      continue;
    }
    const sourceMessage = src.get(key);
    if (sourceMessage === undefined) continue;
    // The source comes from the developer's own TS; a broken source ICU would make
    // placeholderParity throw, so reject it cleanly per-key instead of aborting the run.
    const sourceValid = validateMessage(sourceMessage);
    if (!sourceValid.ok) {
      issues.push({ key, message: `source message is invalid ICU — ${sourceValid.error}` });
      continue;
    }
    const parity = placeholderParity(sourceMessage, message);
    if (!parity.ok) {
      const parts: string[] = [];
      if (parity.missing.length) parts.push(`missing ${parity.missing.join(', ')}`);
      if (parity.extra.length) parts.push(`unexpected ${parity.extra.join(', ')}`);
      issues.push({ key, message: `placeholder mismatch (${parts.join('; ')})` });
    }
  }

  for (const key of src.keys())
    if (!present.has(key)) issues.push({ key, message: 'missing key' });

  return issues;
}

export type ApplyResult = { created: boolean; filePath: string };

/**
 * Apply one imported locale to the project: update the existing locale module in place, or — for a
 * new locale — codegen a `createTranslation` module next to the source namespace and register its
 * loader in the `registerNamespace` call. Mutates the project; the caller saves.
 */
export function applyImport(
  project: Project,
  ns: DiscoveredNamespace,
  locale: string,
  translation: NestedTranslation,
  force = false,
): ApplyResult {
  const existing = ns.locales.find((l) => l.locale === locale);
  if (existing) {
    replaceTranslationLiteral(project, existing.moduleFilePath, existing.exportName, translation);
    return { created: false, filePath: existing.moduleFilePath };
  }

  const localeId = localeIdentifier(locale);
  if (!localeId)
    throw new Error(
      `Locale "${locale}" has no alphanumeric characters to form a valid identifier.`,
    );
  // The generated const name is derived from the namespace (so a `{ translation }` named export
  // yields `settingsDe`, not `translationDe`); the import binding stays the actual source export.
  const exportName = `${toIdentifier(ns.namespace)}${localeId}`;
  const collision = ns.locales.find(
    (l) => l.locale !== locale && localeIdentifier(l.locale) === localeId,
  );
  if (collision)
    throw new Error(
      `Locale "${locale}" collides with already-registered locale "${collision.locale}" ` +
        `(both generate identifier "${exportName}").`,
    );

  const sourceBase = path.basename(ns.source.moduleFilePath, '.ts');
  const newFilePath = path.join(
    path.dirname(ns.source.moduleFilePath),
    `${ns.namespace}.${locale}.ts`,
  );

  if (!force && fs.existsSync(newFilePath))
    throw new Error(
      `${newFilePath} already exists but locale "${locale}" isn't a registered locale. ` +
        `Remove it or pass --force to overwrite.`,
    );

  project.createSourceFile(
    newFilePath,
    codegenTranslationFile({
      namespaceVar: ns.source.exportName,
      exportName,
      locale,
      importPath: `./${sourceBase}`,
      defaultImport: ns.source.isDefaultExport,
      translation,
    }),
    { overwrite: true },
  );

  const registrySf = project.getSourceFileOrThrow(ns.registryFilePath);
  addLocaleLoader(
    registryCallFor(registrySf, ns),
    locale,
    relativeImport(ns.registryFilePath, newFilePath),
    exportName,
  );

  return { created: true, filePath: newFilePath };
}

/** Parse an export file name `namespace.locale.json`. Neither segment may contain a dot, so a
 * stray-dot name (`quote.sl.si.json`) is rejected rather than folded into a bogus locale. */
export function parseImportFileName(
  fileName: string,
): { namespace: string; locale: string } | null {
  const m = /^([^.]+)\.([^.]+)\.json$/.exec(fileName);
  return m ? { namespace: m[1], locale: m[2] } : null;
}

// ---- fs-performing runners (thin wrappers the CLI calls) -------------------------------------

export type ProjectOptions = { cwd: string; srcGlobs: string[] };

/** Sidecar written into the export dir so a later `import` knows which locale was the source,
 * even if `--source-locale` is omitted (it would otherwise default to `en` and mis-treat the
 * source dump as a target locale). */
const META_FILE = '.mmtranslate-meta.json';

const warnToStderr = (message: string): void => console.warn(`⚠ ${message}`);

/** A namespace name must map to exactly one source; duplicates would clobber files on export and
 * drop all-but-one entry on import, both silently. Fail fast so the user resolves it first. */
function assertUniqueNamespaces(namespaces: DiscoveredNamespace[]): void {
  const seen = new Set<string>();
  const dupes = new Set<string>();
  for (const n of namespaces) {
    if (seen.has(n.namespace)) dupes.add(n.namespace);
    seen.add(n.namespace);
  }
  if (dupes.size)
    throw new Error(
      `Duplicate namespace name(s): ${[...dupes].join(', ')}. ` +
        `Each namespace must be registered once — rename or remove the duplicate before export/import.`,
    );
}

function readMetaSourceLocale(inDir: string): string | undefined {
  const metaPath = path.join(inDir, META_FILE);
  if (!fs.existsSync(metaPath)) return undefined;
  try {
    const meta: unknown = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
    const value = (meta as { sourceLocale?: unknown })?.sourceLocale;
    return typeof value === 'string' ? value : undefined;
  } catch {
    return undefined;
  }
}

function buildProject(opts: ProjectOptions): Project {
  const project = new Project({
    skipAddingFilesFromTsConfig: true,
    compilerOptions: { allowJs: false },
  });
  for (const glob of opts.srcGlobs)
    project.addSourceFilesAtPaths(
      path.isAbsolute(glob) ? glob : path.join(opts.cwd, glob),
    );
  return project;
}

export function runExport(
  opts: ProjectOptions & { outDir: string; sourceLocale?: string },
): ExportFile[] {
  const sourceLocale = opts.sourceLocale ?? 'en';
  const namespaces = discoverFromProject(buildProject(opts), {
    sourceLocale,
    onWarn: warnToStderr,
  });
  assertUniqueNamespaces(namespaces);
  const files = planExport(namespaces);
  fs.mkdirSync(opts.outDir, { recursive: true });
  for (const file of files)
    fs.writeFileSync(path.join(opts.outDir, file.fileName), file.content);
  fs.writeFileSync(
    path.join(opts.outDir, META_FILE),
    JSON.stringify({ sourceLocale }, null, 2) + '\n',
  );
  return files;
}

export type ImportReport = {
  applied: number;
  rejected: { file: string; issues: ImportIssue[] }[];
};

export function runImport(
  opts: ProjectOptions & { inDir: string; sourceLocale?: string; force?: boolean },
): ImportReport {
  // Prefer the explicit flag, then the sidecar the matching export wrote, then the `en` default —
  // so a round-trip with a non-`en` source locale doesn't re-import the source dump as a target.
  const sourceLocale = opts.sourceLocale ?? readMetaSourceLocale(opts.inDir);
  const project = buildProject(opts);
  const namespaces = discoverFromProject(project, {
    sourceLocale,
    onWarn: warnToStderr,
  });
  assertUniqueNamespaces(namespaces);
  const byName = new Map(namespaces.map((n) => [n.namespace, n]));

  const rejected: ImportReport['rejected'] = [];
  let applied = 0;

  for (const fileName of fs.readdirSync(opts.inDir)) {
    const parsed = parseImportFileName(fileName);
    if (!parsed) continue;
    const ns = byName.get(parsed.namespace);
    if (!ns || parsed.locale === ns.source.locale) continue; // unknown ns, or the source itself

    let translation: NestedTranslation;
    try {
      translation = fromJson(
        fs.readFileSync(path.join(opts.inDir, fileName), 'utf8'),
      );
    } catch (e) {
      rejected.push({
        file: fileName,
        issues: [{ key: '(parse)', message: e instanceof Error ? e.message : String(e) }],
      });
      continue;
    }
    const issues = validateImport(translation, ns.source.translation);
    if (issues.length) {
      rejected.push({ file: fileName, issues });
      continue;
    }
    applyImport(project, ns, parsed.locale, translation, opts.force);
    applied++;
  }

  project.saveSync();
  return { applied, rejected };
}

export function runGenerateManifest(
  opts: ProjectOptions & { outFile: string; sourceLocale?: string },
): string {
  const sourceLocale = opts.sourceLocale ?? 'en';
  const namespaces = discoverFromProject(buildProject(opts), {
    sourceLocale,
    onWarn: warnToStderr,
  });
  assertUniqueNamespaces(namespaces);
  const entries = namespaces.map((n) => ({
    namespace: n.namespace,
    sourceLocale,
    registry: path.relative(opts.cwd, n.registryFilePath),
    source: path.relative(opts.cwd, n.source.moduleFilePath),
    locales: n.locales.map((l) => l.locale),
  }));
  const content =
    `// Generated by \`mmtranslate generate-manifest\`. Edit the globs / entries as needed.\n` +
    `export default ${JSON.stringify(entries, null, 2)};\n`;
  fs.writeFileSync(opts.outFile, content);
  return content;
}

// ---- helpers ----------------------------------------------------------------------------------

function localeIdentifier(locale: string): string {
  return locale
    .split(/[^A-Za-z0-9]/)
    .filter(Boolean)
    .map((seg) => seg.charAt(0).toUpperCase() + seg.slice(1).toLowerCase())
    .join('');
}

function relativeImport(fromFile: string, toFile: string): string {
  const rel = path
    .relative(path.dirname(fromFile), toFile)
    .replace(/\.ts$/, '')
    .split(path.sep)
    .join('/');
  return rel.startsWith('.') ? rel : `./${rel}`;
}

function registryCallFor(
  sf: ReturnType<Project['getSourceFileOrThrow']>,
  ns: DiscoveredNamespace,
) {
  // Discovery records which call this namespace came from, so we re-find it by index rather than
  // re-matching loader shapes (robust across every loader form, and unambiguous between namespaces).
  const call = findRegisterNamespaceCalls(sf)[ns.registryCallIndex];
  if (!call)
    throw new Error(
      `Could not locate the registerNamespace call for "${ns.namespace}" in ${sf.getFilePath()}.`,
    );
  return call;
}
