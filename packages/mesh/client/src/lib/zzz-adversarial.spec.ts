import { describe, it, expect } from 'vitest';
import { createRegisterStore, type OpEnvelope as WireEnvelope } from '@mmstack/mesh-protocol';
import {
  createConvergingApply,
  OP_PROTO_VERSION,
  type OpEnvelope,
  type RegisterCheckpoint,
  type SyncOp,
} from '@mmstack/primitives';

const hlc = (p: number, l = 0) => ({ p, l });
const env = (origin: string, version: number, h: any, ops: SyncOp[]): OpEnvelope => ({
  proto: OP_PROTO_VERSION,
  origin,
  writer: origin,
  version,
  hlc: h,
  policyVersion: 0,
  ops,
});
const setOp = (path: any[], next: unknown, cites: any[] = [], epoch = 0): SyncOp =>
  ({ kind: 'set', path, next, cites, epoch }) as any;
const delOp = (path: any[], cites: any[] = [], epoch = 0): SyncOp =>
  ({ kind: 'delete', path, prev: null, cites, epoch }) as any;

const canon = (regs: readonly RegisterCheckpoint[]) =>
  regs
    .filter((r) => r.siblings.length || Object.keys(r.water).length)
    .map((r) => ({
      path: r.path.map(String),
      siblings: [...r.siblings]
        .map((s) => ({ kind: s.kind, origin: s.origin, hlc: s.hlc, epoch: s.epoch }))
        .sort((a, b) => (a.origin < b.origin ? -1 : 1)),
      water: Object.fromEntries(Object.entries(r.water).sort()),
    }))
    .sort((a, b) => (a.path.join('/') < b.path.join('/') ? -1 : 1));

describe('ADVERSARIAL PARITY: tombstoneDroppable with ARRAY ancestor value', () => {
  it('an ancestor set value that is an ARRAY holding the tombstoned key: client vs relay compact must agree', () => {
    // Ancestor register at ['a'] holds an ARRAY value whose index "0" is the tombstoned descendant key.
    // Client isContainer excludes arrays -> holdsKey false -> tombstone droppable.
    // Relay  isContainer includes arrays -> contains true  -> tombstone NOT droppable.
    const envs: OpEnvelope[] = [
      // ancestor ['a'] = array ['keep'] ; index 0 present
      env('o1', 1, hlc(1), [setOp(['a'], ['keep'])]),
      // set ['a','0'] then delete it (cited) -> a lone tombstone at ['a','0']
      env('o2', 1, hlc(2), [setOp(['a', 0], 'x')]),
      env('o2', 2, hlc(3), [delOp(['a', 0], [{ origin: 'o2', hlc: hlc(2) }])]),
    ];
    const conv = createConvergingApply({});
    const twin = createRegisterStore();
    for (const e of envs) {
      conv.ingest(e);
      twin.ingest(e as unknown as WireEnvelope);
    }
    const frontier = hlc(10); // above all stamps -> everything eligible for compaction
    conv.prune(frontier);
    twin.compact(frontier);
    const c = canon(conv.checkpoint());
    const t = canon(twin.checkpoint() as unknown as RegisterCheckpoint[]);
    console.log('CLIENT after prune:', JSON.stringify(c));
    console.log('RELAY  after compact:', JSON.stringify(t));
    expect(t).toEqual(c);
  });

  it('nested array holding key deeper: parity', () => {
    const envs: OpEnvelope[] = [
      env('o1', 1, hlc(1), [setOp(['a'], { arr: ['keep'] })]),
      env('o2', 1, hlc(2), [setOp(['a', 'arr', 0], 'x')]),
      env('o2', 2, hlc(3), [delOp(['a', 'arr', 0], [{ origin: 'o2', hlc: hlc(2) }])]),
    ];
    const conv = createConvergingApply({});
    const twin = createRegisterStore();
    for (const e of envs) {
      conv.ingest(e);
      twin.ingest(e as unknown as WireEnvelope);
    }
    conv.prune(hlc(10));
    twin.compact(hlc(10));
    expect(canon(twin.checkpoint() as unknown as RegisterCheckpoint[])).toEqual(
      canon(conv.checkpoint()),
    );
  });
});
