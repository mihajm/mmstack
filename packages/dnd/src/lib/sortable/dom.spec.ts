import { currentTranslate, parseTranslate } from './dom';

describe('parseTranslate', () => {
  it.each([
    ['matrix(1, 0, 0, 1, 7, -20)', { x: 7, y: -20 }],
    [
      'matrix3d(1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 7, -20, 0, 1)',
      { x: 7, y: -20 },
    ],
    ['translate(5px, -20px)', { x: 5, y: -20 }],
    ['translate3d(5px, -20px, 0)', { x: 5, y: -20 }],
    ['translateX(-20px)', { x: -20, y: 0 }],
    ['translateY(-20px)', { x: 0, y: -20 }],
    ['scale(2)', { x: 0, y: 0 }],
    ['none', { x: 0, y: 0 }],
    ['', { x: 0, y: 0 }],
  ])('%s reads as %o', (value, expected) => {
    expect(parseTranslate(value)).toStrictEqual(expected);
  });

  it('reads nothing from a missing value', () => {
    expect(parseTranslate(null)).toStrictEqual({ x: 0, y: 0 });
    expect(parseTranslate(undefined)).toStrictEqual({ x: 0, y: 0 });
  });
});

describe('currentTranslate', () => {
  it('falls back to the inline transform where the DOM computes none', () => {
    const el = document.createElement('div');
    el.style.transform = 'translate(3px, 4px)';
    expect(currentTranslate(el)).toStrictEqual({ x: 3, y: 4 });
  });
});
