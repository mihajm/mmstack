/* eslint-disable @typescript-eslint/no-non-null-assertion */
import { Node, Project, type SourceFile } from 'ts-morph';
import { addLocaleLoader, findRegisterNamespaceCalls } from './registry';

function sourceFile(text: string): SourceFile {
  return new Project({ useInMemoryFileSystem: true }).createSourceFile(
    'r.ts',
    text,
  );
}

describe('registry', () => {
  it('finds registerNamespace calls and ignores registerRemoteNamespace', () => {
    const sf = sourceFile(`
      const a = registerNamespace(() => import('./a').then((m) => m.a.translation), {});
      const b = registerRemoteNamespace('cms', () => fetch('/x').then((r) => r.json()), {});
    `);
    expect(findRegisterNamespaceCalls(sf)).toHaveLength(1);
  });

  it('inserts a new locale loader into the other map', () => {
    const sf = sourceFile(`
      const a = registerNamespace(
        () => import('./quote.namespace').then((m) => m.quote.translation),
        { 'sl-SI': () => import('./quote.sl').then((m) => m.quoteSl) },
      );
    `);
    const call = findRegisterNamespaceCalls(sf)[0]!;
    addLocaleLoader(call, 'de', './quote.de', 'quoteDe');

    const text = sf.getFullText();
    expect(text).toContain(
      'de: () => import("./quote.de").then((m) => m.quoteDe)',
    );
    expect(text).toContain("'sl-SI'"); // existing untouched

    const other = call.getArguments()[1];
    if (!other || !Node.isObjectLiteralExpression(other))
      throw new Error('no other map');
    expect(other.getProperties()).toHaveLength(2); // sl-SI + de
  });

  it('quotes a non-identifier locale key', () => {
    const sf = sourceFile(`
      const a = registerNamespace(() => import('./a').then((m) => m.a.translation), {});
    `);
    addLocaleLoader(
      findRegisterNamespaceCalls(sf)[0]!,
      'sl-SI',
      './a.sl',
      'aSl',
    );
    expect(sf.getFullText()).toContain('"sl-SI": () => import("./a.sl")');
  });

  it('adds the other map when the call has only a default loader', () => {
    const sf = sourceFile(`
      const a = registerNamespace(() => import('./a').then((m) => m.a.translation));
    `);
    const call = findRegisterNamespaceCalls(sf)[0]!;
    addLocaleLoader(call, 'de', './a.de', 'aDe');
    const arg = call.getArguments()[1];
    expect(arg && Node.isObjectLiteralExpression(arg)).toBe(true);
    expect(sf.getFullText()).toContain('m.aDe');
  });

  it('replaces an existing loader for the same locale', () => {
    const sf = sourceFile(`
      const a = registerNamespace(
        () => import('./a').then((m) => m.a.translation),
        { de: () => import('./old').then((m) => m.old) },
      );
    `);
    addLocaleLoader(findRegisterNamespaceCalls(sf)[0]!, 'de', './a.de', 'aDe');
    const text = sf.getFullText();
    expect(text).toContain('./a.de');
    expect(text).not.toContain('./old');
  });
});
