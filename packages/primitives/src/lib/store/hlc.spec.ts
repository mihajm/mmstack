import { compareHlc, compareTotal, createHlcClock, type Hlc } from './hlc';

describe('hlc', () => {
  it('next() is strictly monotonic even when wall time stalls or rewinds', () => {
    let wall = 1_000;
    const clock = createHlcClock(() => wall);

    const stamps: Hlc[] = [clock.next()];
    wall = 1_000; // stalls
    stamps.push(clock.next());
    wall = 900; // rewinds
    stamps.push(clock.next());
    wall = 2_000;
    stamps.push(clock.next());

    for (let i = 1; i < stamps.length; i++) {
      expect(compareHlc(stamps[i - 1], stamps[i])).toBeLessThan(0);
    }
    expect(stamps[3]).toEqual({ p: 2_000, l: 0 }); // real advance resets the counter
  });

  it('observe() folds a remote stamp in so local stamps sort after it', () => {
    const clock = createHlcClock(() => 1_000);
    const remote: Hlc = { p: 5_000, l: 7 };

    clock.observe(remote);
    const next = clock.next();

    expect(compareHlc(remote, next)).toBeLessThan(0);
    expect(next.p).toBe(5_000); // wall is behind; physical holds at the observed max
  });

  it('compareTotal breaks exact stamp ties on writer, deterministically', () => {
    const stamp: Hlc = { p: 10, l: 2 };
    expect(compareTotal(stamp, 'a', stamp, 'b')).toBeLessThan(0);
    expect(compareTotal(stamp, 'b', stamp, 'a')).toBeGreaterThan(0);
    expect(compareTotal(stamp, 'a', stamp, 'a')).toBe(0);
    expect(compareTotal({ p: 10, l: 3 }, 'a', stamp, 'z')).toBeGreaterThan(0);
  });

  it('warns in dev mode when an observed remote clock leads by more than the skew bound', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const clock = createHlcClock(() => 1_000);
      clock.observe({ p: 1_000 + 4 * 60_000, l: 0 });
      expect(warn).not.toHaveBeenCalled();

      clock.observe({ p: 1_000 + 6 * 60_000, l: 0 });
      expect(warn).toHaveBeenCalledTimes(1);
    } finally {
      warn.mockRestore();
    }
  });

  it('compareHlc orders by physical time first, then the logical counter', () => {
    expect(compareHlc({ p: 1, l: 9 }, { p: 2, l: 0 })).toBeLessThan(0); // p dominates
    expect(compareHlc({ p: 5, l: 1 }, { p: 5, l: 2 })).toBeLessThan(0); // same p → l breaks it
    expect(compareHlc({ p: 5, l: 2 }, { p: 5, l: 1 })).toBeGreaterThan(0);
    expect(compareHlc({ p: 3, l: 3 }, { p: 3, l: 3 })).toBe(0);
  });

  it('observe at the same physical time advances the logical counter past the remote', () => {
    const clock = createHlcClock(() => 1_000);
    clock.observe({ p: 1_000, l: 5 }); // remote shares the wall clock, logical is ahead

    const next = clock.next();
    expect(next.p).toBe(1_000);
    expect(next.l).toBeGreaterThan(5); // stepped past the observed logical counter
    expect(compareHlc({ p: 1_000, l: 5 }, next)).toBeLessThan(0);
  });
});
