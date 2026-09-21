import { describe, expect, it } from 'vitest';
import { createRanges } from './ranges';

describe('createRanges', () => {
  it('grows one range from 1 under in-order admission; the prefix is the maximum', () => {
    const r = createRanges();
    expect(r.max()).toBe(0);
    expect(r.prefix()).toBe(0);
    for (let v = 1; v <= 5; v++) expect(r.add(v)).toBe(true);
    expect(r.toJSON()).toEqual([[1, 5]]);
    expect(r.prefix()).toBe(5);
    expect(r.add(3)).toBe(false); // already admitted
    expect(r.has(3)).toBe(true);
    expect(r.has(6)).toBe(false);
  });

  it('keeps a hole as two ranges and closes it when the missing version arrives', () => {
    const r = createRanges();
    r.add(1);
    r.add(3);
    expect(r.toJSON()).toEqual([[1, 1], [3, 3]]);
    expect(r.prefix()).toBe(1);
    expect(r.max()).toBe(3);
    expect(r.has(2)).toBe(false);
    r.add(2);
    expect(r.toJSON()).toEqual([[1, 3]]);
    expect(r.prefix()).toBe(3);
  });

  it('restores from persisted ranges and reports no prefix when 1 was never admitted', () => {
    const r = createRanges([[4, 6], [2, 2]]);
    expect(r.toJSON()).toEqual([[2, 2], [4, 6]]);
    expect(r.prefix()).toBe(0);
    expect(r.max()).toBe(6);
    r.add(3);
    expect(r.toJSON()).toEqual([[2, 6]]);
    r.add(1);
    expect(r.prefix()).toBe(6);
  });
});
