import { Node, Project } from 'ts-morph';
import { codegenTranslationFile } from './codegen';
import { placeholderParity } from './icu';
import { liftObjectLiteral } from './lift';
import { fromJson } from './nested';
import { addLocaleLoader, findRegisterNamespaceCalls } from './registry';

const sourceFile = (text: string, name = 't.ts') =>
  new Project({ useInMemoryFileSystem: true }).createSourceFile(name, text);

const lift = (text: string) => {
  const o = sourceFile(text).getFirstDescendant(Node.isObjectLiteralExpression);
  if (!o) throw new Error('no object literal');
  return liftObjectLiteral(o);
};

describe('liftObjectLiteral rejects dynamic shapes with a clear error', () => {
  it('a computed key', () => {
    expect(() => lift(`const x = { [KEY]: 'v' };`)).toThrow(
      /Unsupported translation key/,
    );
  });

  it.each([`withParams(msg)`, `withParams()`])('%s', (call) => {
    expect(() => lift(`const x = { a: ${call} };`)).toThrow(/Unsupported call/);
  });
});

describe('addLocaleLoader', () => {
  const callIn = (text: string) => {
    const sf = sourceFile(text, 'r.ts');
    return { sf, call: findRegisterNamespaceCalls(sf)[0]! };
  };

  it('keeps a spread in the locale map and adds the new locale', () => {
    const { sf, call } = callIn(
      `registerNamespace(() => import('./q'), { ...base, sl: () => import('./q.sl') });`,
    );
    addLocaleLoader(call, 'de', './q.de', 'qDe');
    const text = sf.getFullText();
    expect(text).toContain('...base');
    expect(text).toContain('sl: () => import');
    expect(text).toContain('de: () => import("./q.de")');
  });

  it('leaves a two-argument call at two arguments', () => {
    const { call } = callIn(`registerNamespace(() => import('./q'), {});`);
    addLocaleLoader(call, 'de', './q.de', 'qDe');
    expect(call.getArguments()).toHaveLength(2);
  });

  it('adds the locale map to a one-argument call', () => {
    const { call } = callIn(`registerNamespace(() => import('./q'));`);
    addLocaleLoader(call, 'de', './q.de', 'qDe');
    expect(call.getArguments()).toHaveLength(2);
  });
});

describe('codegenTranslationFile', () => {
  it('emits a module with no syntax errors', () => {
    const p = new Project({ useInMemoryFileSystem: true });
    const sf = p.createSourceFile(
      '/q.de.ts',
      codegenTranslationFile({
        namespaceVar: 'quote',
        exportName: 'quoteDe',
        locale: 'de',
        importPath: './q',
        translation: { a: 'A', nested: { b: 'B' }, empty: {} },
      }),
    );
    expect(p.getProgram().getSyntacticDiagnostics(sf)).toEqual([]);
  });
});

describe('placeholderParity', () => {
  it('reports a placeholder the source lacks as extra', () => {
    expect(placeholderParity('Hi', 'Hi {name}')).toEqual({
      ok: false,
      missing: [],
      extra: ['name'],
    });
  });
});

describe('fromJson errors name the path', () => {
  it.each([
    ['{"a": {"b": 1}}', /at "a\.b"/],
    ['{"a": null}', /at "a"/],
    ['{"a": [1]}', /at "a"/],
  ])('%s', (json, path) => {
    expect(() => fromJson(json)).toThrow(path);
  });
});
