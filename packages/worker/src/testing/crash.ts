import type { WorkerRef } from '../lib/connect-worker';

/**
 * Drops a connection after its handshake the way a worker that fails to start is handled: pending
 * tasks reject, disconnect hooks run, and the worker respawns per `restart`. No port event leads
 * there once `ready` has arrived, so specs that need a lost connection call this.
 */
export function crashWorker(ref: WorkerRef<any>): void {
  (ref as unknown as { _crash(): void })._crash();
}
