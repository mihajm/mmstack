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
});
