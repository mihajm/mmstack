import { describe, expect, it } from 'vitest';
import { createRegisterStore } from './register';
import {
  MESH_PROTO_VERSION,
  type Dot,
  type Hlc,
  type Key,
  type OpEnvelope,
  type SyncOp,
} from './wire';

const at = (p: number, l = 0): Hlc => ({ p, l });
const dot = (origin: string, p: number, l = 0): Dot => ({
  origin,
  hlc: at(p, l),
});
const env = (origin: string, hlc: Hlc, ops: SyncOp[]): OpEnvelope => ({
  proto: MESH_PROTO_VERSION,
  instance: 'g',
  origin,
  writer: origin,
  version: 1,
  hlc,
  policyVersion: 0,
  ops,
});
const set = (
  path: Key[],
  next: unknown,
  meta: { cites?: Dot[]; epoch?: number } = {},
): SyncOp => ({
  kind: 'set',
  path,
  next,
  cites: meta.cites ?? [],
  epoch: meta.epoch ?? 0,
});
const del = (path: Key[], meta: { cites?: Dot[] } = {}): SyncOp => ({
  kind: 'delete',
  path,
  prev: undefined,
  cites: meta.cites ?? [],
  epoch: 0,
});
const liveAt = (s: ReturnType<typeof createRegisterStore>, path: Key[]) =>
  s
    .siblings(path)
    .map((x) => `${x.origin}@${x.hlc.p}.${x.hlc.l}`)
    .sort();

describe('RegisterStore: stamps compare by physical time, then the logical counter', () => {
  it('a same-millisecond rewrite with a higher counter replaces the origin sibling', () => {
    const s = createRegisterStore();
    s.ingest(env('a', at(5, 0), [set(['x'], 1)]));
    s.ingest(env('a', at(5, 1), [set(['x'], 2)]));
    expect(s.siblings(['x']).map((x) => x.value)).toEqual([2]);
  });
  it('a cite of the exact stamp supersedes it; a lower counter does not', () => {
    const s = createRegisterStore();
    s.ingest(env('a', at(5, 1), [set(['x'], 1)]));
    s.ingest(env('b', at(6), [set(['x'], 2, { cites: [dot('a', 5, 1)] })]));
    expect(liveAt(s, ['x'])).toEqual(['b@6.0']);
    const t = createRegisterStore();
    t.ingest(env('a', at(5, 1), [set(['x'], 1)]));
    t.ingest(env('b', at(6), [set(['x'], 2, { cites: [dot('a', 5, 0)] })]));
    expect(liveAt(t, ['x'])).toEqual(['a@5.1', 'b@6.0']);
  });
});

describe('RegisterStore: retention per origin and supersession watermarks', () => {
  it('keeps the best op per origin: a later envelope with a lower stamp does not replace it', () => {
    const s = createRegisterStore();
    s.ingest(env('a', at(5), [set(['x'], 1)]));
    s.ingest(env('a', at(3), [set(['x'], 2)]));
    expect(s.siblings(['x']).map((x) => x.value)).toEqual([1]);
  });
  it('a write above its origin watermark is live again', () => {
    const s = createRegisterStore();
    s.ingest(env('a', at(1), [set(['x'], 1)]));
    s.ingest(env('b', at(2), [set(['x'], 2, { cites: [dot('a', 1)] })]));
    s.ingest(env('a', at(3), [set(['x'], 3)]));
    expect(liveAt(s, ['x'])).toEqual(['a@3.0', 'b@2.0']);
  });
  it('a write citing its own dot is not born dead', () => {
    const s = createRegisterStore();
    s.ingest(env('a', at(5), [set(['x'], 1, { cites: [dot('a', 5)] })]));
    expect(liveAt(s, ['x'])).toEqual(['a@5.0']);
  });
  it('a stale cite never lowers a watermark, and a later cite raises it', () => {
    const s = createRegisterStore();
    s.ingest(env('a', at(3), [set(['x'], 1)]));
    s.ingest(env('b', at(4), [set(['x'], 2, { cites: [dot('a', 3)] })]));
    s.ingest(env('c', at(5), [set(['x'], 3, { cites: [dot('a', 1)] })]));
    expect(liveAt(s, ['x'])).toEqual(['b@4.0', 'c@5.0']);
    const t = createRegisterStore();
    t.ingest(env('a', at(3), [set(['x'], 1)]));
    t.ingest(env('b', at(4), [set(['x'], 2, { cites: [dot('a', 1)] })]));
    expect(liveAt(t, ['x'])).toEqual(['a@3.0', 'b@4.0']);
    t.ingest(env('c', at(5), [set(['x'], 3, { cites: [dot('a', 3)] })]));
    expect(liveAt(t, ['x'])).toEqual(['b@4.0', 'c@5.0']);
  });
  it('covers a dot at or below the origin extent at the path, never a later one', () => {
    const s = createRegisterStore();
    s.ingest(env('a', at(5), [set(['x'], 1)]));
    s.ingest(env('b', at(6), [set(['x'], 2, { cites: [dot('a', 5)] })]));
    expect(s.covers(['x'], dot('a', 4))).toBe(true);
    expect(s.covers(['x'], dot('a', 5))).toBe(true);
    expect(s.covers(['x'], dot('a', 9))).toBe(false);
    expect(s.covers(['x'], dot('a', 5, 1))).toBe(false);
    expect(s.covers(['y'], dot('a', 1))).toBe(false);
  });
  it('a live delete under a null in an ancestor value ingests and is droppable', () => {
    const s = createRegisterStore();
    s.ingest(env('r', at(1), [set([], { a: null })]));
    expect(() => s.ingest(env('a', at(2), [del(['a', 'k'])]))).not.toThrow();
    expect(s.droppable(['a', 'k'])).toBe(true);
  });
});

