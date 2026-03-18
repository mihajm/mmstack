import { mutable, isMutable } from './mutable';
import { computed, signal } from '@angular/core';

describe('mutable', () => {
  it('should update and trigger when mutated', () => {
    const sig = mutable([1, 2]);
    let computedRuns = 0;
    const comp = computed(() => {
      computedRuns++;
      return sig().length;
    });

    // Read to initialize computed
    expect(comp()).toBe(2);
    expect(computedRuns).toBe(1);

    sig.mutate(v => {
      v.push(3);
      return v;
    });
    
    expect(sig()).toEqual([1, 2, 3]);
    expect(comp()).toBe(3);
    expect(computedRuns).toBe(2);
  });

  it('should support inline method', () => {
    const obj = mutable({ a: 1 });
    obj.inline(v => { v.a = 2; });
    expect(obj().a).toBe(2);
  });

  it('isMutable guard should work', () => {
    expect(isMutable(mutable(1))).toBe(true);
    expect(isMutable(signal(1))).toBe(false);
  });
});
