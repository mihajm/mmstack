import { type ArrowFunction, Node, Project } from 'ts-morph';
import { parseLoader } from './loader';

function arrow(expr: string): ArrowFunction {
  const sf = new Project({ useInMemoryFileSystem: true }).createSourceFile(
    'l.ts',
    `const f = ${expr};`,
  );
  const a = sf.getFirstDescendant(Node.isArrowFunction);
  if (!a) throw new Error('no arrow function');
  return a;
}

describe('parseLoader', () => {
  it('parses import().then((m) => m.a.b) into path + accessor', () => {
    expect(
      parseLoader(arrow(`() => import('./quote').then((m) => m.quote.translation)`)),
    ).toEqual({ importPath: './quote', accessor: ['quote', 'translation'] });
  });

  it('parses a single-level accessor and a paren-less callback param', () => {
    expect(parseLoader(arrow(`() => import('./x').then(m => m.quoteDe)`))).toEqual({
      importPath: './x',
      accessor: ['quoteDe'],
    });
  });

  it('parses the `() => import("x")` shorthand to an empty accessor', () => {
    expect(parseLoader(arrow(`() => import('./x')`))).toEqual({
      importPath: './x',
      accessor: [],
    });
  });

  it('accepts a template-literal module specifier (both forms)', () => {
    expect(parseLoader(arrow('() => import(`./x`)'))).toEqual({
      importPath: './x',
      accessor: [],
    });
    expect(parseLoader(arrow('() => import(`./x`).then((m) => m.a)'))).toEqual({
      importPath: './x',
      accessor: ['a'],
    });
  });

  it('parses `.then((m) => m.default)` to a default accessor', () => {
    expect(parseLoader(arrow(`() => import('./x').then((m) => m.default)`))).toEqual({
      importPath: './x',
      accessor: ['default'],
    });
  });

  it('returns null for an async/await loader (block body)', () => {
    expect(
      parseLoader(arrow(`async () => { const m = await import('./x'); return m.a; }`)),
    ).toBeNull();
  });

  it('returns null when the call is not a dynamic import', () => {
    expect(parseLoader(arrow(`() => something().then((m) => m.a)`))).toBeNull();
  });

  it('returns null when the callback does not return a member access', () => {
    expect(parseLoader(arrow(`() => import('./x').then((m) => doStuff(m))`))).toBeNull();
  });
});
