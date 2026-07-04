import { TestBed } from '@angular/core/testing';
import { opSync } from './op-sync';
import { store } from './store';

// The load-bearing invariant behind composing persistence + mesh + worker as readers over ONE
// store's op stream: multiple opSync readers on the same store propagate a remote edit exactly
// once and tolerate the echo (an applied value that round-trips back unchanged), so they never
// storm. This is why the substrate composes without any bespoke bridge.

// A manual scheduler so flushes are deterministic (no Angular effect timing).
function manualDriver() {
  let run = (): void => undefined;
  return {
    driver: (r: () => void) => {
      run = r;
      return { destroy: () => undefined };
    },
    flush: (): void => run(),
  };
}

describe('op substrate: multiple readers on one store', () => {
  it('propagates a remote edit once, echo-free, and tolerates the round-trip', () => {
    const dA = manualDriver();
    const dB = manualDriver();
    const dPeer = manualDriver();

    const built = TestBed.runInInjectionContext(() => {
      const s = store<{ v: number }>({ v: 0 });
      const a = opSync(s, { origin: 'a', writer: 'w', driver: dA.driver });
      const b = opSync(s, { origin: 'b', writer: 'w', driver: dB.driver });
      // a separate peer store, only to mint real envelopes
      const peerStore = store<{ v: number }>({ v: 0 });
      const peer = opSync(peerStore, {
        origin: 'peer',
        writer: 'w',
        driver: dPeer.driver,
      });
      return { s, a, b, peer, peerStore };
    });
    const { s, a, b, peer, peerStore } = built;

    const aEmits: unknown[] = [];
    const bEmits: unknown[] = [];
    const peerEmits: Parameters<Parameters<typeof peer.subscribe>[0]>[0][] = [];
    a.subscribe((e) => aEmits.push(e));
    b.subscribe((e) => bEmits.push(e));
    peer.subscribe((e) => peerEmits.push(e));

    // a local edit on the shared store: both readers emit it exactly once
    (s as unknown as { v: { set(n: number): void } }).v.set(5);
    dA.flush();
    dB.flush();
    expect(aEmits.length).toBe(1);
    expect(bEmits.length).toBe(1);

    // mint a real remote envelope (peer sets v=9)
    (peerStore as unknown as { v: { set(n: number): void } }).v.set(9);
    dPeer.flush();
    expect(peerEmits.length).toBe(1);

    // the remote edit arrives at reader A only
    a.receive(peerEmits[0]);
    dA.flush();
    dB.flush();
    expect(s().v).toBe(9);
    expect(aEmits.length).toBe(1); // A applied it echo-free — did NOT re-emit
    expect(bEmits.length).toBe(2); // B observed the store change and propagated it onward, once

    // the echo: applying the value the store ALREADY holds yields no ops — no storm
    (s as unknown as { v: { set(n: number): void } }).v.set(9);
    dA.flush();
    dB.flush();
    expect(aEmits.length).toBe(1);
    expect(bEmits.length).toBe(2);
  });
});
