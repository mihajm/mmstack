/* eslint-disable @typescript-eslint/no-non-null-assertion */
import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import {
  createRelay,
  type Relay,
  type OpEnvelope as WireEnvelope,
} from '@mmstack/mesh-protocol';
import {
  isConflicted,
  preserve,
  store,
  type Conflicted,
  type OpEnvelope,
} from '@mmstack/primitives';
import { meshSync, type MeshSyncOptions } from './mesh-sync';
import { directTransport } from './transport';

type State = { title: string; nested: { a: number; b: number } };
const initial = (): State => ({ title: 'init', nested: { a: 0, b: 0 } });

const _toWire = (e: OpEnvelope): WireEnvelope => e;
const _fromWire = (e: WireEnvelope): OpEnvelope => e;
void _toWire;
void _fromWire;

describe('meshSync (full loop over an in-process relay)', () => {
  function peer(relay: Relay, writer: string, over?: Partial<MeshSyncOptions>) {
    return TestBed.runInInjectionContext(() => {
      const s = store<State>(initial());
      const mesh = meshSync(s, {
        room: 'case-1',
        writer,
        transport: directTransport(relay, { writer }),
        ...over,
      });
      return { s, mesh };
    });
  }

  const flush = () => TestBed.tick();

  it('seeds a fresh room, snapshots a late joiner, and replicates live writes both ways', () => {
    const relay = createRelay();
    const a = peer(relay, 'wa');
    expect(a.mesh.status()).toBe('live');

    a.s.title.set('from-a');
    flush();

    const b = peer(relay, 'wb');
    expect(b.mesh.status()).toBe('live');
    expect(b.s()).toEqual({ title: 'from-a', nested: { a: 0, b: 0 } });

    b.s.nested.b.set(2);
    a.s.nested.a.set(1);
    flush();

    expect(a.s()).toEqual({ title: 'from-a', nested: { a: 1, b: 2 } });
    expect(b.s()).toEqual(a.s());
  });

  it('folds deletes into the room root: a late joiner never resurrects removed keys', () => {
    const relay = createRelay();
    const a = TestBed.runInInjectionContext(() => {
      const s = signal<Record<string, unknown>>({ keep: 1, drop: 2 });
      const mesh = meshSync(s, {
        room: 'case-1',
        writer: 'wa',
        transport: directTransport(relay, { writer: 'wa' }),
      });
      return { s, mesh };
    });
    a.s.update((v) => {
      const next = { ...v };
      delete next['drop'];
      return next;
    });
    flush();

    const b = peer(relay, 'wb');
    expect(b.s() as object).toEqual({ keep: 1 });
  });

  it('reconnects via delta and rebases offline local writes onto the room', () => {
    vi.useFakeTimers();
    try {
      const relay = createRelay();
      const inner = directTransport(relay, { writer: 'wa' });
      let current: ReturnType<typeof inner> | null = null;
      const a = TestBed.runInInjectionContext(() => {
        const s = store<State>(initial());
        const mesh = meshSync(s, {
          room: 'case-1',
          writer: 'wa',
          transport: () => (current = inner()),
        });
        return { s, mesh };
      });
      const b = peer(relay, 'wb');
      flush();
      expect(a.mesh.status()).toBe('live');

      current!.close();
      expect(a.mesh.status()).toBe('reconnecting');

      a.s.nested.a.set(7);
      flush();
      b.s.title.set('while-a-was-away');
      flush();
      expect(a.s().title).toBe('init');

      vi.advanceTimersByTime(700);

      expect(a.mesh.status()).toBe('live');
      expect(a.s()).toEqual({
        title: 'while-a-was-away',
        nested: { a: 7, b: 0 },
      });
      expect(b.s()).toEqual(a.s());
    } finally {
      vi.useRealTimers();
    }
  });

  it('ejects a policy-violating writer without disturbing the healthy peer', () => {
    const ejections: string[] = [];
    const relay = createRelay({
      policy: { canWrite: (_ctx, path) => path[0] !== 'title' },
    });
    const a = peer(relay, 'wa', { onEject: (r) => ejections.push(r) });
    const b = peer(relay, 'wb');
    flush();

    a.s.title.set('forbidden');
    flush();

    expect(a.mesh.status()).toBe('ejected');
    expect(ejections).toEqual(['can-write']);
    expect(b.mesh.status()).toBe('live');

    b.s.nested.a.set(5);
    flush();
    expect(b.s().nested.a).toBe(5);
  });

  it('emit-side policy honesty: a locally-invalid write never reaches the wire', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const relay = createRelay({
        policy: { canWrite: (_ctx, path) => path[0] !== 'title' },
      });
      const a = peer(relay, 'wa', {
        policy: { canWrite: (_ctx, path) => path[0] !== 'title' },
      });
      const b = peer(relay, 'wb');
      flush();

      a.s.title.set('forbidden');
      flush();

      expect(a.mesh.status()).toBe('live');
      expect(b.s().title).toBe('init');
      expect(warn).toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  it('carries presence: roster on join, live updates, gone on close', () => {
    const relay = createRelay();
    const a = peer(relay, 'wa');
    a.mesh.setPresence({ section: 'pricing' });

    const b = peer(relay, 'wb');
    expect(b.mesh.peers().map((p) => p.writer)).toEqual(['wa']);

    b.mesh.setPresence({ section: 'notes' });
    expect(a.mesh.peers().map((p) => p.writer)).toEqual(['wb']);

    a.mesh.close();
    expect(b.mesh.peers()).toEqual([]);
  });

  it('holds writes made while connecting and flushes them on welcome (async transport)', () => {
    const relay = createRelay();
    const inner = directTransport(relay, { writer: 'wa' });
    const queue: (() => void)[] = [];
    const drain = () => {
      while (queue.length) queue.shift()!();
    };
    const a = TestBed.runInInjectionContext(() => {
      const s = store<State>(initial());
      const mesh = meshSync(s, {
        room: 'case-1',
        writer: 'wa',
        transport: () => {
          const t = inner();
          return {
            ...t,
            send: (m) => queue.push(() => t.send(m)),
            onMessage: (cb) => t.onMessage((m) => queue.push(() => cb(m))),
          };
        },
      });
      return { s, mesh };
    });

    expect(a.mesh.status()).toBe('connecting');
    a.s.title.set('written-before-welcome');
    flush();
    expect(relay.room('case-1')).toBeUndefined();

    drain();
    drain();
    drain();
    drain();

    expect(a.mesh.status()).toBe('live');
    expect(relay.room('case-1')!.seq).toBeGreaterThanOrEqual(2);
    expect(a.s().title).toBe('written-before-welcome');
  });

  it('snapshot reconnect does NOT resurrect acked-and-superseded local writes', () => {
    vi.useFakeTimers();
    try {
      const relay = createRelay({ journalLimit: 2 });
      const inner = directTransport(relay, { writer: 'wa' });
      let current: ReturnType<typeof inner> | null = null;
      const a = TestBed.runInInjectionContext(() => {
        const s = store<State>(initial());
        const mesh = meshSync(s, {
          room: 'case-1',
          writer: 'wa',
          transport: () => (current = inner()),
        });
        return { s, mesh };
      });
      const b = peer(relay, 'wb');
      flush();

      a.s.title.set('mine');
      flush();
      b.s.title.set('theirs');
      flush();
      expect(a.s().title).toBe('theirs');

      current!.close();
      b.s.nested.a.set(1);
      flush();
      b.s.nested.b.set(2);
      flush();
      b.s.nested.a.set(3);
      flush();

      vi.advanceTimersByTime(700);

      expect(a.mesh.status()).toBe('live');
      expect(a.s().title).toBe('theirs');
      expect(a.s()).toEqual(b.s());
    } finally {
      vi.useRealTimers();
    }
  });

  it('re-seeds when the relay room was recreated (epoch change)', () => {
    vi.useFakeTimers();
    try {
      const relayA = createRelay();
      let relay = relayA;
      const inner = () => directTransport(relay, { writer: 'wa' })();
      let current: ReturnType<typeof inner> | null = null;
      const a = TestBed.runInInjectionContext(() => {
        const s = store<State>(initial());
        const mesh = meshSync(s, {
          room: 'case-1',
          writer: 'wa',
          transport: () => (current = inner()),
        });
        return { s, mesh };
      });
      a.s.title.set('survives-restart');
      flush();
      expect(relayA.room('case-1')!.seq).toBeGreaterThanOrEqual(2);

      relay = createRelay();
      current!.close();
      vi.advanceTimersByTime(700);

      expect(a.mesh.status()).toBe('live');
      expect(relay.room('case-1')!.seq).toBeGreaterThanOrEqual(1);
      const c = peer(relay, 'wc');
      expect(c.s().title).toBe('survives-restart');
    } finally {
      vi.useRealTimers();
    }
  });

  it('after ejection, local writes keep working locally and never resume the connection', () => {
    const relay = createRelay({
      policy: { canWrite: (_ctx, path) => path[0] !== 'title' },
    });
    const a = peer(relay, 'wa');
    flush();
    a.s.title.set('forbidden');
    flush();
    expect(a.mesh.status()).toBe('ejected');
    expect(a.mesh.peers()).toEqual([]);

    a.s.nested.a.set(42);
    flush();
    expect(a.s().nested.a).toBe(42);
    expect(a.mesh.status()).toBe('ejected');
  });

  it('applies per-path preserve across the mesh', () => {
    const relay = createRelay();
    const policies = [{ path: 'title', merge: preserve }];
    const a = peer(relay, 'wa', { policies });
    flush();
    const b = peer(relay, 'wb', { policies });
    flush();

    a.s.title.set('A');
    b.s.title.set('B');
    flush();

    expect(a.s().title).toEqual(b.s().title);
    if (isConflicted(a.s().title)) {
      expect((a.s().title as unknown as Conflicted<string>).mine).toBeDefined();
    }
  });
});
