import { computed, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { mutable } from '../mutable';
import { mapObject } from './map-object';

describe('mapObject', () => {
  it('should map each key of an object to a new value', () => {
    TestBed.runInInjectionContext(() => {
      const source = signal({ a: 1, b: 2, c: 3 });
      const mapped = mapObject(source, (key, valueSig) => ({
        key,
        doubled: computed(() => valueSig() * 2),
      }));

      const result = mapped();
      expect(result.a.key).toBe('a');
      expect(result.a.doubled()).toBe(2);
      expect(result.b.doubled()).toBe(4);
      expect(result.c.doubled()).toBe(6);
    });
  });

  it('should reuse mapped values for unchanged keys', () => {
    TestBed.runInInjectionContext(() => {
      const source = signal({ x: 10, y: 20 });
      const mapFn = vi.fn((key, valueSig) => ({
        key,
        value: valueSig,
      }));
      const mapped = mapObject(source, mapFn);

      const first = mapped();
      expect(mapFn).toHaveBeenCalledTimes(2);

      source.set({ x: 100, y: 200 }); // Same keys, different values
      const second = mapped();

      // Same keys → reuse mapped results
      expect(mapFn).toHaveBeenCalledTimes(2);
      expect(second.x).toBe(first.x);
      expect(second.y).toBe(first.y);
    });
  });

  it('should call mapFn for new keys and onDestroy for removed keys', () => {
    TestBed.runInInjectionContext(() => {
      const destroySpy = vi.fn();
      const source = signal<Record<string, number>>({ a: 1, b: 2 });
      const mapFn = vi.fn((_key, valueSig) => valueSig);
      const mapped = mapObject(source, mapFn, { onDestroy: destroySpy });

      mapped();
      expect(mapFn).toHaveBeenCalledTimes(2);

      source.set({ b: 2, c: 3 }); // 'a' removed, 'c' added
      mapped();

      expect(mapFn).toHaveBeenCalledTimes(3); // 1 new call for 'c'
      expect(destroySpy).toHaveBeenCalledTimes(1); // 1 call for 'a'
    });
  });

  it('should allow writing back through writable source', () => {
    TestBed.runInInjectionContext(() => {
      const source = signal({ name: 'Alice', age: 30 });
      const mapped = mapObject(source, (key, valueSig) => valueSig);

      const result = mapped();
      result.name.set('Bob');

      expect(source().name).toBe('Bob');
      expect(source().age).toBe(30);
    });
  });

  it('should work with readonly source', () => {
    TestBed.runInInjectionContext(() => {
      const base = signal({ x: 5 });
      const readOnly = computed(() => base());
      const mapped = mapObject(readOnly, (key, valueSig) => ({
        label: computed(() => `${String(key)}=${valueSig()}`),
      }));

      expect(mapped().x.label()).toBe('x=5');
    });
  });

  it('follows key-set histories of three steps, including a same-size rename', () => {
    const source = signal<Record<string, number>>({ a: 1, b: 2 });
    const destroyed: string[] = [];
    const mapFn = vi.fn((key: string) => ({ key }));
    const mapped = mapObject(source, mapFn, {
      onDestroy: (v) => destroyed.push(v.key),
    });
    const keys = () => Object.keys(mapped()).sort();

    expect(keys()).toEqual(['a', 'b']);
    source.set({ a: 1 });
    expect(keys()).toEqual(['a']);
    source.set({ a: 1, c: 3 });
    expect(keys()).toEqual(['a', 'c']);
    expect(mapped()['c'].key).toBe('c');
    source.set({ d: 4, c: 3 });
    expect(keys()).toEqual(['c', 'd']);
    expect(mapFn.mock.calls.map((c) => c[0])).toEqual(['a', 'b', 'c', 'd']);
    expect(destroyed).toEqual(['b', 'a']);
  });

  it('a rename of the only key maps the new key and destroys the old entry', () => {
    const source = signal<Record<string, number>>({ a: 1 });
    const onDestroy = vi.fn();
    const mapped = mapObject(source, (key) => ({ key }), { onDestroy });
    const first = mapped()['a'];
    source.set({ b: 2 });
    expect(Object.keys(mapped())).toEqual(['b']);
    expect(mapped()['b']).toEqual({ key: 'b' });
    expect(onDestroy).toHaveBeenCalledTimes(1);
    expect(onDestroy).toHaveBeenCalledWith(first);
  });

  it('a mutable() source: an in-place edit of an object value reaches its key', () => {
    const state = mutable({ address: { city: 'a' }, n: 1 });
    let nRuns = 0;
    const view = mapObject(state, (key, prop) =>
      computed(() => {
        if (key === 'n') nRuns++;
        return JSON.stringify(prop());
      }),
    );
    expect(view().address()).toBe('{"city":"a"}');
    expect(view().n()).toBe('1');
    state.mutate((s) => {
      s.address.city = 'x';
      return s;
    });
    expect(view().address()).toBe('{"city":"x"}');
    view().n();
    expect(nRuns).toBe(1);
  });
});
