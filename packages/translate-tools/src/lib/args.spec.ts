import { flag, multiFlag } from './args';

describe('flag', () => {
  it('reads a value and returns undefined when absent', () => {
    expect(flag(['--out', 'i18n'], 'out')).toBe('i18n');
    expect(flag(['--out', 'i18n'], 'in')).toBeUndefined();
  });

  it('throws when the value is missing or is another flag', () => {
    expect(() => flag(['--out'], 'out')).toThrow(/Missing value for --out/);
    expect(() => flag(['--out', '--source-locale', 'en'], 'out')).toThrow(
      /Missing value for --out/,
    );
  });
});

describe('multiFlag', () => {
  it('collects every occurrence', () => {
    expect(multiFlag(['--src', 'a/**', '--src', 'b/**'], 'src')).toEqual([
      'a/**',
      'b/**',
    ]);
    expect(multiFlag(['--out', 'x'], 'src')).toEqual([]);
  });

  it('throws when any occurrence is missing its value', () => {
    expect(() => multiFlag(['--src', 'a/**', '--src'], 'src')).toThrow(
      /Missing value for --src/,
    );
    expect(() => multiFlag(['--src', '--out', 'x'], 'src')).toThrow(
      /Missing value for --src/,
    );
  });
});
