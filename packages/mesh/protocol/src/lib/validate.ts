import type { Dot, OpEnvelope, SyncOp } from './wire';

const hasControlChar = (s: string): boolean => {
  for (let i = 0; i < s.length; i++) if (s.charCodeAt(i) < 0x20) return true;
  return false;
};
const isCleanId = (v: unknown): v is string =>
  typeof v === 'string' && v.length > 0 && !hasControlChar(v);
const isFiniteHlc = (h: unknown): boolean =>
  !!h &&
  typeof h === 'object' &&
  Number.isFinite((h as { p?: unknown }).p) &&
  Number.isFinite((h as { l?: unknown }).l);

/**
 * Deterministic, total well-formedness check for a received envelope: returns a short reason string
 * when it must be rejected WHOLE, or `null` when it is well-formed. It reads only the envelope, so
 * the relay and every client accept or reject a given envelope identically. This is the STRUCTURAL
 * TWIN of the client's `validateEnvelope` in @mmstack/primitives; the two must stay byte-identical
 * in their accept/reject decisions (a parity property in the mesh client spec pins this). It
 * validates SHAPE, not authority: authority and access control stay in the relay's policy check.
 */
export function validateEnvelope(env: OpEnvelope): string | null {
  if (!env || typeof env !== 'object') return 'envelope';
  if (!isCleanId(env.origin)) return 'origin';
  if (!isCleanId(env.writer)) return 'writer';
  if (!isFiniteHlc(env.hlc)) return 'hlc';
  if (!Number.isInteger(env.version) || env.version <= 0) return 'version';
  if (!Array.isArray(env.ops)) return 'ops';
  const seenPaths = new Set<string>();
  for (const op of env.ops) {
    if (!op || typeof op !== 'object') return 'op';
    if (op.kind !== 'set' && op.kind !== 'delete' && op.kind !== 'clear') return 'kind';
    if (!Array.isArray(op.path)) return 'path';
    for (const seg of op.path) {
      if (typeof seg === 'string' && hasControlChar(seg)) return 'path-control';
      if (seg === '__proto__') return 'path-proto';
    }
    if (op.path.length === 0 && op.kind !== 'set') return 'root-op';
    const epoch = (op as SyncOp).epoch;
    if (typeof epoch !== 'number' || !Number.isFinite(epoch) || epoch < 0) return 'epoch';
    const cites = (op as SyncOp).cites;
    if (!Array.isArray(cites)) return 'cites';
    for (const c of cites) {
      if (!c || typeof c !== 'object' || !isCleanId((c as Dot).origin) || !isFiniteHlc((c as Dot).hlc)) {
        return 'cites';
      }
    }
    const key = op.path.map(String).join(String.fromCharCode(0x1f));
    if (seenPaths.has(key)) return 'dup-path';
    seenPaths.add(key);
  }
  return null;
}
