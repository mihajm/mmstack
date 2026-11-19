import { setSensitiveMode } from '@mmstack/primitives/core';
import { ARRAY_METHOD_SHIMS, type ApplyFn } from './containers';

// With nothing sensitive anywhere, every shim answers what Array.prototype answers, in both modes:
// the same value (holes, subclass and all) or a throw of the same error class.

const call: ApplyFn = (target, args) =>
  (target as (...a: unknown[]) => unknown)(...args);

type Outcome = { value: unknown } | { throws: string };

function run(f: () => unknown): Outcome {
  try {
    return { value: f() };
  } catch (e) {
    return { throws: (e as Error).constructor.name };
  }
}

const native = (method: string, receiver: unknown[], args: unknown[]) =>
  run(() =>
    (receiver as unknown as Record<string, (...a: unknown[]) => unknown>)[
      method
    ](...args),
  );

const shimmed = (method: string, receiver: unknown[], args: unknown[]) =>
  run(() => ARRAY_METHOD_SHIMS[method](receiver, args, call));

class Rows<T> extends Array<T> {}

/** An array with holes at the indexes `values` leaves out. */
const sparse = (length: number, values: Record<number, unknown>): unknown[] => {
  const out = new Array<unknown>(length);
  for (const [i, v] of Object.entries(values)) out[Number(i)] = v;
  return out;
};

const holes = (): unknown[] => sparse(3, { 0: 1, 2: 2 });
const add = (a: unknown, b: unknown) => (a as number) + (b as number);
const asc = (a: unknown, b: unknown) => (a as number) - (b as number);

const cases: ReadonlyArray<[string, () => unknown[], unknown[]]> = [
  ['includes', () => [1, 2], [3]],
  ['includes', () => [NaN], [1]],
  ['includes', () => [1], [NaN]],
  ['includes', () => [NaN], [NaN]],
  ['includes', () => [1], [undefined, -5]],
  ['includes', () => new Array(2), [undefined]],
  ['includes', () => [1, 2], [2, 1n]],
  ['indexOf', () => [NaN], [NaN]],
  ['indexOf', () => [1, 2], [1, 'x']],
  ['indexOf', () => [1, 2], [2, 0.5]],
  ['indexOf', () => [1, 2, 1], [1, -1]],
  ['indexOf', () => new Array(2), [undefined]],
  ['indexOf', () => [1, undefined, 2].concat(new Array(1)), [undefined, 2]],
  ['indexOf', () => [1, 2], [2, 1n]],
  ['lastIndexOf', () => [1, 2, 3, 1], [1, -4]],
  ['lastIndexOf', () => [1, 2, 3, 1], [undefined, 4]],
  ['lastIndexOf', () => [1, 2, 3, 1], [undefined, 10]],
  ['lastIndexOf', () => [1, 2, 1], [1, 0]],
  ['lastIndexOf', () => [1, 2], [1, -2]],
  ['lastIndexOf', () => [1], [1, -5]],
  ['lastIndexOf', () => [1], [1, Infinity]],
  ['lastIndexOf', () => [1], [undefined, 5]],
  ['lastIndexOf', () => [1], [undefined, 1]],
  ['lastIndexOf', () => [1], [1, 'x']],
  ['lastIndexOf', () => [1], [2]],
  ['lastIndexOf', () => new Array(2), [undefined]],
  ['lastIndexOf', () => [1, 2], [1, 1n]],
  ['flat', () => [[1]], []],
  ['flat', () => [[[1]]], []],
  ['flat', () => [[[1]]], [1.5]],
  ['flat', () => [[1]], [0]],
  ['flat', () => [[1]], [-1]],
  ['flat', () => [sparse(3, { 0: 1, 2: 2 })], []],
  ['flat', holes, []],
  ['flat', () => [[1]], [1n]],
  ['flat', () => Rows.from([1, [2]]), []],
  ['flatMap', () => [1], [(x: unknown) => x]],
  ['flatMap', () => [1, 2], [(x: unknown) => [x, [x]]]],
  ['flatMap', () => [1], [5]],
  ['find', () => [1, 2, 3], [(x: unknown) => x === 9]],
  ['findIndex', () => [1], [(x: unknown) => x === undefined]],
  ['findLast', () => [1, 2, 3], [(x: unknown) => (x as number) < 2]],
  ['findLast', () => [1, 2], [(x: unknown) => x === 1]],
  ['findLastIndex', () => [1, 2, 3], [(x: unknown) => (x as number) < 2]],
  ['filter', () => [1, 2], [(x: unknown) => (x as number) > 1]],
  ['map', () => [], [5]],
  ['map', () => [1, 2], [(x: unknown) => (x as number) * 2]],
  ['reduce', () => [], [add]],
  ['reduce', () => [1, 2], [add]],
  ['reduce', () => [1, 2], [add, 10]],
  ['toSorted', () => [undefined, 2, 1], [asc]],
  ['toSorted', () => [undefined, 1], [asc]],
  ['toSorted', () => [1], [5]],
  ['toSorted', () => [3, 1, 2], []],
  ['toSorted', () => [10, 9, 1], []],
  ['toSorted', () => [3n, 1n, 2n], [asc]],
  ['toSorted', () => [2, 1], [() => Symbol()]],
  ['toSpliced', () => [1, 2, 3], [1, 1]],
  ['toSpliced', () => [1, 2, 3], [1, 0, 9]],
  ['slice', () => [1, 2, 3], [1]],
  ['slice', () => [1], [Symbol()]],
  ['at', () => [1, 2], [-1]],
  ['with', () => [1, 2], [0, 9]],
  ['concat', () => [0], [[1], 2]],
  ['join', () => [1, [2, 3]], ['-']],
  ['join', () => [1, null, undefined], []],
];

describe.each([false, true])(
  'array shims with mode %s agree with native',
  (mode) => {
    beforeEach(() => setSensitiveMode(mode));
    afterEach(() => setSensitiveMode(false));

    it.each(cases)('%s #%#', (method, receiver, args) => {
      const expected = native(method, receiver(), args);
      expect(shimmed(method, receiver(), args)).toStrictEqual(expected);
    });
  },
);
