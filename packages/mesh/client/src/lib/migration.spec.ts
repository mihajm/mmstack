import { TestBed } from '@angular/core/testing';
import {
  createRelay,
  MESH_PROTO_VERSION,
  type Relay,
} from '@mmstack/mesh-protocol';
import { store } from '@mmstack/primitives';
import { meshSync, type MeshSyncOptions } from './mesh-sync';
import { directTransport } from './transport';

type State = { title: string; v: number };
const initial = (): State => ({ title: 'init', v: 0 });

function peer(relay: Relay, writer: string, over?: Partial<MeshSyncOptions>) {
  return TestBed.runInInjectionContext(() => {
    const s = store<State>(initial());
    const mesh = meshSync(s, {
      room: 'm',
      writer,
      transport: directTransport(relay, { writer }),
      ...over,
    });
    return { s, mesh };
  });
}
const flush = () => TestBed.tick();

/**
 * A deploy-job migrator: connects, emits the migration envelope, done. The root replace is
 * epoch-BUMPED — the migrator is an authorized bumper, and an un-bumped migration root-set
 * would let concurrent old-schema edits outrank the migrated value.
 */
function migrate(relay: Relay, root: State, schemaVersion: number): void {
  const conn = relay.connect(
    { send: () => undefined, close: () => undefined },
    { writer: 'migrator' },
  );
  conn.receive({
    t: 'hello',
    room: 'm',
    origin: 'mig',
    proto: MESH_PROTO_VERSION,
    policyVersion: 0,
    schemaVersion,
  });
  conn.receive({
    t: 'env',
    room: 'm',
    env: {
      proto: MESH_PROTO_VERSION,
      origin: 'mig',
      writer: 'migrator',
      version: 1,
      hlc: { p: Date.now(), l: 0 },
      policyVersion: 0,
      ops: [{ kind: 'set', path: [], next: root, cites: [], epoch: 1 }],
      schemaVersion,
    },
  });
  conn.disconnect();
}

describe('schema migration  — client side', () => {
  it('a connected v0 client flips to "outdated" when a migration arrives', () => {
    const relay = createRelay();
    const v0 = peer(relay, 'a', { schemaVersion: 0 });
    expect(v0.mesh.status()).toBe('live');

    migrate(relay, { title: 'migrated', v: 2 }, 1);
    flush();

    expect(v0.mesh.health().status).toBe('outdated');
    expect(v0.mesh.health().reason).toBe('schema');
  });

  it('a v0 client reconnecting after a migration is rejected "schema" → outdated', () => {
    const relay = createRelay();
    peer(relay, 'seed', { schemaVersion: 0 }); // establish the room
    migrate(relay, { title: 'migrated', v: 2 }, 1);

    const stale = peer(relay, 'late', { schemaVersion: 0 }); // older build joins the migrated room
    expect(stale.mesh.status()).toBe('ejected');
    expect(stale.mesh.health().status).toBe('outdated');
    expect(stale.mesh.health().reason).toBe('schema');
  });

  it('a v1 client joins the migrated room and gets the new-shape state', () => {
    const relay = createRelay();
    peer(relay, 'seed', { schemaVersion: 0 });
    migrate(relay, { title: 'migrated', v: 2 }, 1);

    const fresh = peer(relay, 'new', { schemaVersion: 1 });
    expect(fresh.mesh.status()).toBe('live');
    expect(fresh.s()).toEqual({ title: 'migrated', v: 2 });
  });

  it('two v1 clients converge post-migration', () => {
    const relay = createRelay();
    peer(relay, 'seed', { schemaVersion: 0 });
    migrate(relay, { title: 'migrated', v: 2 }, 1);

    const a = peer(relay, 'a', { schemaVersion: 1 });
    const b = peer(relay, 'b', { schemaVersion: 1 });
    a.s.v.set(9);
    flush();
    expect(a.s()).toEqual(b.s());
    expect(b.s().v).toBe(9);
  });
});
