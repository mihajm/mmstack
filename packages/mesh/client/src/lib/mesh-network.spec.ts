import { TestBed } from '@angular/core/testing';
import { createRelay, type ClientMsg, type ServerMsg } from '@mmstack/mesh-protocol';
import { store } from '@mmstack/primitives';
import { WebSocket as NodeWebSocket, WebSocketServer, type WebSocket as WsSocket } from 'ws';
import { meshSync, type MeshSyncRef } from './mesh-sync';
import type { MeshTransport, MeshTransportFactory } from './transport';

type State = { title: string; nested: { a: number; b: number } };
const initial = (): State => ({ title: 'init', nested: { a: 0, b: 0 } });

function nodeWsTransport(url: () => string): MeshTransportFactory {
  return () => {
    const ws = new NodeWebSocket(url());
    const messageCbs = new Set<(msg: ServerMsg) => void>();
    const closeCbs = new Set<() => void>();
    const pending: string[] = [];

    ws.on('open', () => {
      for (const frame of pending.splice(0)) ws.send(frame);
    });
    ws.on('message', (data) => {
      const msg = JSON.parse(String(data)) as ServerMsg;
      for (const cb of [...messageCbs]) cb(msg);
    });
    ws.on('close', () => {
      for (const cb of [...closeCbs]) cb();
    });
    ws.on('error', () => undefined);

    const transport: MeshTransport = {
      send: (msg: ClientMsg) => {
        const frame = JSON.stringify(msg);
        if (ws.readyState === NodeWebSocket.OPEN) ws.send(frame);
        else if (ws.readyState === NodeWebSocket.CONNECTING) pending.push(frame);
      },
      onMessage: (cb) => {
        messageCbs.add(cb);
        return () => messageCbs.delete(cb);
      },
      onClose: (cb) => {
        closeCbs.add(cb);
        return () => closeCbs.delete(cb);
      },
      close: () => ws.close(),
    };
    return transport;
  };
}

const until = async (predicate: () => boolean, ms = 3000): Promise<void> => {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > ms) throw new Error('condition not met in time');
    TestBed.tick();
    await new Promise((r) => setTimeout(r, 10));
  }
};

describe('meshSync over a real WebSocket server', () => {
  let server: WebSocketServer;
  let url = '';
  const sockets = new Map<string, WsSocket>();

  beforeAll(async () => {
    const relay = createRelay();
    server = new WebSocketServer({ port: 0 });
    server.on('connection', (ws, req) => {
      const writer = new URL(req.url ?? '/', 'http://x').searchParams.get('writer') ?? 'anon';
      sockets.set(writer, ws);
      const conn = relay.connect(
        { send: (m) => ws.send(JSON.stringify(m)), close: () => ws.close() },
        { writer },
      );
      ws.on('message', (data) => conn.receive(JSON.parse(String(data)) as ClientMsg));
      ws.on('close', () => conn.disconnect());
    });
    await new Promise<void>((r) => server.on('listening', () => r()));
    const address = server.address();
    url = `ws://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;
  });

  afterAll(async () => {
    await new Promise<void>((r) => server.close(() => r()));
  });

  function peer(writer: string) {
    return TestBed.runInInjectionContext(() => {
      const s = store<State>(initial());
      const mesh: MeshSyncRef = meshSync(s, {
        room: 'net',
        writer,
        transport: nodeWsTransport(() => `${url}/?writer=${writer}`),
      });
      return { s, mesh };
    });
  }

  it('replicates, snapshots a late joiner, merges concurrent leaves, and survives a dropped socket', async () => {
    const a = peer('wa');
    await until(() => a.mesh.status() === 'live');

    a.s.title.set('hello-network');
    TestBed.tick();

    const b = peer('wb');
    await until(() => b.mesh.status() === 'live');
    await until(() => b.s().title === 'hello-network');

    a.s.nested.a.set(1);
    b.s.nested.b.set(2);
    TestBed.tick();
    await until(() => a.s().nested.a === 1 && a.s().nested.b === 2);
    await until(() => b.s().nested.a === 1 && b.s().nested.b === 2);
    expect(a.s()).toEqual(b.s());

    sockets.get('wa')!.terminate();
    await until(() => a.mesh.status() === 'reconnecting');
    a.s.title.set('offline-edit');
    TestBed.tick();
    b.s.nested.b.set(22);
    TestBed.tick();
    await until(() => a.mesh.status() === 'live', 5000);
    await until(() => a.s().nested.b === 22 && b.s().title === 'offline-edit', 5000);
    expect(a.s()).toEqual(b.s());

    a.mesh.setPresence({ section: 'net-test' });
    await until(() => b.mesh.peers().some((p) => p.writer === 'wa'));

    a.mesh.close();
    b.mesh.close();
  }, 20_000);
});
