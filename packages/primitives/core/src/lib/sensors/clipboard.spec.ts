import {
  createEnvironmentInjector,
  EnvironmentInjector,
  PLATFORM_ID,
} from '@angular/core';
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

  const flush = async () => {
    for (let i = 0; i < 4; i++) await Promise.resolve();
  };

  it('unsupported copy() still returns a resolved promise', async () => {
    const restore = stubClipboard(undefined);
    try {
      const cb = TestBed.runInInjectionContext(() => clipboard());
      const result = cb.copy('x');
      expect(result).toBeInstanceOf(Promise);
      await expect(result).resolves.toBeUndefined();
    } finally {
      restore();
    }
  });

  it.each(['copy', 'cut'])(
    'starts empty and mirrors the clipboard on a document %s event',
    async (event) => {
      const restore = stubClipboard({
        readText: () => Promise.resolve('from-os'),
        writeText: () => Promise.resolve(),
      });
      try {
        const cb = TestBed.runInInjectionContext(() => clipboard());
        expect(cb()).toBe('');
        document.dispatchEvent(new Event(event));
        await flush();
        expect(cb()).toBe('from-os');
      } finally {
        restore();
      }
    },
  );

  it.each(['copy', 'cut'])('ignores %s events after destroy', async (event) => {
    const readText = vi.fn(() => Promise.resolve('from-os'));
    const restore = stubClipboard({
      readText,
      writeText: () => Promise.resolve(),
    });
    try {
      const child = createEnvironmentInjector(
        [],
        TestBed.inject(EnvironmentInjector),
      );
      const cb = clipboard({ injector: child });
      child.destroy();
      document.dispatchEvent(new Event(event));
      await flush();
      expect(readText).not.toHaveBeenCalled();
      expect(cb()).toBe('');
    } finally {
      restore();
    }
  });

  it('is empty and unsupported on the server, even with the API present', () => {
    const restore = stubClipboard({
      readText: () => Promise.resolve('from-os'),
      writeText: () => Promise.resolve(),
    });
    try {
      TestBed.configureTestingModule({
        providers: [{ provide: PLATFORM_ID, useValue: 'server' }],
      });
      const cb = TestBed.runInInjectionContext(() => clipboard());
      expect(cb()).toBe('');
      expect(cb.isSupported()).toBe(false);
    } finally {
      restore();
    }
  });
});
