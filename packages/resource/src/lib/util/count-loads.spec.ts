import { signal } from '@angular/core';
import { countLoads } from './count-loads';

describe('countLoads', () => {
  const make = (reloadAccepts = true) => {
    const req = signal<unknown>(undefined);
    const inner = { reload: () => reloadAccepts };
    return { req, ...countLoads(req, inner) };
  };

  it('starts at zero without a request and moves on every defined request', () => {
    const { req, loads } = make();
    expect(loads()).toBe(0);
    req.set({ id: 1 });
    expect(loads()).toBe(1);
    req.set({ id: 1 }); // a new reference is a new load, as for Angular's resource
    expect(loads()).toBe(2);
    req.set(undefined);
    expect(loads()).toBe(2);
  });

  it('moves on an accepted reload only', () => {
    const accepted = make(true);
    accepted.req.set('a');
    expect(accepted.loads()).toBe(1);
    expect(accepted.resource.reload()).toBe(true);
    expect(accepted.loads()).toBe(2);

    const refused = make(false);
    refused.req.set('a');
    refused.resource.reload();
    expect(refused.loads()).toBe(1);
  });

  it('is current on read: an abort+restart in one tick is visible without an effect', () => {
    const { req, loads } = make();
    req.set('a');
    const before = loads();
    req.set('b');
    req.set('c'); // two changes between reads count at least once
    expect(loads()).toBeGreaterThan(before);
  });

  it('the same reference does not move it', () => {
    const { req, loads } = make();
    const r = { id: 1 };
    req.set(r);
    expect(loads()).toBe(1);
    req.set(r);
    expect(loads()).toBe(1);
  });
});

describe('countLoads installed on the resource itself', () => {
  it('does not recurse when the wrapped reload replaces the original', () => {
    const req = signal<unknown>('a');
    let inner = 0;
    const res = {
      reload: () => {
        inner++;
        return true;
      },
    };
    const counted = countLoads(req, res);
    Object.assign(res, { reload: counted.resource.reload });
    expect(counted.loads()).toBe(1);
    expect(res.reload()).toBe(true);
    expect([inner, counted.loads()]).toEqual([1, 2]);
  });
});
