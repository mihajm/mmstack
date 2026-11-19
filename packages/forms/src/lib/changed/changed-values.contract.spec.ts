import { signal, type WritableSignal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { form, type FieldTree } from '@angular/forms/signals';
import { commitChanges, trackChanges } from './changed';
import { changedCount, changedPaths, changedValues } from './changed-values';

function tracked<T>(value: T) {
  return TestBed.runInInjectionContext(() => {
    const model: WritableSignal<T> = signal(value);
    const f = form(model, trackChanges(model));
    commitChanges(f as FieldTree<unknown>);
    return { model, f };
  });
}

describe('changedValues: keys with no field node (undefined values)', () => {
  type M = {
    a: string;
    nick?: string | undefined;
    obj?: { x: number } | undefined;
  };

  it('a cleared optional string is emitted as its own unit', () => {
    const { f } = tracked<M>({ a: 'a', nick: 'x' });
    f.nick!().value.set(undefined as unknown as string);
    expect(changedValues(f)).toEqual({ nick: undefined });
    expect('nick' in (changedValues(f) as object)).toBe(true);
    expect(changedPaths(f)()).toEqual(['nick']);
  });

  it('a cleared optional object is emitted as its own unit', () => {
    const { f } = tracked<M>({ a: 'a', obj: { x: 1 } });
    f.obj!().value.set(undefined as unknown as { x: number });
    expect(changedValues(f)).toEqual({ obj: undefined });
    expect(changedPaths(f)()).toEqual(['obj']);
  });

  it('an unchanged undefined key is not emitted', () => {
    const { f } = tracked<M>({ a: 'a', nick: undefined });
    f.a().value.set('b');
    expect(changedValues(f)).toEqual({ a: 'b' });
    expect(changedPaths(f)()).toEqual(['a']);
  });

  it('a cleared key counts next to another edit', () => {
    const { f } = tracked<M>({ a: 'a', nick: 'x' });
    f.nick!().value.set(undefined as unknown as string);
    f.a().value.set('b');
    expect(changedValues(f)).toEqual({ a: 'b', nick: undefined });
    expect(changedCount(f)()).toBe(2);
  });

  it('setting an undefined key to a value is emitted', () => {
    const { model, f } = tracked<M>({ a: 'a', nick: undefined });
    model.update((m) => ({ ...m, nick: 'n' }));
    expect(changedValues(f)).toEqual({ nick: 'n' });
  });
});

describe('changedValues: untracked dict keys (added after init)', () => {
  function dict() {
    const r = tracked<{ dict: Record<string, number> }>({
      dict: { a: 1, b: 2 },
    });
    r.model.update((m) => ({ dict: { ...m.dict, c: 3 } }));
    commitChanges(r.f as FieldTree<unknown>);
    return r;
  }

  it('an edit to the untracked key is emitted', () => {
    const { f } = dict();
    f.dict['c']().value.set(4);
    expect(changedValues(f)).toEqual({ dict: { c: 4 } });
    expect(changedPaths(f)()).toEqual(['dict.c']);
  });

  it('an unchanged untracked key is not emitted next to an edit', () => {
    const { f } = dict();
    f.dict['a']().value.set(9);
    expect(changedValues(f)).toEqual({ dict: { a: 9 } });
  });

  it('reverting the untracked key reads unchanged', () => {
    const { f } = dict();
    f.dict['c']().value.set(4);
    f.dict['c']().value.set(3);
    expect(changedValues(f)).toBeUndefined();
  });
});

describe('changedValues: untracked array-valued dict keys', () => {
  function arrays() {
    const r = tracked<{ dict: Record<string, number[]> }>({ dict: { a: [0] } });
    r.model.update((m) => ({ dict: { ...m.dict, c: [1, 2] } }));
    commitChanges(r.f as FieldTree<unknown>);
    return r;
  }

  it('a content-equal copy is not emitted', () => {
    const { model, f } = arrays();
    model.set({ dict: { a: [5], c: [1, 2] } });
    expect(changedValues(f)).toEqual({ dict: { a: [5] } });
  });

  it.each([
    ['shrinks', [1]],
    ['grows', [1, 2, 3]],
    ['changes one item', [1, 9]],
    ['changes the first item', [9, 2]],
  ])('an array that %s is emitted', (_, next) => {
    const { model, f } = arrays();
    model.update((m) => ({ dict: { ...m.dict, c: next } }));
    expect(changedValues(f)).toEqual({ dict: { c: next } });
  });

  it('a key swap with an array value emits the new key', () => {
    const { model, f } = tracked<{ dict: Record<string, number[]> }>({
      dict: { a: [1] },
    });
    model.set({ dict: { b: [1] } });
    expect(changedValues(f)).toEqual({ dict: { b: [1] } });
  });
});

describe('changedValues: untracked arrays of records', () => {
  type Item = { x: number; y?: number };
  function items() {
    const r = tracked<{ dict: Record<string, Item[]> }>({ dict: { a: [] } });
    r.model.update((m) => ({
      dict: {
        ...m.dict,
        c: [
          { x: 1, y: 1 },
          { x: 2, y: 2 },
        ],
      },
    }));
    commitChanges(r.f as FieldTree<unknown>);
    return r;
  }

  it('a deep clone is not emitted', () => {
    const { model, f } = items();
    model.update((m) => structuredClone(m));
    expect(changedValues(f)).toBeUndefined();
  });

  it.each([
    ['loses a key', [{ x: 1, y: 1 }, { x: 2 }]],
    [
      'changes one property',
      [
        { x: 1, y: 1 },
        { x: 2, y: 9 },
      ],
    ],
    [
      'changes the first item',
      [
        { x: 9, y: 1 },
        { x: 2, y: 2 },
      ],
    ],
  ])('an item that %s is emitted', (_, next) => {
    const { model, f } = items();
    model.update((m) => ({ dict: { ...m.dict, c: next as Item[] } }));
    expect(changedValues(f)).toEqual({ dict: { c: next } });
  });
});

describe('changedValues: null transitions', () => {
  type Addr = { city: string } | null;

  it('object to null emits null', () => {
    const { f } = tracked<{ address: Addr }>({ address: { city: 'a' } });
    f.address().value.set(null);
    expect(changedValues(f)).toEqual({ address: null });
  });

  it('null to object emits the object', () => {
    const { f } = tracked<{ address: Addr }>({ address: null });
    f.address().value.set({ city: 'b' });
    expect(changedValues(f)).toEqual({ address: { city: 'b' } });
  });
});
