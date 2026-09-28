import { TestBed } from '@angular/core/testing';
import { createRelay } from '@mmstack/mesh-protocol';
import { describe, expect, it, vi, type Mock } from 'vitest';
import {
  peerLinks,
  type DataChannelLike,
  type PeerConnector,
  type PeerLinks,
} from './peer-links';
import { directTransport } from './transport';

/**
 * Real relay, queued outbound signaling, and observable connector lifetimes. The queue
 * preserves FIFO even across senders; no packet duplication, loss, or reordering is needed
 * for the takeover race. Membership is delivered immediately so a replacement can join
 * while signals are in flight. Payloads and protocol instance ids are opaque to the harness.
 *
 * Channels deliberately never open: these tests assert signaling convergence and routing,
 * not SDP/ICE or data-channel connectivity. Closing one connector does not synchronously
 * close the remote connector, as the existing synchronous pair hub does.
 */
function signalingHarness() {
  const relay = createRelay();
  const pending: (() => void)[] = [];
  const nodes: PeerLinks[] = [];
  type Connection = {
    sendSignal: (data: unknown) => void;
    receive: Mock<(data: unknown) => void>;
    closed: boolean;
  };

  const node = (origin: string) => {
    const connections: Connection[] = [];
    const connector: PeerConnector = (opt) => {
      const connection: Connection = {
        sendSignal: opt.sendSignal,
        receive: vi.fn(),
        closed: false,
      };
      connections.push(connection);
      const channel: DataChannelLike = {
        send: () => undefined,
        close: () => undefined,
        onOpen: () => () => undefined,
        onClose: () => () => undefined,
        onMessage: () => () => undefined,
      };
      return {
        channel,
        signal: connection.receive,
        close: () => {
          connection.closed = true;
        },
      };
    };
    const links = TestBed.runInInjectionContext(() =>
      peerLinks({
        room: 'signaling-races',
        origin,
        connector,
        signaling: () => {
          const transport = directTransport(relay, { writer: origin })();
          return {
            ...transport,
            send: (msg: Parameters<typeof transport.send>[0]) => {
              if (msg.t === 'signal') pending.push(() => transport.send(msg));
              else transport.send(msg);
            },
          };
        },
      }),
    );
    nodes.push(links);
    return {
      links,
      connections,
      current: () => {
        const live = connections.filter((c) => !c.closed);
        expect(live, 'one surviving connector per remote').toHaveLength(1);
        return live[0];
      },
    };
  };

  return {
    node,
    pending,
    settle: () => {
      // A generous safety bound makes an infinite replacement loop fail deterministically
      // without prescribing an exact number of messages for the repaired handshake.
      for (let n = 0; n < 100 && pending.length; n++) pending.shift()?.();
      expect(
        pending.length,
        'signaling must quiesce after a finite takeover',
      ).toBe(0);
    },
    close: () => {
      // Also cancel the old seat's scheduled relay reconnect after a takeover.
      for (const links of nodes) links.close();
      pending.length = 0;
    },
  };
}

describe('peerLinks signaling across takeover boundaries', () => {
  it('settles a queued takeover and routes subsequent signals both ways', () => {
    const h = signalingHarness();
    try {
      const a = h.node('a');
      const b1 = h.node('b');
      h.settle();
      const oldA = a.current();
      const b2 = h.node('b');
      b1.links.close();
      h.settle();
      expect(oldA.closed).toBe(true);
      const currentA = a.current();
      const currentB = b2.current();
      currentA.sendSignal({ probe: 'a-to-b2' });
      currentB.sendSignal({ probe: 'b2-to-a' });
      h.settle();
      expect(a.current()).toBe(currentA);
      expect(b2.current()).toBe(currentB);
      expect(currentB.receive).toHaveBeenCalledWith({ probe: 'a-to-b2' });
      expect(currentA.receive).toHaveBeenCalledWith({ probe: 'b2-to-a' });
    } finally {
      h.close();
    }
  });

  it.each(['a', 'z'])(
    'settles crossed old signaling when %s takes over the seat',
    (origin) => {
      const h = signalingHarness();
      try {
        const observer = h.node('m');
        const first = h.node(origin);
        h.settle();
        const oldObserver = observer.current();

        const replacement = h.node(origin);
        first.links.close();
        // The replacement has announced itself, but that signal has not reached the
        // observer yet. Its still-live old connector sends a final payload. FIFO delivery
        // lets this reach the replacement before the observer's NEW announcement.
        oldObserver.sendSignal({ probe: 'old-link-in-flight' });
        h.settle();

        expect(oldObserver.closed).toBe(true);
        const currentObserver = observer.current();
        const currentReplacement = replacement.current();
        currentObserver.sendSignal({ probe: 'current-observer' });
        currentReplacement.sendSignal({ probe: 'current-replacement' });
        h.settle();
        expect(observer.current()).toBe(currentObserver);
        expect(replacement.current()).toBe(currentReplacement);
        expect(currentReplacement.receive).toHaveBeenCalledWith({
          probe: 'current-observer',
        });
        expect(currentObserver.receive).toHaveBeenCalledWith({
          probe: 'current-replacement',
        });
      } finally {
        h.close();
      }
    },
  );

  it('adopts an addressed rebuild after a stale unaddressed announce bound the new seat', () => {
    const h = signalingHarness();
    try {
      const a = h.node('a');
      const b1 = h.node('b');
      // Queued: a's announcement to b, then b1's to a. Deliver only b1's: a is now bound to
      // b1's instance while a's own, unaddressed announcement is still in flight.
      expect(h.pending).toHaveLength(2);
      h.pending.splice(1, 1)[0]();
      const b2 = h.node('b');
      b1.links.close();
      // FIFO delivers a's stale unaddressed announcement to b2 first, which binds it. Then
      // b2's announcement makes a rebuild its end, addressed to b2. b2 must adopt that
      // rebuilt end: rebuilding in answer would make a rebuild again, forever.
      h.settle();
      const currentA = a.current();
      const currentB = b2.current();
      currentA.sendSignal({ probe: 'a-to-b2' });
      currentB.sendSignal({ probe: 'b2-to-a' });
      h.settle();
      expect(a.current()).toBe(currentA);
      expect(b2.current()).toBe(currentB);
      expect(currentB.receive).toHaveBeenCalledWith({ probe: 'a-to-b2' });
      expect(currentA.receive).toHaveBeenCalledWith({ probe: 'b2-to-a' });
    } finally {
      h.close();
    }
  });

  it('ignores a late sendSignal callback from a connector already replaced', () => {
    const h = signalingHarness();
    try {
      const a = h.node('a');
      const b1 = h.node('b');
      h.settle();
      const oldA = a.current();
      const b2 = h.node('b');
      b1.links.close();
      h.settle();
      expect(oldA.closed).toBe(true);
      const currentA = a.current();
      const currentB = b2.current();

      // An async connector operation can complete after close. It must no longer send
      // signaling through the live relay connection on behalf of the retired link.
      oldA.sendSignal({ probe: 'completed-after-close' });
      expect(
        h.pending,
        'retired connector must not emit signaling',
      ).toHaveLength(0);
      h.settle();
      expect(a.current()).toBe(currentA);
      expect(b2.current()).toBe(currentB);
      expect(currentB.receive).not.toHaveBeenCalledWith({
        probe: 'completed-after-close',
      });
    } finally {
      h.close();
    }
  });
});
