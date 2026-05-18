import { signal } from '@angular/core';
import { pooled } from './pooled';

describe('pooled', () => {
  it('allocates at most two buffers across many reads (lazy)', () => {
    const src = signal(0);
    const create = vi.fn(() => ({ value: 0 }));

    const sig = pooled<{ value: number }>({
      create,
      reset: (buf) => {
        buf.value = 0;
      },
      computation: (buf) => {
        buf.value = src();
        return buf;
      },
    });

    for (let i = 0; i < 10; i++) {
      src.set(i);
      sig();
    }

    expect(create).toHaveBeenCalledTimes(2);
  });

  it('pre-allocates both buffers at construction with eager: true', () => {
    const create = vi.fn(() => ({}));

    const sig = pooled({
      create,
      reset: () => {
        /* noop */
      },
      computation: (buf) => buf,
      eager: true,
    });

    // both buffers exist before any read
    expect(create).toHaveBeenCalledTimes(2);

    sig();
    sig();
    sig();

    // no additional allocation after reads
    expect(create).toHaveBeenCalledTimes(2);
  });

  it('returns different identities on consecutive reads', () => {
    const src = signal(0);
    const sig = pooled<{ value: number }>({
      create: () => ({ value: 0 }),
      reset: (buf) => {
        buf.value = 0;
      },
      computation: (buf) => {
        buf.value = src();
        return buf;
      },
    });

    src.set(1);
    const a = sig();
    src.set(2);
    const b = sig();
    src.set(3);
    const c = sig();

    expect(a).not.toBe(b);
    expect(b).not.toBe(c);
    // double-buffer: a and c share an underlying instance
    expect(a).toBe(c);
  });

  it('skips reset on freshly-created buffers, runs it on reused ones (lazy)', () => {
    const src = signal(0);
    const reset = vi.fn((buf: { value: number }) => {
      buf.value = -1;
    });

    const sig = pooled<{ value: number }>({
      create: () => ({ value: 999 }),
      reset,
      computation: (buf) => {
        buf.value = src();
        return buf;
      },
    });

    // reads 1 and 2 use freshly-created buffers → reset is skipped
    sig();
    src.set(1);
    sig();
    expect(reset).not.toHaveBeenCalled();

    // read 3 reuses the buffer from read 1 → reset runs
    src.set(2);
    sig();
    expect(reset).toHaveBeenCalledTimes(1);

    src.set(3);
    sig();
    expect(reset).toHaveBeenCalledTimes(2);
  });

  it('skips reset on the eager-allocated buffers for the first two reads', () => {
    const src = signal(0);
    const reset = vi.fn();

    const sig = pooled<{ value: number }>({
      create: () => ({ value: 0 }),
      reset,
      computation: (buf) => {
        buf.value = src();
        return buf;
      },
      eager: true,
    });

    sig();
    src.set(1);
    sig();
    expect(reset).not.toHaveBeenCalled();

    src.set(2);
    sig();
    expect(reset).toHaveBeenCalledTimes(1);
  });

  it('uses the reset return value when one is provided', () => {
    const src = signal(0);
    const swapped = { tag: 'swapped' as const };

    const sig = pooled<{ tag: string }>({
      create: () => ({ tag: 'created' }),
      reset: () => swapped,
      computation: (buf) => {
        void src();
        return buf;
      },
    });

    // first two reads are fresh — get the `create()` instance, not the swap
    expect(sig().tag).toBe('created');
    src.set(1);
    expect(sig().tag).toBe('created');

    // third read reuses a buffer, so reset runs and the swap is used
    src.set(2);
    expect(sig()).toBe(swapped);
    src.set(3);
    expect(sig()).toBe(swapped);
  });

  it('honors equal from CreateSignalOptions', () => {
    const src = signal(0);
    const sig = pooled<{ value: number }>({
      create: () => ({ value: 0 }),
      reset: (buf) => {
        buf.value = 0;
      },
      computation: (buf) => {
        buf.value = src();
        return buf;
      },
      equal: () => true,
    });

    const first = sig();
    src.set(1);
    const second = sig();
    src.set(2);
    const third = sig();

    // equal: () => true → the signal never emits a new identity
    expect(second).toBe(first);
    expect(third).toBe(first);
  });

  it('clears buffer state between reads (no leftover writes)', () => {
    const src = signal(0);
    const sig = pooled<number[]>({
      create: () => [],
      reset: (buf) => {
        buf.length = 0;
      },
      computation: (buf) => {
        for (let i = 0; i < src(); i++) buf.push(i);
        return buf;
      },
    });

    src.set(3);
    expect(sig()).toEqual([0, 1, 2]);

    src.set(1);
    // if reset didn't run, the buffer would still contain the prior writes
    expect(sig()).toEqual([0]);

    src.set(2);
    expect(sig()).toEqual([0, 1]);
  });
});
