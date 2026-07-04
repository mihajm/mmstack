import type { WritableSignal } from '@angular/core';
import {
  createWorkerHost,
  type CreateWorkerHostOptions,
  type WorkerHost,
  type WorkerEnvelope,
  type WorkerPortLike,
} from '@mmstack/worker/host';
/** A port that can be made to `crash()` — fires its `onerror` and stops delivery (real-Worker sim). */
export type CrashablePort = WorkerPortLike & {
  onerror: (() => void) | null;
  crash(): void;
};

/** Wraps a live port so a test can simulate a worker crash (drives {@link connectWorker} restart). */
export function crashablePort(inner: WorkerPortLike): CrashablePort {
  let alive = true;
  const port: CrashablePort = {
    postMessage: (m, t) => {
      if (alive) inner.postMessage(m, t);
    },
    onmessage: null,
    onerror: null,
    terminate: () => inner.terminate?.(),
    crash: () => {
      alive = false;
      inner.onmessage = null;
      port.onerror?.();
    },
  };
  inner.onmessage = (ev) => {
    if (alive) port.onmessage?.(ev);
  };
  return port;
}

/**
 * Wraps a {@link WorkerPortLike} so INBOUND messages matching `drop` are silently discarded —
 * simulating a lost batch (at-most-once transport) to exercise version-gap recovery. `drop` may be
 * stateful (e.g. drop a specific version once).
 */
export function droppingPort(
  inner: WorkerPortLike,
  drop: (msg: WorkerEnvelope) => boolean,
): WorkerPortLike {
  let handler: ((ev: { data: any }) => void) | null = null;
  inner.onmessage = (ev) => {
    if (!drop(ev.data as WorkerEnvelope)) handler?.(ev);
  };
  return {
    postMessage: (m, t) => inner.postMessage(m, t),
    get onmessage() {
      return handler;
    },
    set onmessage(cb) {
      handler = cb;
    },
    terminate: () => inner.terminate?.(),
    close: () => inner.close?.(),
  };
}

/**
 * Deterministic in-process test harness for the worker protocol. The problem it solves: a real
 * cross-thread mirror has TWO async sources — port delivery and the host opLog's microtask
 * emission — so `setTimeout`-and-hope tests flake. Here, transport is a pair of CONTROLLABLE fake
 * ports whose messages queue until the harness delivers them, and {@link TestMesh.settle} drains
 * the microtask queue between deliveries and loops until the mesh is quiescent (throwing if it
 * never settles — which is itself how an echo/loop bug surfaces).
 *
 * Messages are `structuredClone`d on send by default, so the harness exercises the same wire
 * fidelity a real port would (absent-vs-undefined keys, non-cloneable payloads throw here too).
 */

type Delivery = { readonly to: FakePort; readonly data: unknown };

class Bus {
  readonly pending: Delivery[] = [];
  fault: ((d: Delivery) => Delivery[] | null) | null = null;

  enqueue(d: Delivery): void {
    const out = this.fault ? this.fault(d) : [d];
    if (out) this.pending.push(...out);
  }

  drain(): number {
    if (!this.pending.length) return 0;
    const batch = this.pending.splice(0, this.pending.length);
    for (const { to, data } of batch) to.onmessage?.({ data });
    return batch.length;
  }
}

/** Which side a message is being delivered TO (the destination of a hop). */
export type Side = 'host' | 'client';

class FakePort implements WorkerPortLike {
  onmessage: ((ev: { data: any }) => void) | null = null;
  peer!: FakePort;
  readonly sent: WorkerEnvelope[] = [];

  constructor(
    private readonly bus: Bus,
    private readonly clone: boolean,
    readonly role: Side,
  ) {}

  postMessage(message: unknown): void {
    this.sent.push(message as WorkerEnvelope);
    const data = this.clone ? structuredClone(message) : message;
    this.bus.enqueue({ to: this.peer, data });
  }

  terminate(): void {
    this.onmessage = null;
  }
  close(): void {
    this.onmessage = null;
  }
}

function portPair(bus: Bus, clone: boolean): { host: FakePort; client: FakePort } {
  const host = new FakePort(bus, clone, 'host');
  const client = new FakePort(bus, clone, 'client');
  host.peer = client;
  client.peer = host;
  return { host, client };
}

