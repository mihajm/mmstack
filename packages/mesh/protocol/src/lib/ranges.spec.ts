import { describe, expect, it } from 'vitest';
import { createRanges, recordAdmission, type AdmissionEvidence } from './ranges';

describe('recordAdmission', () => {
  const fresh = (): AdmissionEvidence => ({ ranges: new Map(), settled: new Map() });
  const at = (origin: string, version: number, p: number) => ({
    origin,
    version,
    hlc: { p, l: 0 },
  });

  it('opens an origin on its first admitted version and settles it as the run grows', () => {
    const evidence = fresh();
    recordAdmission(evidence, at('a', 7, 70));
    recordAdmission(evidence, at('a', 8, 80));
    expect(evidence.ranges.get('a')?.toJSON()).toEqual([[7, 8]]);
    expect(evidence.settled.get('a')).toEqual({ p: 80, l: 0 });
  });

  it('keeps the settled stamp where the first run ends when a later version leaves a hole', () => {
    const evidence = fresh();
    recordAdmission(evidence, at('a', 1, 10));
    recordAdmission(evidence, at('a', 3, 30));
    expect(evidence.ranges.get('a')?.toJSON()).toEqual([
      [1, 1],
      [3, 3],
    ]);
    expect(evidence.settled.get('a')).toEqual({ p: 10, l: 0 });
  });

  it('continues from restored evidence exactly as the room that never stopped would', () => {
    const live = fresh();
    for (let v = 2; v <= 6; v++) recordAdmission(live, at('a', v, v * 10));
    const restored: AdmissionEvidence = {
      ranges: new Map([['a', createRanges([[2, 4]])]]),
      settled: new Map([['a', { p: 40, l: 0 }]]),
    };
    recordAdmission(restored, at('a', 5, 50));
    recordAdmission(restored, at('a', 6, 60));
    expect(restored.ranges.get('a')?.toJSON()).toEqual(live.ranges.get('a')?.toJSON());
    expect(restored.settled).toEqual(live.settled);
  });
});

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

  it('restores from persisted ranges; the prefix is the end of the first run, wherever it starts', () => {
    const r = createRanges([[4, 6], [2, 2]]);
    expect(r.toJSON()).toEqual([[2, 2], [4, 6]]);
    // an origin that entered the generation at 2 settles from 2: nothing below an admitted
    // version is admitted later, so where the run starts takes nothing from what it proves
    expect(r.prefix()).toBe(2);
    expect(r.max()).toBe(6);
    r.add(3);
    expect(r.toJSON()).toEqual([[2, 6]]);
    expect(r.prefix()).toBe(6);
  });

  it('an origin whose first admitted version is above 1 has a prefix from its first version on', () => {
    const r = createRanges();
    r.add(58);
    expect(r.prefix()).toBe(58);
    r.add(59);
    expect(r.prefix()).toBe(59);
    r.add(61);
    expect(r.prefix()).toBe(59);
  });
});
