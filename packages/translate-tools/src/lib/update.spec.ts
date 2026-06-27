import { Node, type ObjectLiteralExpression, Project } from 'ts-morph';
import { liftObjectLiteral } from './lift';
import { replaceTranslationLiteral } from './update';

function makeProject(body: string): Project {
  const p = new Project({ useInMemoryFileSystem: true });
  p.createSourceFile('/q.de.ts', body);
  return p;
}

function secondArg(p: Project): ObjectLiteralExpression {
  const call = p.getSourceFileOrThrow('/q.de.ts').getFirstDescendant(Node.isCallExpression);
  const arg = call?.getArguments()[1];
  if (!arg || !Node.isObjectLiteralExpression(arg)) throw new Error('no object arg');
  return arg;
}

describe('replaceTranslationLiteral', () => {
  it('replaces the createTranslation literal in place, preserving the import', () => {
    const p = makeProject(
      `import { quote } from './quote';
       export const quoteDe = quote.createTranslation('de', { greeting: 'alt' });`,
    );
    const next = { greeting: 'neu', detail: { x: 'y' } };

    expect(replaceTranslationLiteral(p, '/q.de.ts', 'quoteDe', next)).toBe(true);

    const text = p.getSourceFileOrThrow('/q.de.ts').getFullText();
    expect(text).toContain("import { quote } from './quote'"); // import untouched
    expect(liftObjectLiteral(secondArg(p))).toEqual(next); // literal swapped
  });

  it('returns false when the export is missing or not a call', () => {
    expect(
      replaceTranslationLiteral(makeProject(`export const other = 1;`), '/q.de.ts', 'quoteDe', {
        a: 'b',
      }),
    ).toBe(false);
  });
});
