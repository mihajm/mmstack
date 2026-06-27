import { Node, type ObjectLiteralExpression, Project } from 'ts-morph';
import { codegenTranslationFile, objectLiteralText } from './codegen';
import { liftObjectLiteral } from './lift';
import { type NestedTranslation } from './nested';

function liftBack(source: string): NestedTranslation {
  // parse the generated module and lift its createTranslation literal back
  const sf = new Project({ useInMemoryFileSystem: true }).createSourceFile('gen.ts', source);
  const call = sf.getFirstDescendant(Node.isCallExpression);
  const arg = call?.getArguments()[1];
  if (!arg || !Node.isObjectLiteralExpression(arg))
    throw new Error('generated 2nd arg is not an object literal');
  return liftObjectLiteral(arg as ObjectLiteralExpression);
}

describe('codegenTranslationFile', () => {
  it('imports the source namespace and calls createTranslation', () => {
    const out = codegenTranslationFile({
      namespaceVar: 'quote',
      exportName: 'quoteDe',
      locale: 'de',
      importPath: './quote.namespace',
      translation: { greeting: 'Hallo' },
    });
    expect(out).toContain('import { quote } from "./quote.namespace";');
    expect(out).toContain('export const quoteDe = quote.createTranslation(');
    expect(out).toContain('"de"');
  });

  it('emits a default import when the source namespace is a default export', () => {
    const out = codegenTranslationFile({
      namespaceVar: 'quote',
      exportName: 'quoteDe',
      locale: 'de',
      importPath: './quote.namespace',
      defaultImport: true,
      translation: { greeting: 'Hallo' },
    });
    expect(out).toContain('import quote from "./quote.namespace";');
    expect(out).not.toContain('import { quote }');
  });

  it.each<[string, NestedTranslation]>([
    ['empty', {}],
    ['deeply nested + quoted keys', { a: { b: { c: 'd' } }, 'odd-key': 'v' }],
    [
      'tricky strings (quotes, backslashes, newlines, ICU apostrophes)',
      {
        quoted: 'say "hi"',
        backslash: 'a\\b',
        newline: 'line1\nline2',
        icu: "5 o''clock with {n, plural, one {# thing} other {# things}}",
      },
    ],
  ])('round-trips %s through lift', (_label, translation) => {
    const out = codegenTranslationFile({
      namespaceVar: 'ns',
      exportName: 'nsDe',
      locale: 'de',
      importPath: './ns',
      translation,
    });
    expect(liftBack(out)).toEqual(translation);
  });

  it('objectLiteralText is parseable and lifts back to the input', () => {
    const t = { a: 'x', nested: { b: 'y' } };
    expect(liftBack(`const v = ns.createTranslation('de', ${objectLiteralText(t)});`)).toEqual(t);
  });
});
