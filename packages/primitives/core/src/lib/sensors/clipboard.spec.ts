import { TestBed } from '@angular/core/testing';
import { clipboard } from './clipboard';

function stubClipboard(value: unknown) {
  const previous = Object.getOwnPropertyDescriptor(navigator, 'clipboard');
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value,
  });
  return () => {
    if (previous) Object.defineProperty(navigator, 'clipboard', previous);
    else delete (navigator as any).clipboard;
  };
}

describe('clipboard', () => {
  it('returns an empty signal when the Clipboard API is unavailable', () => {
    const restore = stubClipboard(undefined);

    try {
      TestBed.runInInjectionContext(() => {
        const cb = clipboard();
        expect(cb()).toBe('');
        expect(cb.isSupported()).toBe(false);
      });
    } finally {
      restore();
    }
  });

  it('copy() writes through and updates the signal', async () => {
    const written: string[] = [];
    const restore = stubClipboard({
      readText: () => Promise.resolve(''),
      writeText: (v: string) => {
        written.push(v);
        return Promise.resolve();
      },
    });

    try {
      await TestBed.runInInjectionContext(async () => {
        const cb = clipboard();
        expect(cb.isSupported()).toBe(true);

        await cb.copy('hello');

        expect(written).toEqual(['hello']);
        expect(cb()).toBe('hello');
      });
    } finally {
      restore();
    }
  });
});
