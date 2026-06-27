import * as path from 'node:path';
import {
  type CallExpression,
  Node,
  type ObjectLiteralExpression,
  type Project,
  type SourceFile,
} from 'ts-morph';
import { toIdentifier } from './identifier';
import { liftObjectLiteral } from './lift';
import { parseLoader } from './loader';
import { type NestedTranslation } from './nested';
import { findRegisterNamespaceCalls } from './registry';

export type DiscoveredLocale = {
  locale: string;
  /** File the loader imports the translation from. */
  moduleFilePath: string;
  /** The binding name to import (named export name, or a name to default-import as). */
  exportName: string;
  /** Whether the binding is the module's default export (→ a default, not named, import). */
  isDefaultExport: boolean;
  translation: NestedTranslation;
};

export type DiscoveredNamespace = {
  namespace: string;
  /** File containing the `registerNamespace(...)` call (where new-locale loaders are inserted). */
  registryFilePath: string;
  /** Index of the matching `registerNamespace(...)` call within that file's calls. */
  registryCallIndex: number;
  /** The default loader's namespace = the source/default-locale translation. */
  source: DiscoveredLocale;
  /** Target locales declared in the `other` map. */
  locales: DiscoveredLocale[];
};

export type DiscoverOptions = {
  /** Label for the default/source translation (the app's defaultLocale). Defaults to `en`. */
  sourceLocale?: string;
  onWarn?: (message: string) => void;
};

/** Discover every `registerNamespace` registry in a ts-morph project and lift its translations. */
export function discoverFromProject(
  project: Project,
  options: DiscoverOptions = {},
): DiscoveredNamespace[] {
  const sourceLocale = options.sourceLocale ?? 'en';
  const warn = options.onWarn ?? (() => undefined);
  const out: DiscoveredNamespace[] = [];

  for (const sf of project.getSourceFiles()) {
    findRegisterNamespaceCalls(sf).forEach((call, index) => {
      const found = discoverCall(project, sf, call, index, sourceLocale, warn);
      if (found) out.push(found);
    });
  }
  return out;
}

type Resolved = {
  kind: 'namespace' | 'translation';
  namespace?: string;
  translation: NestedTranslation;
  moduleFilePath: string;
  exportName: string;
  isDefaultExport: boolean;
};

function discoverCall(
  project: Project,
  registryFile: SourceFile,
  call: CallExpression,
  registryCallIndex: number,
  sourceLocale: string,
  warn: (m: string) => void,
): DiscoveredNamespace | null {
  const defaultArg = call.getArguments()[0];
  if (!defaultArg || !Node.isArrowFunction(defaultArg)) {
    warn(`registerNamespace default loader is not an arrow function in ${registryFile.getFilePath()}`);
    return null;
  }
  const parsedDefault = parseLoader(defaultArg);
  if (!parsedDefault) {
    warn(`Unsupported default loader shape in ${registryFile.getFilePath()}`);
    return null;
  }
  const resolvedDefault = resolveExport(project, registryFile, parsedDefault, warn);
  if (!resolvedDefault || resolvedDefault.kind !== 'namespace' || !resolvedDefault.namespace) {
    warn(`Could not resolve namespace from default loader in ${registryFile.getFilePath()}`);
    return null;
  }

  const locales: DiscoveredLocale[] = [];
  const other = call.getArguments()[1];
  if (other && Node.isObjectLiteralExpression(other)) {
    for (const prop of other.getProperties()) {
      if (!Node.isPropertyAssignment(prop)) continue;
      const locale = nameText(prop.getNameNode());
      const init = prop.getInitializer();
      if (!init || !Node.isArrowFunction(init)) {
        warn(`Locale "${locale}" loader is not an arrow function`);
        continue;
      }
      const parsed = parseLoader(init);
      if (!parsed) {
        warn(`Unsupported loader shape for locale "${locale}"`);
        continue;
      }
      const resolved = resolveExport(project, registryFile, parsed, warn);
      if (!resolved) continue;
      locales.push({
        locale,
        moduleFilePath: resolved.moduleFilePath,
        exportName: resolved.exportName,
        isDefaultExport: resolved.isDefaultExport,
        translation: resolved.translation,
      });
    }
  }

  return {
    namespace: resolvedDefault.namespace,
    registryFilePath: registryFile.getFilePath(),
    registryCallIndex,
    source: {
      locale: sourceLocale,
      moduleFilePath: resolvedDefault.moduleFilePath,
      exportName: resolvedDefault.exportName,
      isDefaultExport: resolvedDefault.isDefaultExport,
      translation: resolvedDefault.translation,
    },
    locales,
  };
}

