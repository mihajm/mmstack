import { TestBed } from '@angular/core/testing';
import { focusWithin } from './focus-within';

describe('focusWithin', () => {
  it('reflects focus inside the target subtree', async () => {
    const root = document.createElement('div');
    const child = document.createElement('button');
    root.appendChild(child);
    document.body.appendChild(root);

    try {
      await TestBed.runInInjectionContext(async () => {
        const sig = focusWithin(root);

        expect(sig()).toBe(false);

        root.dispatchEvent(new FocusEvent('focusin'));
        expect(sig()).toBe(true);

        child.focus();
        // focusout listener defers via microtask — wait one tick.
        root.dispatchEvent(new FocusEvent('focusout'));
        await Promise.resolve();
        expect(sig()).toBe(true); // child is still inside root

        child.blur();
        root.dispatchEvent(new FocusEvent('focusout'));
        await Promise.resolve();
        expect(sig()).toBe(false);
      });
    } finally {
      root.remove();
    }
  });
});
