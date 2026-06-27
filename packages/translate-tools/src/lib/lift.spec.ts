import { Node, type ObjectLiteralExpression, Project } from 'ts-morph';
import { liftObjectLiteral } from './lift';

function obj(source: string): ObjectLiteralExpression {
  const sf = new Project({ useInMemoryFileSystem: true }).createSourceFile('t.ts', source);
  const o = sf.getFirstDescendant(Node.isObjectLiteralExpression);
  if (!o) throw new Error('no object literal');
  return o;
}

describe('liftObjectLiteral', () => {
  it('lifts strings, deeply nested objects, and an empty object', () => {
    expect(
      liftObjectLiteral(
        obj(`const x = { a: 'A', b: { c: { d: 'D' } }, e: {} };`),
      ),
    ).toEqual({ a: 'A', b: { c: { d: 'D' } }, e: {} });
  });

  it('reads no-substitution template literals', () => {
    expect(liftObjectLiteral(obj('const x = { a: `hello` };'))).toEqual({ a: 'hello' });
  });

  it('unwraps withParams() — with and without a type argument', () => {
    expect(
      liftObjectLiteral(
        obj(`const x = {
          a: withParams<{ name: string }>('Hi {name}'),
          b: withParams('plain'),
        };`),
      ),
    ).toEqual({ a: 'Hi {name}', b: 'plain' });
  });

  it('supports identifier and quoted keys', () => {
    expect(liftObjectLiteral(obj(`const x = { 'foo-bar': 'v', baz: 'w' };`))).toEqual({
      'foo-bar': 'v',
      baz: 'w',
    });
  });

  it('throws on non-literal values (numbers, identifiers, concatenation, other calls)', () => {
    expect(() => liftObjectLiteral(obj(`const x = { a: 1 };`))).toThrow(/Unsupported translation value/);
    expect(() => liftObjectLiteral(obj(`const x = { a: someVar };`))).toThrow(/Unsupported translation value/);
    expect(() => liftObjectLiteral(obj("const x = { a: 'a' + 'b' };"))).toThrow(/Unsupported translation value/);
    expect(() => liftObjectLiteral(obj(`const x = { a: t('k') };`))).toThrow(/Unsupported call/);
  });

  it('throws on spreads and computed/shorthand entries', () => {
    expect(() => liftObjectLiteral(obj(`const x = { ...base, a: 'v' };`))).toThrow(/Unsupported entry/);
    expect(() => liftObjectLiteral(obj(`const a = 'v'; const x = { a };`))).toThrow(/Unsupported entry/);
  });
});