/** A simulated main-thread client wired to the host over a controllable port. */
export type TestClient = {
  readonly id: string;
  readonly port: WorkerPortLike;
  /** Every envelope the host has delivered to this client, in order. */
  readonly inbox: readonly WorkerEnvelope[];
  send(msg: WorkerEnvelope): void;
  ofType<K extends WorkerEnvelope['type']>(
    type: K,
  ): Extract<WorkerEnvelope, { type: K }>[];
  last<K extends WorkerEnvelope['type']>(
    type: K,
  ): Extract<WorkerEnvelope, { type: K }> | undefined;
  /** Convenience: perform the hello handshake. */
  hello(): void;
  /** Convenience: subscribe to a store. */
  subscribe(store: string): void;
  /** Total envelopes received — for echo/no-storm assertions. */
  readonly received: number;
};

export type FaultContext = { readonly to: Side; readonly data: WorkerEnvelope };
export type FaultOptions = {
  /** Drop a message before it is queued (delivered nowhere). */
  drop?: (d: FaultContext) => boolean;
  /** Duplicate a message so it is delivered twice (at-least-once transport simulation). */
  duplicate?: (d: FaultContext) => boolean;
};

export type TestMesh = {
  readonly host: WorkerHost;
  /** Wire a new client to the host; returns its handle. */
  addClient(id?: string): TestClient;
  /** Drain microtasks + deliver queued messages until the mesh is quiescent. */
  settle(): Promise<void>;
  /** Install a fault filter over the shared bus (chaos testing). Pass `null` to clear. */
  setFault(fault: FaultOptions | null): void;
  dispose(): void;
};

let clientSeq = 0;

/**
 * Build a host + controllable clients over an in-memory bus.
 *
 * ```ts
 * const mesh = createTestMesh({ stores: { app } });
 * const c = mesh.addClient();
 * c.subscribe('app');
 * await mesh.settle();
 * app.count.set(1);
 * await mesh.settle();
 * expect(c.ofType('store:ops')).toHaveLength(1);
 * ```
 */
export function createTestMesh(
  opts: {
    readonly stores?: Record<string, WritableSignal<any>>;
    readonly tasks?: CreateWorkerHostOptions['tasks'];
    /** structuredClone messages on send (default true — matches real wire fidelity). */
    readonly clone?: boolean;
  } = {},
): TestMesh {
  const bus = new Bus();
  const clone = opts.clone ?? true;
  const host = createWorkerHost({ stores: opts.stores, tasks: opts.tasks });
  const disconnects: Array<() => void> = [];

  const addClient = (id = `c${++clientSeq}`): TestClient => {
    const { host: hostSide, client: clientSide } = portPair(bus, clone);
    disconnects.push(host.connect(hostSide));
    const inbox: WorkerEnvelope[] = [];
    clientSide.onmessage = (ev) => inbox.push(ev.data as WorkerEnvelope);

    const client: TestClient = {
      id,
      port: clientSide,
      inbox,
      get received() {
        return inbox.length;
      },
      send: (msg) => clientSide.postMessage(msg),
      ofType: (type) =>
        inbox.filter(
          (m): m is Extract<WorkerEnvelope, { type: typeof type }> =>
            m.type === type,
        ),
      last: (type) => {
        for (let i = inbox.length - 1; i >= 0; i--)
          if (inbox[i].type === type) return inbox[i] as any;
        return undefined;
      },
      hello: () =>
        clientSide.postMessage({ type: 'hello', proto: 1, clientId: id }),
      subscribe: (store) =>
        clientSide.postMessage({ type: 'store:subscribe', store, clientId: id }),
    };
    return client;
  };

  const settle = async (maxRounds = 100): Promise<void> => {
    for (let round = 0; round < maxRounds; round++) {
      host.flush();
      await new Promise<void>((r) => setTimeout(r, 0));
      host.flush();
      if (bus.drain() === 0 && bus.pending.length === 0) return;
    }
    throw new Error(
      'createTestMesh.settle() did not converge in 100 rounds — likely an echo/message loop',
    );
  };

  const setFault = (fault: FaultOptions | null): void => {
    if (!fault) {
      bus.fault = null;
      return;
    }
    bus.fault = (d) => {
      const ctx: FaultContext = { to: d.to.role, data: d.data as WorkerEnvelope };
      if (fault.drop?.(ctx)) return null;
      if (fault.duplicate?.(ctx)) return [d, d];
      return [d];
    };
  };

  return {
    host,
    addClient,
    settle,
    setFault,
    dispose() {
      for (const d of disconnects) d();
      host.dispose();
    },
  };
}
