import { signal, type WritableSignal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { form, type FieldTree } from '@angular/forms/signals';
import {
  CHANGED,
  commitChanges,
  reconcile,
  resetChanged,
  trackChanges,
} from './changed';
import { changedPaths, changedValues } from './changed-values';
import { submitChanges } from './submit-changes';

function changedOf(tree: FieldTree<unknown>): boolean {
  return tree().metadata(CHANGED)?.changed() ?? false;
}

function tracked<T>(value: T) {
  return TestBed.runInInjectionContext(() => {
    const model: WritableSignal<T> = signal(value);
    const f = form(model, trackChanges(model));
    commitChanges(f as FieldTree<unknown>);
    return { model, f };
  });
}

function fakeMutation() {
  const calls: unknown[] = [];
  let deferred: PromiseWithResolvers<unknown> | null = null;
  return {
    calls,
    mutateAsync: (value: unknown) => {
      calls.push(value);
      deferred = Promise.withResolvers<unknown>();
      return deferred.promise;
    },
    resolve: (value: unknown) => deferred?.resolve(value),
  };
}

class Opaque {
  readonly #id: number;
  constructor(id: number) {
    this.#id = id;
  }
  get id() {
    return this.#id;
  }
}

describe('non-plain object values are leaves', () => {
  const cases: [string, () => object, () => object][] = [
    ['Date', () => new Date('2026-01-01'), () => new Date('2027-01-01')],
    ['Map', () => new Map([['a', 1]]), () => new Map([['a', 2]])],
    ['Set', () => new Set(['a']), () => new Set(['b'])],
    ['Blob', () => new Blob(['a']), () => new Blob(['bb'])],
    ['File', () => new File(['a'], 'a.txt'), () => new File(['a'], 'a.txt')],
    ['class instance', () => new Opaque(1), () => new Opaque(2)],
  ];

  it.each(cases)(
    '%s: a new value reads changed and is saved',
    async (_, a, b) => {
      const { f } = tracked<{ name: string; v: object }>({ name: 'n', v: a() });
      const next = b();
      f.v().value.set(next);

      expect(changedOf(f.v)).toBe(true);
      expect(changedOf(f)).toBe(true);
      expect(changedValues(f)).toEqual({ v: next });
      expect(changedPaths(f)()).toEqual(['v']);

      const mutation = fakeMutation();
      const result = submitChanges(f, mutation)();
      expect(mutation.calls).toEqual([{ v: next }]);
      mutation.resolve(undefined);
      await expect(result).resolves.toBe(true);
      expect(changedOf(f)).toBe(false);
    },
  );

  it.each(cases)('%s: keeping the same instance reads unchanged', (_, a) => {
    const { f } = tracked<{ name: string; v: object }>({ name: 'n', v: a() });
    f.name().value.set('m');
    expect(changedOf(f.v)).toBe(false);
    expect(changedValues(f)).toEqual({ name: 'm' });
  });
});

class Money {
  constructor(
    public cents: number,
    public currency: string,
  ) {}
}

describe('class instances with public fields are leaves', () => {
  type M = { name: string; price: Money };
  const setup = () => tracked<M>({ name: 'n', price: new Money(100, 'EUR') });

  it('replacing the instance reads changed and is sent whole', async () => {
    const { f } = setup();
    const next = new Money(200, 'EUR');
    f.price().value.set(next);

    expect(changedOf(f.price)).toBe(true);
    expect(changedValues(f)?.price).toBe(next);
    expect(changedPaths(f)()).toEqual(['price']);

    const mutation = fakeMutation();
    const result = submitChanges(f, mutation)();
    expect((mutation.calls[0] as Partial<M>).price).toBe(next);
    mutation.resolve(undefined);
    await expect(result).resolves.toBe(true);
    expect(changedOf(f)).toBe(false);
  });

  it('a value-equal new instance reads changed (identity compare)', () => {
    const { f } = setup();
    f.price().value.set(new Money(100, 'EUR'));
    expect(changedOf(f.price)).toBe(true);
    expect(changedPaths(f)()).toEqual(['price']);
  });

  it('keeping the same instance reads unchanged', () => {
    const { f } = setup();
    f.name().value.set('m');
    expect(changedOf(f.price)).toBe(false);
    expect(changedValues(f)).toEqual({ name: 'm' });
  });

  it('child field nodes carry no tracking; a child edit marks the instance changed', () => {
    const { f, model } = setup();
    expect(f.price.cents().metadata(CHANGED)).toBeUndefined();
    f.price.cents().value.set(300);
    expect(changedOf(f.price)).toBe(true);
    expect(changedPaths(f)()).toEqual(['price']);
    expect(changedValues(f)).toEqual({ price: model().price });
  });

  it('commitChanges, resetChanged and reconcile treat the instance as one unit', () => {
    const { f, model } = setup();
    const original = model().price;

    f.price().value.set(new Money(200, 'EUR'));
    resetChanged(f);
    expect(model().price).toBe(original);
    expect(changedOf(f)).toBe(false);

    const saved = new Money(300, 'EUR');
    f.price().value.set(saved);
    commitChanges(f as FieldTree<unknown>);
    expect(changedOf(f)).toBe(false);

    const server = new Money(400, 'USD');
    reconcile(f, { name: 'n', price: server });
    expect(model().price).toBe(server);
    expect(changedOf(f)).toBe(false);

    const mine = new Money(1, 'EUR');
    f.price().value.set(mine);
    reconcile(f, { name: 'n', price: new Money(500, 'USD') });
    expect(model().price).toBe(mine);
    expect(changedOf(f.price)).toBe(true);
  });
});

describe('reconcile adopts incoming values for keys with no field node', () => {
  type M = { name: string; nickname?: string | undefined };

  it('an undefined key adopts the server value and the form stays clean', () => {
    const { f, model } = tracked<M>({ name: 'a', nickname: undefined });
    reconcile(f, { name: 'a', nickname: 'Bob' });
    expect(model().nickname).toBe('Bob');
    expect(changedOf(f)).toBe(false);
    expect(changedValues(f)).toBeUndefined();
  });

  it('a key absent from the current value adopts the server value', () => {
    const { f, model } = tracked<M>({ name: 'a' });
    reconcile(f, { name: 'a', nickname: 'Bob' });
    expect(model()).toEqual({ name: 'a', nickname: 'Bob' });
    expect(changedOf(f)).toBe(false);
  });

  it('a key the user cleared keeps the clear and reads changed against the server', () => {
    const { f, model } = tracked<M>({ name: 'a', nickname: 'x' });
    f.nickname!().value.set(undefined as unknown as string);
    reconcile(f, { name: 'b', nickname: 'Bob' });
    expect(model()).toEqual({ name: 'b', nickname: undefined });
    expect(changedOf(f)).toBe(true);
    expect(changedValues(f)).toEqual({ nickname: undefined });
  });
});

describe('submitChanges re-baselining', () => {
  it('clearing an optional field then saving leaves the form clean', async () => {
    const { f } = tracked<{ name: string; nick?: string | undefined }>({
      name: 'ann',
      nick: 'x',
    });
    f.nick!().value.set(undefined as unknown as string);
    expect(changedValues(f)).toEqual({ nick: undefined });

    const mutation = fakeMutation();
    const save = submitChanges(f, mutation);
    const result = save();
    mutation.resolve(undefined);
    await expect(result).resolves.toBe(true);

    expect(changedOf(f)).toBe(false);
    expect(changedValues(f)).toBeUndefined();
    await expect(save()).resolves.toBe(true);
    expect(mutation.calls).toHaveLength(1);
  });

  it('ancestors adopt the saved values: reset after save keeps what was saved', async () => {
    const { f, model } = tracked({
      name: 'ann',
      age: 30,
      profile: { city: 'nyc' },
    });
    f.name().value.set('bob');
    f.profile.city().value.set('sf');

    const mutation = fakeMutation();
    const result = submitChanges(f, mutation)();
    mutation.resolve(undefined);
    await expect(result).resolves.toBe(true);

    f.age().value.set(99);
    resetChanged(f);
    expect(model()).toEqual({ name: 'bob', age: 30, profile: { city: 'sf' } });
    expect(changedOf(f)).toBe(false);
    expect(changedOf(f.name)).toBe(false);
    expect(changedOf(f.profile)).toBe(false);
  });

  it('record keys containing a dot are re-baselined after save', async () => {
    const { f } = tracked<{ dict: Record<string, boolean> }>({
      dict: { 'a.com': true, 'b.org': false },
    });
    f.dict['a.com']().value.set(false);
    expect(changedValues(f)).toEqual({ dict: { 'a.com': false } });

    const mutation = fakeMutation();
    const save = submitChanges(f, mutation);
    const result = save();
    mutation.resolve(undefined);
    await expect(result).resolves.toBe(true);

    expect(changedOf(f)).toBe(false);
    expect(changedOf(f.dict['a.com'])).toBe(false);
    await expect(save()).resolves.toBe(true);
    expect(mutation.calls).toHaveLength(1);
  });
});
