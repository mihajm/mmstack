import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { chunked } from './chunked';
import { providePausableOptions } from './concurrent';

describe('chunked', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('should chunk array over time using setTimeout', () => {
    TestBed.runInInjectionContext(() => {
      const source = signal(Array.from({ length: 15 }, (_, i) => i));
      const chunkedSig = chunked(source, { chunkSize: 5, delay: 10 });

      expect(chunkedSig()).toEqual([0, 1, 2, 3, 4]);

      TestBed.tick();
      vi.advanceTimersByTime(10);
      expect(chunkedSig()).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);

      TestBed.tick();
      vi.advanceTimersByTime(10);
      expect(chunkedSig()).toEqual([
        0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14,
      ]);
    });
  });

  it('should chunk array using microtask', async () => {
    await TestBed.runInInjectionContext(async () => {
      const source = signal([1, 2, 3]);
      const chunkedSig = chunked(source, { chunkSize: 1, delay: 'microtask' });

      expect(chunkedSig()).toEqual([1]);

      TestBed.tick();
      await Promise.resolve();

      expect(chunkedSig()).toEqual([1, 2]);

      TestBed.tick();
      await Promise.resolve();

      expect(chunkedSig()).toEqual([1, 2, 3]);
    });
  });

  it('should chunk array using requestAnimationFrame', () => {
    TestBed.runInInjectionContext(() => {
      const source = signal([1, 2, 3]);
      const chunkedSig = chunked(source, { chunkSize: 1, delay: 'frame' });

      expect(chunkedSig()).toEqual([1]);

      TestBed.tick();
      // vitest runs requestAnimationFrame exactly like a setTimeout(..., 16) frame jump when mock timers are on
      vi.advanceTimersByTime(16);

      expect(chunkedSig()).toEqual([1, 2]);

      TestBed.tick();
      vi.advanceTimersByTime(16);

      expect(chunkedSig()).toEqual([1, 2, 3]);
    });
  });

  it('pauses chunk scheduling while paused, resumes on unpause (opt-in)', () => {
    TestBed.runInInjectionContext(() => {
      const paused = signal(true);
      const source = signal(Array.from({ length: 15 }, (_, i) => i));
      const chunkedSig = chunked(source, {
        chunkSize: 5,
        delay: 10,
        pause: paused,
      });

      // the initial chunk comes from the linkedSignal, not the gated effect
      expect(chunkedSig()).toEqual([0, 1, 2, 3, 4]);

      // paused: the scheduling effect does not advance
      TestBed.tick();
      vi.advanceTimersByTime(100);
      expect(chunkedSig()).toEqual([0, 1, 2, 3, 4]);

      // resume: scheduling continues from the current chunk
      paused.set(false);
      TestBed.tick();
      vi.advanceTimersByTime(10);
      expect(chunkedSig()).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
    });
  });

  describe('providePausableOptions', () => {
    it('applies a global pause default to chunked (opt-in everywhere)', () => {
      const paused = signal(true);
      TestBed.configureTestingModule({
        providers: [providePausableOptions({ pause: paused })],
      });
      TestBed.runInInjectionContext(() => {
        const source = signal(Array.from({ length: 15 }, (_, i) => i));
        const chunkedSig = chunked(source, { chunkSize: 5, delay: 10 });

        expect(chunkedSig()).toEqual([0, 1, 2, 3, 4]);
        TestBed.tick();
        vi.advanceTimersByTime(100);
        expect(chunkedSig()).toEqual([0, 1, 2, 3, 4]); // paused via the provider default

        paused.set(false);
        TestBed.tick();
        vi.advanceTimersByTime(10);
        expect(chunkedSig()).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
      });
    });

    it('a call-site pause: false overrides the provider default', () => {
      TestBed.configureTestingModule({
        providers: [providePausableOptions({ pause: () => true })],
      });
      TestBed.runInInjectionContext(() => {
        const source = signal(Array.from({ length: 10 }, (_, i) => i));
        const chunkedSig = chunked(source, {
          chunkSize: 5,
          delay: 10,
          pause: false,
        });

        expect(chunkedSig()).toEqual([0, 1, 2, 3, 4]);
        TestBed.tick();
        vi.advanceTimersByTime(10);
        expect(chunkedSig()).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]); // not paused
      });
    });
  });
});