describe('RegisterStore: the epoch baseline is never lowered', () => {
  it('a later carry at a lower epoch keeps the baseline', () => {
    const s = createRegisterStore();
    s.ingest(env('a', at(1), [set(['x'], 1, { epoch: 3 })]));
    s.ingest(env('a', at(2), [set(['x'], 2, { epoch: 0 })]));
    expect(s.maxEpoch(['x'])).toBe(3);
    s.ingest(env('a', at(3), [set(['x'], 3, { epoch: 1 })]));
    expect(s.maxEpoch(['x'])).toBe(3);
  });
  it('rises with each higher epoch and holds the highest', () => {
    const s = createRegisterStore();
    s.ingest(env('a', at(1), [set(['x'], 1, { epoch: 1 })]));
    s.ingest(env('a', at(2), [set(['x'], 2, { epoch: 3 })]));
    s.ingest(env('a', at(3), [set(['x'], 3, { epoch: 0 })]));
    expect(s.maxEpoch(['x'])).toBe(3);
  });
  it('a compaction seed carries the baseline of a register whose bumped sibling was replaced', () => {
    const s = createRegisterStore();
    s.ingest(env('a', at(1), [set(['x'], 1, { epoch: 3 })]));
    s.ingest(env('a', at(2), [set(['x'], 2, { epoch: 0 })]));
    const entry = s.compactionSeed().find((r) => r.path[0] === 'x');
    expect(entry?.epoch).toBe(3);
  });
  it('reset drops registers and baselines', () => {
    const s = createRegisterStore();
    s.ingest(env('a', at(1), [set(['x'], 1, { epoch: 3 })]));
    s.reset();
    expect(s.checkpoint()).toEqual([]);
    expect(s.maxEpoch(['x'])).toBe(0);
    expect(s.siblings(['x'])).toEqual([]);
  });
});

describe('RegisterStore: load into an empty store round-trips a checkpoint', () => {
  it('keeps watermarks: a superseded sibling stays dead after reload', () => {
    const s = createRegisterStore();
    s.ingest(env('a', at(5), [set(['x'], 1)]));
    s.ingest(env('b', at(6), [set(['x'], 2, { cites: [dot('a', 5)] })]));
    const t = createRegisterStore();
    t.load(s.checkpoint());
    expect(liveAt(t, ['x'])).toEqual(['b@6.0']);
    expect(t.checkpoint()).toEqual(s.checkpoint());
  });
  it('keeps an entry holding only watermarks', () => {
    const t = createRegisterStore();
    t.load([{ path: ['x'], siblings: [], water: { a: at(5) } }]);
    expect(t.covers(['x'], dot('a', 5))).toBe(true);
  });
  it('keeps a baseline that outlived its register', () => {
    const t = createRegisterStore();
    const entry = { path: ['x'], siblings: [], water: {}, epoch: 3 };
    t.load([entry]);
    expect(t.maxEpoch(['x'])).toBe(3);
    expect(t.checkpoint()).toEqual([entry]);
  });
  it('raises the baseline from a loaded sibling epoch when the entry has none', () => {
    const t = createRegisterStore();
    t.load([
      {
        path: ['x'],
        siblings: [
          {
            kind: 'set',
            writer: 'a',
            origin: 'a',
            hlc: at(1),
            epoch: 3,
            value: 1,
          },
        ],
        water: {},
      },
    ]);
    t.ingest(env('a', at(2), [set(['x'], 2, { epoch: 0 })]));
    expect(t.maxEpoch(['x'])).toBe(3);
  });
});

describe('RegisterStore: settle collects only what the settled vector covers', () => {
  it('keeps a watermark above the origin settled stamp, and one of an unsettled origin', () => {
    const s = createRegisterStore();
    s.ingest(env('a', at(5), [set(['x'], 1)]));
    s.ingest(env('b', at(6), [set(['x'], 2, { cites: [dot('a', 5)] })]));
    s.settle({ a: at(3) });
    expect(liveAt(s, ['x'])).toEqual(['b@6.0']);
    s.settle({ b: at(6) });
    expect(liveAt(s, ['x'])).toEqual(['b@6.0']);
    expect(s.covers(['x'], dot('a', 5))).toBe(true);
  });
});
