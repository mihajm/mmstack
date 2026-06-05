import { computed, signal } from '@angular/core';
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

    expect(create).toHaveBeenCalledTimes(2);

    sig();
    sig();
    sig();

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
    // double-buffer: a and c share an underlying instance
    expect(a).toBe(c);
  });

  it('does not reset on the first read (no buffer to release yet)', () => {
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

    sig();
    expect(reset).not.toHaveBeenCalled();

    src.set(1);
    sig();
    expect(reset).toHaveBeenCalledTimes(1);

    src.set(2);
    sig();
    expect(reset).toHaveBeenCalledTimes(2);
  });

  it('skips reset on the eager pre-allocated current for its first release', () => {
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

    // first read demotes the fresh pre-allocated current → no reset
    sig();
    expect(reset).not.toHaveBeenCalled();

    // from here, every read demotes a dirty buffer
    src.set(1);
    sig();
    expect(reset).toHaveBeenCalledTimes(1);

    src.set(2);
    sig();
    expect(reset).toHaveBeenCalledTimes(2);
  });

  it('threads reset swap-returns through the pool', () => {
    const src = signal(0);
    let resetN = 0;
    type Buf = { source: 'created' | 'reset'; n: number };

    const sig = pooled<Buf>({
      create: () => ({ source: 'created', n: 0 }),
      reset: () => ({ source: 'reset', n: ++resetN }),
      computation: (buf) => {
        void src();
        return buf;
      },
    });

    const a = sig();
    expect(a.source).toBe('created');

    src.set(1);
    const b = sig();
    expect(b.source).toBe('created');
    expect(b).not.toBe(a);

    src.set(2);
    const c = sig();
    // reset(a) returned a swap; it's now `other`, becomes `next`, then `current`
    expect(c.source).toBe('reset');
    expect(c.n).toBe(1);

    src.set(3);
    const d = sig();
    expect(d.source).toBe('reset');
    expect(d.n).toBe(2);
    expect(d).not.toBe(c);
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
    expect(sig()).toEqual([0]);

    src.set(2);
    expect(sig()).toEqual([0, 1]);
  });

  it('propagates updates through a downstream computed', () => {
    const src = signal(0);
    const pooledSig = pooled<number[]>({
      create: () => [],
      reset: (buf) => {
        buf.length = 0;
      },
      computation: (buf) => {
        for (let i = 0; i < src(); i++) buf.push(i);
        return buf;
      },
    });

    const sum = computed(() => pooledSig().reduce((acc, n) => acc + n, 0));
    const len = computed(() => pooledSig().length);

    src.set(3);
    expect(len()).toBe(3);
    expect(sum()).toBe(0 + 1 + 2);

    src.set(5);
    expect(len()).toBe(5);
    expect(sum()).toBe(0 + 1 + 2 + 3 + 4);

    src.set(1);
    expect(len()).toBe(1);
    expect(sum()).toBe(0);
  });
});
