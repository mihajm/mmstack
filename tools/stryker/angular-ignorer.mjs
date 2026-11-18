// @ts-check
// Stryker ignorer: code the Angular compiler analyzes statically is never mutated. A mutant placed there
// fails the whole build (NG1010 and the errors that follow from it), not just the mutant.
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL, fileURLToPath } from 'node:url';

const WORKSPACE = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../..',
);
const runnerRequire = createRequire(
  createRequire(path.join(WORKSPACE, 'package.json')).resolve(
    '@stryker-mutator/vitest-runner/package.json',
  ),
);
const { declareValuePlugin, PluginKind } = await import(
  pathToFileURL(runnerRequire.resolve('@stryker-mutator/api/plugin')).href
);

// Signal APIs whose arguments the compiler reads. For input/model/outputFromObservable the first
// argument is a runtime value (the initial value or the source) and stays mutable.
const STATIC_ARGS = new Set([
  'input',
  'model',
  'output',
  'outputFromObservable',
  'viewChild',
  'viewChildren',
  'contentChild',
  'contentChildren',
]);
const RUNTIME_FIRST_ARG = new Set(['input', 'model', 'outputFromObservable']);

/** @param {any} callee */
function signalApi(callee) {
  if (callee.type === 'Identifier')
    return { name: callee.name, required: false };
  if (
    callee.type === 'MemberExpression' &&
    !callee.computed &&
    callee.object.type === 'Identifier' &&
    callee.property.type === 'Identifier' &&
    callee.property.name === 'required'
  ) {
    return { name: callee.object.name, required: true };
  }
  return undefined;
}

/**
 * Metadata can also read constants imported from another file, which a per-file pass cannot see. This
 * scan finds them up front: file -> names that file must keep unmutated.
 * @returns {Map<string, Set<string>>}
 */
