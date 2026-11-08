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
  /** `code` and `reason` are the close frame's (1006 for a dropped connection, 1000 for a normal close). */
  onClose(cb: (code: number, reason: string) => void): () => void;
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
    const closeCbs = new Set<(code: number, reason: string) => void>();
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
          console.warn(
            '[@mmstack/mesh] dropped unparseable frame (expected JSON text)',
          );
        }
        return;
      }
      for (const cb of [...messageCbs]) cb(msg);
    };
    ws.onclose = (event) => {
      for (const cb of [...closeCbs]) cb(event.code, event.reason);
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

/** A message as it reads after a JSON hop: keys holding `undefined` gone, such array slots `null`. */
const asJson = <T>(msg: T): T => JSON.parse(JSON.stringify(msg)) as T;

export type DirectTransportOptions = {
  /**
   * Hand the relay's messages to this peer BY REFERENCE instead of through a JSON hop. A snapshot
   * welcome then costs the peer no copy of the room's registers: its stores hold the relay's own
   * sibling objects, the same ones every other such peer holds. The peer must therefore treat
   * everything it receives as the relay's memory and never mutate it — a write in place would
   * corrupt the room for everyone. The peer's own messages still cross as JSON, so what it writes
   * reaches the relay exactly as a socket peer's would. Off by default; opt in only for a process
   * whose readers are known not to mutate what a seat materializes.
   */
  readonly byReference?: boolean;
};

/**
 * Connects directly to an in-process `createRelay` — no network. The backbone of full-loop
 * tests, and handy for single-process demos or an SSR-side room.
 *
 * Messages cross as JSON in both directions, as they would over a socket, so a direct peer holds
 * exactly what a socket peer would. Handed over by reference, an `undefined` an emitter wrote
 * would reach relay memory where a socket peer's would have been dropped. The relay's own
 * messages may skip the hop ({@link DirectTransportOptions.byReference}): they never hold an
 * `undefined` (every value in a room arrived as JSON), so the two peers read the same state and
 * differ only in who owns the objects.
 */
export function directTransport(
  relay: Relay,
  ctx: PrincipalCtx,
  options: DirectTransportOptions = {},
): MeshTransportFactory {
  const inbound = options.byReference ? <T>(msg: T): T => msg : asJson;
  return () => {
    const messageCbs = new Set<(msg: ServerMsg) => void>();
    const closeCbs = new Set<(code: number, reason: string) => void>();
    let open = true;

    const connection = relay.connect(
      {
        send: (msg) => {
          if (!open) return;
          const wired = inbound(msg);
          for (const cb of [...messageCbs]) cb(wired);
        },
        close: () => {
          if (!open) return;
          open = false;
          connection.disconnect();
          for (const cb of [...closeCbs]) cb(1000, '');
        },
      },
      ctx,
    );

    return {
      send: (msg) => {
        if (open) connection.receive(asJson(msg));
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
        for (const cb of [...closeCbs]) cb(1000, '');
      },
    };
  };
}
