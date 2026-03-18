import { computed, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { pipeable, piped } from './pipeble';

describe('pipeable', () => {
  it('should add pipe and map methods to an existing signal', () => {
    TestBed.runInInjectionContext(() => {
      const source = signal(5);
      const ps = pipeable(source);

      expect(ps()).toBe(5);
      expect(typeof ps.pipe).toBe('function');
      expect(typeof ps.map).toBe('function');
    });
  });

  it('should preserve writable signal capabilities', () => {
    TestBed.runInInjectionContext(() => {
      const source = signal(1);
      const ps = pipeable(source);

      ps.set(10);
      expect(ps()).toBe(10);

      ps.update((v) => v + 5);
      expect(ps()).toBe(15);
    });
  });

  describe('map', () => {
    it('should return self when called with no arguments', () => {
      TestBed.runInInjectionContext(() => {
        const ps = piped(5);
        const result = ps.map();

        expect(result).toBe(ps);
      });
    });

    it('should transform with a single function', () => {
      TestBed.runInInjectionContext(() => {
        const ps = piped(3);
        const doubled = ps.map((n) => n * 2);

        expect(doubled()).toBe(6);
      });
    });

    it('should chain multiple transform functions', () => {
      TestBed.runInInjectionContext(() => {
        const ps = piped(2);
        const result = ps.map(
          (n) => n * 10,
          (n) => `#${n}`,
        );

        expect(result()).toBe('#20');
      });
    });

    it('should return a pipeable signal that can be further mapped', () => {
      TestBed.runInInjectionContext(() => {
        const ps = piped(1);
        const step1 = ps.map((n) => n + 1);
        const step2 = step1.map((n) => n * 3);

        expect(step1()).toBe(2);
        expect(step2()).toBe(6);
      });
    });

    it('should react to source changes', () => {
      TestBed.runInInjectionContext(() => {
        const ps = piped(1);
        const label = ps.map(
          (n) => n * 2,
          (n) => `val:${n}`,
        );

        expect(label()).toBe('val:2');

        ps.set(5);
        expect(label()).toBe('val:10');
      });
    });
  });
});

describe('piped', () => {
  it('should create a writable pipeable signal', () => {
    TestBed.runInInjectionContext(() => {
      const ps = piped(42);

      expect(ps()).toBe(42);
      expect(typeof ps.pipe).toBe('function');
      expect(typeof ps.map).toBe('function');

      ps.set(100);
      expect(ps()).toBe(100);
    });
  });

  it('should work with pipe returning self for no ops', () => {
    TestBed.runInInjectionContext(() => {
      const ps = piped(1);
      const result = ps.pipe();

      expect(result).toBe(ps);
    });
  });

  it('should work with a computed source via pipeable', () => {
    TestBed.runInInjectionContext(() => {
      const base = signal(10);
      const derived = computed(() => base() * 2);
      const ps = pipeable(derived);

      const label = ps.map((n) => `${n}px`);

      expect(label()).toBe('20px');

      base.set(50);
      expect(label()).toBe('100px');
    });
  });
});
