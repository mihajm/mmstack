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
    const sigShift = withHistory(signal(0), {
      maxSize: 3,
      cleanupStrategy: 'shift',
    });

    sigShift.set(1);
    sigShift.set(2);
    sigShift.set(3);
    sigShift.set(4);

    expect(sigShift.history()).toEqual([1, 2, 3]); // Because history tracks previous values

    const sigHalve = withHistory(signal(0), {
      maxSize: 4,
      cleanupStrategy: 'halve',
    });

    sigHalve.set(1);
    sigHalve.set(2);
    sigHalve.set(3);
    sigHalve.set(4);
    sigHalve.set(5);

    expect(sigHalve.history()).toEqual([2, 3, 4]); // Because history tracks previous values
  });

  it('should bound the redo stack with the same maxSize/cleanupStrategy as undo', () => {
    // Use a tiny maxSize so we can overflow the redo stack by undoing.
    const sig = withHistory(signal(0), {
      maxSize: 2,
      cleanupStrategy: 'shift',
    });

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

  describe('maxSize bounds', () => {
    const fill = (maxSize: number, strategy?: 'shift' | 'halve') => {
      const sig = withHistory(signal(0), {
        maxSize,
        cleanupStrategy: strategy,
      });
      for (let i = 1; i <= 10; i++) sig.set(i);
      return sig;
    };

    it.each([
      [1, 'halve'],
      [1, 'shift'],
      [2, 'halve'],
      [3, 'shift'],
      [4, 'halve'],
      [5, 'halve'],
    ] as const)(
      'maxSize %i (%s) never keeps more than maxSize undo states',
      (maxSize, strategy) => {
        const sig = fill(maxSize, strategy);
        expect(sig.history().length).toBeLessThanOrEqual(maxSize);
        expect(sig.history().at(-1)).toBe(9);
        const oldest = sig.history()[0];
        while (sig.canUndo()) sig.undo();
        expect(sig()).toBe(oldest);
      },
    );

    it('maxSize 1 keeps exactly the last previous value', () => {
      const sig = fill(1);
      expect(sig.history()).toEqual([9]);
      sig.undo();
      expect(sig()).toBe(9);
      expect(sig.canUndo()).toBe(false);
    });

    it('maxSize 0 keeps no history at all', () => {
      for (const strategy of ['shift', 'halve'] as const) {
        const sig = fill(0, strategy);
        expect(sig()).toBe(10);
        expect(sig.history()).toEqual([]);
        expect(sig.canUndo()).toBe(false);
        sig.undo();
        expect(sig()).toBe(10);
      }
    });

    it('the redo stack is bounded by maxSize 1 too', () => {
      const sig = withHistory(signal(0), { maxSize: 1 });
      sig.set(1);
      sig.undo();
      expect(sig()).toBe(0);
      sig.redo();
      expect(sig()).toBe(1);
      expect(sig.history()).toEqual([0]);
      expect(sig.canRedo()).toBe(false);
    });

    it("'shift' drops one entry where 'halve' drops half", () => {
      const shift = withHistory(signal(0), {
        maxSize: 4,
        cleanupStrategy: 'shift',
      });
      const halve = withHistory(signal(0), { maxSize: 4 });
      for (let i = 1; i <= 5; i++) {
        shift.set(i);
        halve.set(i);
      }
      expect(shift.history()).toEqual([1, 2, 3, 4]);
      expect(halve.history()).toEqual([2, 3, 4]);
    });
  });

  describe('stack contract', () => {
    it('a fresh signal has nothing to redo and redo is a no-op', () => {
      const sig = withHistory(signal(1));
      expect(sig.canRedo()).toBe(false);
      sig.redo();
      expect(sig()).toBe(1);
      expect(sig.history()).toEqual([]);
      expect(sig.canUndo()).toBe(false);
    });

    it('update records history and undo restores', () => {
      const sig = withHistory(signal(1));
      sig.update((v) => v + 1);
      expect(sig()).toBe(2);
      expect(sig.history()).toEqual([1]);
      sig.undo();
      expect(sig()).toBe(1);
    });

    it('redo pushes onto undo history, so undo after redo goes back again', () => {
      const sig = withHistory(signal('a'));
      sig.set('b');
      sig.undo();
      sig.redo();
      expect(sig()).toBe('b');
      expect(sig.canUndo()).toBe(true);
      sig.undo();
      expect(sig()).toBe('a');
    });

    it('clear empties the redo stack too', () => {
      const sig = withHistory(signal(0));
      sig.set(1);
      sig.undo();
      expect(sig.canRedo()).toBe(true);
      sig.clear();
      expect(sig.canRedo()).toBe(false);
      sig.redo();
      expect(sig()).toBe(0);
    });

    it('canClear follows both stacks', () => {
      const sig = withHistory(signal(0));
      expect(sig.canClear()).toBe(false);
      sig.set(1);
      expect(sig.canClear()).toBe(true);
      sig.undo();
      expect(sig.canUndo()).toBe(false);
      expect(sig.canClear()).toBe(true);
      sig.clear();
      expect(sig.canClear()).toBe(false);
    });
  });
});
