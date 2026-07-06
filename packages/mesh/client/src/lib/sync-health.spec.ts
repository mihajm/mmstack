import { TestBed } from '@angular/core/testing';
import { createRelay, type OpPolicy, type Relay } from '@mmstack/mesh-protocol';
import { store } from '@mmstack/primitives';
import { meshSync, type MeshSyncOptions } from './mesh-sync';
import { directTransport } from './transport';

type State = { title: string; n: number };
const initial = (): State => ({ title: '', n: 0 });

function peer(relay: Relay, writer: string, over?: Partial<MeshSyncOptions>) {
  return TestBed.runInInjectionContext(() => {
    const s = store<State>(initial());
    const mesh = meshSync(s, {
      room: 'h',
      writer,
      transport: directTransport(relay, { writer }),
      ...over,
    });
    return { s, mesh };
  });
}
const flush = () => TestBed.tick();

const noNegatives: OpPolicy = {
  validate: (op) =>
    !(op.kind === 'set' && typeof op.next === 'number' && op.next < 0),
};

describe('meshSync — sync health', () => {
  it('reports "live" with a lastSyncedAt once connected', () => {
    const a = peer(createRelay(), 'a');
    expect(a.mesh.status()).toBe('live');
    const h = a.mesh.health();
    expect(h.status).toBe('live');
    expect(h.lastSyncedAt).toBeGreaterThan(0);
  });

  it('maps a version reject to "outdated" (an update prompt, not a dead socket)', () => {
    const relay = createRelay({ policyVersion: 5 });
    const stale = peer(relay, 'stale', { policyVersion: 1 }); // older build
    expect(stale.mesh.status()).toBe('ejected');
    expect(stale.mesh.health().status).toBe('outdated');
    expect(stale.mesh.health().reason).toBe('policy-version');
  });

  it('maps a proto reject to "outdated"', () => {
    // a hand-crafted transport that answers hello with a proto reject
    const factory = () => {
      let onMsg: ((m: unknown) => void) | null = null;
      return {
        send: (m: { t: string; room: string }) => {
          if (m.t === 'hello')
            onMsg?.({
              t: 'reject',
              room: m.room,
              reason: 'proto',
              expected: 2,
            });
        },
        onMessage: (cb: (m: unknown) => void) => (
          (onMsg = cb),
          () => (onMsg = null)
        ),
        onClose: () => () => undefined,
        close: () => undefined,
      };
    };
    const p = TestBed.runInInjectionContext(() => {
      const s = store<State>(initial());
      return meshSync(s, {
        room: 'h',
        writer: 'p',
        transport: factory as unknown as MeshSyncOptions['transport'],
      });
    });
    expect(p.health().status).toBe('outdated');
    expect(p.health().reason).toBe('proto');
  });

  it('maps a tripwire eject to "ejected" (distinct from outdated)', () => {
    const relay = createRelay({ policy: noNegatives });
    const rogue = peer(relay, 'rogue'); // no emit policy → it can send the violation
    expect(rogue.mesh.status()).toBe('live');

    rogue.s.n.set(-1);
    flush();

    expect(rogue.mesh.status()).toBe('ejected');
    expect(rogue.mesh.health().status).toBe('ejected');
    expect(rogue.mesh.health().reason).toBeDefined();
  });
});
