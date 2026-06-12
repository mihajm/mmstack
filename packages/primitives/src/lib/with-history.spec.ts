import { signal } from '@angular/core';
import { withHistory } from './with-history';

describe('with-history', () => {
  it('should track history and allow undo/redo', () => {
    const name = withHistory(signal('John'), { maxSize: 5 });
    
    expect(name()).toBe('John');
    
    name.set('John Doe');
    name.set('Jane Doe');
    
    expect(name()).toBe('Jane Doe');
    expect(name.canUndo()).toBe(true);
    expect(name.canRedo()).toBe(false);
    expect(name.history()).toEqual(['John', 'John Doe']);
    
    name.undo();
    expect(name()).toBe('John Doe');
    expect(name.canRedo()).toBe(true);
    
    name.redo();
    expect(name()).toBe('Jane Doe');
    expect(name.canRedo()).toBe(false);
    
    name.set('Bob');
    expect(name.canRedo()).toBe(false); // New change clears redo stack
    expect(name()).toBe('Bob');
    
    name.clear();
    expect(name.canUndo()).toBe(false);
    expect(name.history()).toEqual([]);
  });

  it('should apply cleanup strategies correctly', () => {
    const sigShift = withHistory(signal(0), { maxSize: 3, cleanupStrategy: 'shift' });
    
    sigShift.set(1);
    sigShift.set(2);
    sigShift.set(3);
    sigShift.set(4);
    
    expect(sigShift.history()).toEqual([1, 2, 3]); // Because history tracks previous values

    const sigHalve = withHistory(signal(0), { maxSize: 4, cleanupStrategy: 'halve' });

    sigHalve.set(1);
    sigHalve.set(2);
    sigHalve.set(3);
    sigHalve.set(4);
    sigHalve.set(5);
    
    expect(sigHalve.history()).toEqual([2, 3, 4]); // Because history tracks previous values
  });

  it('should bound the redo stack with the same maxSize/cleanupStrategy as undo', () => {
    // Use a tiny maxSize so we can overflow the redo stack by undoing.
    const sig = withHistory(signal(0), { maxSize: 2, cleanupStrategy: 'shift' });

    sig.set(1);
    sig.set(2);
    sig.set(3);
    // Undo stack bounded to 2 → [1, 2], current value 3.
    expect(sig.history()).toEqual([1, 2]);

    sig.undo(); // current 2, redo [3]
    sig.undo(); // current 1, redo [3, 2] — at capacity
    // Third undo will push the current (1) onto the redo stack — the shift
    // strategy must drop the oldest entry (3) so redo stays bounded to 2.
    sig.undo(); // history empty → no-op

    expect(sig()).toBe(1);
    expect(sig.canUndo()).toBe(false);

    // The redo stack must respect the same maxSize bound.
    sig.redo(); // current 2
    sig.redo(); // current 3
    expect(sig()).toBe(3);
  });

  it('uses a user-provided equal function to gate history entries', () => {
    const sig = withHistory(signal({ id: 1, label: 'a' }), {
      equal: (a, b) => a.id === b.id,
    });

    // same id — considered equal, no history entry, no write
    sig.set({ id: 1, label: 'b' });
    expect(sig().label).toBe('a');
    expect(sig.canUndo()).toBe(false);

    // different id — recorded
    sig.set({ id: 2, label: 'c' });
    expect(sig().id).toBe(2);
    expect(sig.history()).toEqual([{ id: 1, label: 'a' }]);
  });

  it('accepts the raw-value overload together with equal', () => {
    // regression: this used to call getSignalEquality on the raw value and throw
    const sig = withHistory(5, { equal: (a, b) => a === b });
    sig.set(6);
    expect(sig()).toBe(6);
    expect(sig.history()).toEqual([5]);
  });

  it('undo/redo restore legitimately undefined entries', () => {
    const sig = withHistory(signal<string | undefined>(undefined));

    sig.set('a');
    expect(sig.canUndo()).toBe(true);

    sig.undo(); // restores undefined — must pop, not stall
    expect(sig()).toBeUndefined();
    expect(sig.canUndo()).toBe(false);
    expect(sig.canRedo()).toBe(true);

    sig.redo();
    expect(sig()).toBe('a');
  });
});
