import { deliverContained } from './contain';

describe('deliverContained', () => {
  it('a throwing observer does not throw at the call; the error is rethrown out of band', () => {
    const queued: (() => void)[] = [];
    const spy = vi
      .spyOn(globalThis, 'queueMicrotask')
      .mockImplementation((cb) => void queued.push(cb));
    const boom = new Error('boom');
    try {
      expect(() =>
        deliverContained(() => {
          throw boom;
        }, 1),
      ).not.toThrow();
    } finally {
      spy.mockRestore();
    }
    expect(queued).toHaveLength(1);
    expect(() => queued[0]()).toThrow(boom);
  });

  it('a quiet observer gets the event and queues nothing', () => {
    const spy = vi.spyOn(globalThis, 'queueMicrotask');
    const seen: number[] = [];
    try {
      deliverContained((e: number) => void seen.push(e), 7);
      expect(spy).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
    expect(seen).toEqual([7]);
  });
});
