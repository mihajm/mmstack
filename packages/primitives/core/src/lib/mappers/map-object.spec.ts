import { computed, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
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
});
