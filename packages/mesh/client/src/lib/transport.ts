import { isDevMode } from '@angular/core';
import type {
  ClientMsg,
  PrincipalCtx,
  Relay,
  ServerMsg,
} from '@mmstack/mesh-protocol';

/**
 * One live connection to a relay. `meshSync` calls the factory per (re)connect; a transport
 * represents a single connection and never reconnects itself.
 */
export type MeshTransport = {
  send(msg: ClientMsg): void;
  onMessage(cb: (msg: ServerMsg) => void): () => void;
  onClose(cb: () => void): () => void;
  close(): void;
};

export type MeshTransportFactory = () => MeshTransport;

/**
 * JSON-over-WebSocket transport. Messages sent before the socket opens are buffered and
 * flushed on open; malformed inbound frames are dropped.
 */
export function webSocketTransport(
  url: string,
  protocols?: string | string[],
): MeshTransportFactory {
  return () => {
    const ws = new WebSocket(url, protocols);
    const messageCbs = new Set<(msg: ServerMsg) => void>();
    const closeCbs = new Set<() => void>();
    const pending: string[] = [];

    ws.onopen = () => {
      for (const frame of pending.splice(0)) ws.send(frame);
    };
    ws.onmessage = (event) => {
      let msg: ServerMsg;
      try {
        msg = JSON.parse(String(event.data)) as ServerMsg;
      } catch {
        if (isDevMode()) {
          console.warn('[@mmstack/mesh] dropped unparseable frame (expected JSON text)');
        }
        return;
      }
      for (const cb of [...messageCbs]) cb(msg);
    };
    ws.onclose = () => {
      for (const cb of [...closeCbs]) cb();
    };

    return {
      send: (msg) => {
        const frame = JSON.stringify(msg);
        if (ws.readyState === WebSocket.OPEN) ws.send(frame);
        else if (ws.readyState === WebSocket.CONNECTING) pending.push(frame);
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
  };
}

/**
 * Connects directly to an in-process `createRelay` — no network. The backbone of full-loop
 * tests, and handy for single-process demos or an SSR-side room.
 */
export function directTransport(
  relay: Relay,
  ctx: PrincipalCtx,
): MeshTransportFactory {
  return () => {
    const messageCbs = new Set<(msg: ServerMsg) => void>();
    const closeCbs = new Set<() => void>();
    let open = true;

    const connection = relay.connect(
      {
        send: (msg) => {
          if (!open) return;
          for (const cb of [...messageCbs]) cb(msg);
        },
        close: () => {
          if (!open) return;
          open = false;
          connection.disconnect();
          for (const cb of [...closeCbs]) cb();
        },
      },
      ctx,
    );

    return {
      send: (msg) => {
        if (open) connection.receive(msg);
      },
      onMessage: (cb) => {
        messageCbs.add(cb);
        return () => messageCbs.delete(cb);
      },
      onClose: (cb) => {
        closeCbs.add(cb);
        return () => closeCbs.delete(cb);
      },
      close: () => {
        if (!open) return;
        open = false;
        connection.disconnect();
        for (const cb of [...closeCbs]) cb();
      },
    };
  };
}
