import { computed, signal } from '@angular/core';
import { toWritable } from './to-writable';

describe('to-writable', () => {
  it('should make a computed signal writable', () => {
    const orig = signal({ a: 1 });
    const comp = computed(() => orig().a);
    
    const writable = toWritable(comp, (val) => orig.update(prev => ({ ...prev, a: val })));
    
    expect(writable()).toBe(1);
    
    writable.set(5);
    expect(orig().a).toBe(5);
    expect(writable()).toBe(5);
    
    writable.update(v => v + 5);
    expect(orig().a).toBe(10);
    expect(writable()).toBe(10);
  });
});