function scanImportedMetadataConstants() {
  const ts = createRequire(path.join(WORKSPACE, 'package.json'))('typescript');
  /** @type {Map<string, Set<string>>} */
  const result = new Map();
  const ANGULAR_FILE =
    /@(Component|Directive|Pipe)\(|\b(input|model|output|viewChild|viewChildren|contentChild|contentChildren|outputFromObservable)\b/;
  /** @type {Map<string, any>} */
  const parsed = new Map();
  const parse = (/** @type {string} */ file) => {
    if (!parsed.has(file)) {
      parsed.set(
        file,
        ts.createSourceFile(
          file,
          fs.readFileSync(file, 'utf8'),
          ts.ScriptTarget.Latest,
          true,
        ),
      );
    }
    return parsed.get(file);
  };
  const resolveModule = (
    /** @type {string} */ from,
    /** @type {string} */ spec,
  ) => {
    if (!spec.startsWith('.')) return undefined;
    const base = path.resolve(path.dirname(from), spec);
    return [`${base}.ts`, path.join(base, 'index.ts')].find((f) =>
      fs.existsSync(f),
    );
  };
  /** Marks `name` as static in `file`, following re-exports. */
  const mark = (
    /** @type {string} */ file,
    /** @type {string} */ name,
    depth = 0,
  ) => {
    if (depth > 5) return;
    const sf = parse(file);
    for (const st of sf.statements) {
      if (
        ts.isVariableStatement(st) &&
        st.declarationList.declarations.some(
          (d) => ts.isIdentifier(d.name) && d.name.text === name,
        )
      ) {
        if (!result.has(file)) result.set(file, new Set());
        result.get(file)?.add(name);
        return;
      }
    }
    for (const st of sf.statements) {
      if (
        !ts.isExportDeclaration(st) ||
        !st.moduleSpecifier ||
        !ts.isStringLiteral(st.moduleSpecifier)
      )
        continue;
      const target = resolveModule(file, st.moduleSpecifier.text);
      if (!target) continue;
      if (!st.exportClause) mark(target, name, depth + 1);
      else if (ts.isNamedExports(st.exportClause)) {
        const el = st.exportClause.elements.find((e) => e.name.text === name);
        if (el) mark(target, el.propertyName?.text ?? name, depth + 1);
      }
    }
  };

  const files = fs
    .globSync('packages/**/*.ts', {
      cwd: WORKSPACE,
      exclude: (/** @type {string} */ f) =>
        f.includes('node_modules') ||
        f.endsWith('.spec.ts') ||
        f.endsWith('.d.ts'),
    })
    .map((f) => path.join(WORKSPACE, f));
  for (const file of files) {
    const text = fs.readFileSync(file, 'utf8');
    if (!ANGULAR_FILE.test(text)) continue;
    const sf = parse(file);
    /** @type {Map<string, { module: string; name: string }>} */
    const imports = new Map();
    /** @type {Map<string, any>} */
    const localConsts = new Map();
    for (const st of sf.statements) {
      if (
        ts.isImportDeclaration(st) &&
        ts.isStringLiteral(st.moduleSpecifier)
      ) {
        const bindings = st.importClause?.namedBindings;
        if (bindings && ts.isNamedImports(bindings)) {
          for (const el of bindings.elements) {
            imports.set(el.name.text, {
              module: st.moduleSpecifier.text,
              name: el.propertyName?.text ?? el.name.text,
            });
          }
        }
      }
      if (ts.isVariableStatement(st)) {
        for (const d of st.declarationList.declarations) {
          if (ts.isIdentifier(d.name) && d.initializer)
            localConsts.set(d.name.text, d.initializer);
        }
      }
    }
    const seen = new Set();
    /** @param {any} node */
    const collect = (node) => {
      if (ts.isIdentifier(node) && !seen.has(node.text)) {
        seen.add(node.text);
        const imported = imports.get(node.text);
        const target = imported && resolveModule(file, imported.module);
        if (imported && target) mark(target, imported.name);
        const local = localConsts.get(node.text);
        if (local) collect(local);
      }
      ts.forEachChild(node, collect);
    };
    /** @param {any} node */
    const visit = (node) => {
      if (ts.isDecorator(node)) collect(node.expression);
      else if (ts.isCallExpression(node)) {
        const callee = node.expression;
        const name = ts.isIdentifier(callee)
          ? callee.text
          : ts.isPropertyAccessExpression(callee) &&
              callee.name.text === 'required' &&
              ts.isIdentifier(callee.expression)
            ? callee.expression.text
            : undefined;
        const required = !ts.isIdentifier(callee);
        if (name && STATIC_ARGS.has(name)) {
          node.arguments.forEach(
            (/** @type {any} */ arg, /** @type {number} */ i) => {
              if (!(RUNTIME_FIRST_ARG.has(name) && !required && i === 0))
                collect(arg);
            },
          );
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
  }
  return result;
}

export const IMPORTED_BY_METADATA = scanImportedMetadataConstants();
const IMPORTED_BY_METADATA_NAMES = new Set(
  [...IMPORTED_BY_METADATA.values()].flatMap((names) => [...names]),
);

/** The signal API whose statically read argument `p` is, if it is one. @param {any} p */
function staticSignalArg(p) {
  if (p.listKey !== 'arguments' || !p.parentPath?.isCallExpression())
    return undefined;
  const api = signalApi(p.parentPath.node.callee);
  if (!api || !STATIC_ARGS.has(api.name)) return undefined;
  if (RUNTIME_FIRST_ARG.has(api.name) && !api.required && p.key === 0)
    return undefined;
  return api.name;
}

/** @param {any} ref */
const readStatically = (ref) =>
  !!ref.findParent(
    (/** @type {any} */ x) => x.isDecorator() || staticSignalArg(x),
  );

/**
 * Whether a module-level constant ends up in metadata the compiler evaluates: read by a decorator or a
 * static signal argument, directly or through other module-level constants.
 * @param {any} binding
 * @param {Set<unknown>} seen
 * @returns {boolean}
 */
function feedsStaticMetadata(binding, seen = new Set()) {
  if (seen.has(binding)) return false;
  seen.add(binding);
  // Stryker traverses without a file context, so imported constants match by exported name.
  if (
    binding.path.parentPath?.parentPath?.isExportNamedDeclaration() &&
    IMPORTED_BY_METADATA_NAMES.has(binding.identifier.name)
  ) {
    return true;
  }
  return binding.referencePaths.some((/** @type {any} */ ref) => {
    if (readStatically(ref)) return true;
    const declarator = ref.findParent((/** @type {any} */ x) =>
      x.isVariableDeclarator(),
    );
    if (!declarator || declarator.scope.block.type !== 'Program') return false;
    if (declarator.node.id.type !== 'Identifier') return false;
    const outer = declarator.scope.getBinding(declarator.node.id.name);
    return !!outer && feedsStaticMetadata(outer, seen);
  });
}

const angularStatic = {
  /** @param {any} p */
  shouldIgnore(p) {
    if (p.isDecorator())
      return 'Angular decorator metadata is analyzed statically by the Angular compiler';
    const api = staticSignalArg(p);
    if (api)
      return `Angular ${api}() options are analyzed statically by the Angular compiler`;
    if (
      p.isVariableDeclarator() &&
      p.parent.kind === 'const' &&
      p.node.id.type === 'Identifier' &&
      p.scope.block.type === 'Program'
    ) {
      const binding = p.scope.getBinding(p.node.id.name);
      if (binding && feedsStaticMetadata(binding)) {
        return 'Constant read by Angular metadata, which the Angular compiler analyzes statically';
      }
    }
    return undefined;
  },
};

export const strykerPlugins = [
  declareValuePlugin(PluginKind.Ignore, 'angular-static', angularStatic),
];