function resolveExport(
  project: Project,
  fromFile: SourceFile,
  parsed: { importPath: string; accessor: string[] },
  warn: (m: string) => void,
): Resolved | null {
  const moduleFile = resolveModule(project, fromFile.getFilePath(), parsed.importPath);
  if (!moduleFile) {
    warn(`Cannot resolve module "${parsed.importPath}" from ${fromFile.getFilePath()}`);
    return null;
  }

  const target = resolveLoaderTarget(moduleFile, parsed.accessor);
  if (!target) {
    const what = parsed.accessor[0] ? `export "${parsed.accessor[0]}"` : 'default/translation export';
    warn(`Could not resolve a ${what} in ${moduleFile.getFilePath()}`);
    return null;
  }
  const { call: init, isDefaultExport } = target;
  const callee = init.getExpression();
  const base = {
    moduleFilePath: moduleFile.getFilePath(),
    isDefaultExport,
  };

  // `createNamespace('ns', {…})` and `base.createMergedNamespace('ns', {…})` share the same
  // (namespace, literal) shape — and a merged namespace's literal holds only ITS own keys (the
  // merge is type-level), so each namespace exports independently with no duplication.
  const isCreateNamespace =
    Node.isIdentifier(callee) && callee.getText() === 'createNamespace';
  const isMergedNamespace =
    Node.isPropertyAccessExpression(callee) &&
    callee.getName() === 'createMergedNamespace';

  if (isCreateNamespace || isMergedNamespace) {
    const ns = stringArg(init, 0);
    const lit = objArg(init, 1);
    if (ns === null || !lit) return null;
    return {
      kind: 'namespace',
      namespace: ns,
      translation: liftObjectLiteral(lit),
      exportName: target.bindingName || toIdentifier(ns),
      ...base,
    };
  }

  if (Node.isPropertyAccessExpression(callee) && callee.getName() === 'createTranslation') {
    const lit = objArg(init, 1);
    if (!lit) return null;
    return {
      kind: 'translation',
      translation: liftObjectLiteral(lit),
      exportName: target.bindingName || 'translation',
      ...base,
    };
  }

  warn(`Export in ${moduleFile.getFilePath()} is not a createNamespace/createMergedNamespace/createTranslation call`);
  return null;
}

type LoaderTarget = {
  call: CallExpression;
  /** Binding name to import; empty when the default export is anonymous (caller derives one). */
  bindingName: string;
  isDefaultExport: boolean;
};

/** Map a parsed loader accessor to the `create*` call it resolves to, matching the same
 * default / translation auto-resolution `@mmstack/translate` does at runtime. */
function resolveLoaderTarget(
  moduleFile: SourceFile,
  accessor: string[],
): LoaderTarget | null {
  // Explicit named accessor: m.quote.translation, m.quoteDe, m.translation.
  if (accessor.length > 0 && accessor[0] !== 'default') {
    const call = variableCall(moduleFile, accessor[0]);
    return call ? { call, bindingName: accessor[0], isDefaultExport: false } : null;
  }

  // `() => import('x')` (accessor []) or `.then((m) => m.default)`: resolve the default export,
  // and for the shorthand fall back to a named `translation` export (the `{ translation }` shape).
  const fromDefault = defaultExportCall(moduleFile);
  if (fromDefault) return fromDefault;
  if (accessor.length === 0) {
    const call = variableCall(moduleFile, 'translation');
    if (call) return { call, bindingName: 'translation', isDefaultExport: false };
  }
  return null;
}

function variableCall(moduleFile: SourceFile, name: string): CallExpression | null {
  const init = moduleFile.getVariableDeclaration(name)?.getInitializer();
  return init && Node.isCallExpression(init) ? init : null;
}

function defaultExportCall(moduleFile: SourceFile): LoaderTarget | null {
  const assignment = moduleFile.getExportAssignment((a) => !a.isExportEquals());
  if (!assignment) return null;
  const expr = assignment.getExpression();
  if (Node.isIdentifier(expr)) {
    const call = variableCall(moduleFile, expr.getText());
    return call ? { call, bindingName: expr.getText(), isDefaultExport: true } : null;
  }
  if (Node.isCallExpression(expr))
    return { call: expr, bindingName: '', isDefaultExport: true };
  return null;
}

function resolveModule(
  project: Project,
  fromFilePath: string,
  importPath: string,
): SourceFile | undefined {
  const base = path.resolve(path.dirname(fromFilePath), importPath);
  for (const candidate of [base, `${base}.ts`, path.join(base, 'index.ts')]) {
    const sf = project.getSourceFile(candidate);
    if (sf) return sf;
  }
  return undefined;
}

function stringArg(call: CallExpression, index: number): string | null {
  const arg = call.getArguments()[index];
  return arg && (Node.isStringLiteral(arg) || Node.isNoSubstitutionTemplateLiteral(arg))
    ? arg.getLiteralText()
    : null;
}

function objArg(call: CallExpression, index: number): ObjectLiteralExpression | undefined {
  const arg = call.getArguments()[index];
  return arg && Node.isObjectLiteralExpression(arg) ? arg : undefined;
}

function nameText(node: Node): string {
  return Node.isStringLiteral(node) ? node.getLiteralText() : node.getText();
}
