import { computed, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { projection, reconcile } from './projection';

describe('reconcile contract', () => {
  it('keeps every keyless item by position when nothing changed', () => {
    const prev = [{ label: 'a' }, { label: 'b' }, { label: 'c' }];
    const out = reconcile(prev, structuredClone(prev));
    expect(out).toBe(prev);
  });

  it('keeps unchanged keyless items when one of them changes', () => {
    const prev = [{ label: 'a' }, { label: 'b' }, { label: 'c' }];
    const next = structuredClone(prev);
    next[2].label = 'z';
    const out = reconcile(prev, next);
    expect(out[0]).toBe(prev[0]);
    expect(out[1]).toBe(prev[1]);
    expect(out[2]).toEqual({ label: 'z' });
  });

  it('matches duplicated keys in order', () => {
    const a = { id: 1, v: 'a' };
    const b = { id: 1, v: 'b' };
    const out = reconcile(
      [a, b],
      [
        { id: 1, v: 'a' },
        { id: 1, v: 'b' },
      ],
    );
    expect(out[0]).toBe(a);
    expect(out[1]).toBe(b);
  });

  it("keys by 'id' by default across a reorder", () => {
    const a = { id: 1, n: 1 };
    const b = { id: 2, n: 2 };
    const out = reconcile([a, b], structuredClone([b, a]));
    expect(out[0]).toBe(b);
    expect(out[1]).toBe(a);
  });

  it('uses a function key', () => {
    const a = { code: 'x', n: 1 };
    const b = { code: 'y', n: 2 };
    const out = reconcile([a, b], structuredClone([b, a]), (i) => i.code);
    expect(out[0]).toBe(b);
    expect(out[1]).toBe(a);
  });

  it('returns prev for a deep clone, nested arrays included', () => {
    const prev = { list: [{ id: 1, tags: ['a', 'b'] }], meta: { n: [1, 2] } };
    expect(reconcile(prev, structuredClone(prev))).toBe(prev);
  });

  it('shrinking to a prefix drops the removed items', () => {
    const prev = [{ id: 1 }, { id: 2 }, { id: 3 }];
    const out = reconcile(prev, structuredClone(prev.slice(0, 2)));
    expect(out).toHaveLength(2);
    expect(out[0]).toBe(prev[0]);
    expect(out[1]).toBe(prev[1]);
  });

  it('removing a key while the others stay returns the smaller record', () => {
    const prev = { a: 1, b: 2 } as { a: number; b?: number };
    const out = reconcile(prev, { a: 1 });
    expect(out).toEqual({ a: 1 });
    expect(Object.hasOwn(out, 'b')).toBe(false);
  });

  it.each([
    ['array to null', [1, 2], null],
    ['null to array', null, [1, 2]],
    ['array to record', [1, 2], { a: 1 }],
    ['record to array', { a: 1 }, [1, 2]],
    ['record to null', { a: 1 }, null],
    ['null to record', null, { a: 1 }],
  ])('a shape flip (%s) returns the new value', (_, prev, next) => {
    expect(reconcile(prev as unknown, next as unknown)).toEqual(next);
  });
});

describe('projection contract', () => {
  it("keeps item identity across a reorder with the default 'id' key", () => {
    TestBed.runInInjectionContext(() => {
      const rows = signal([
        { id: 1, name: 'a' },
        { id: 2, name: 'b' },
      ]);
      const p = projection(
        () => rows().map((r) => ({ ...r })),
        [] as {
          id: number;
          name: string;
        }[],
      );
      const first = p()[0];
      rows.set([...rows()].reverse());
      expect(p()[1]).toBe(first);
    });
  });

  it('keyless items keep identity, so a computed over one does not re-run', () => {
    TestBed.runInInjectionContext(() => {
      const rows = signal([
        { label: 'a', n: 0 },
        { label: 'b', n: 0 },
      ]);
      const p = projection(
        () => rows().map((r) => ({ label: r.label })),
        [] as { label: string }[],
      );
      let runs = 0;
      const first = computed(() => {
        runs++;
        return p()[0];
      });
      first();
      rows.set(rows().map((r) => ({ ...r, n: r.n + 1 })));
      first();
      expect(runs).toBe(1);
    });
  });
});
