import { applyOps, invertBatch, type StoreOp } from './op-log';
import { rebaseOps, type MergeFn } from './op-sync';

describe('rebaseOps — presence, deletes and the merge guard', () => {
  it('a pending write over a key the remote deleted re-bases as an add, so undoing it removes the key', () => {
    const res = rebaseOps(
      { k: 'mine', j: 1 },
      [[{ kind: 'set', path: ['k'], next: 'mine', prev: 'orig' }]],
      [{ kind: 'delete', path: ['k'], prev: 'orig' }],
    );
    expect(Object.hasOwn(res.pending[0][0], 'prev')).toBe(false);
    expect(applyOps(res.root, invertBatch(res.pending[0]))).toStrictEqual({
      j: 1,
    });
  });

  it.each([
    ['null', null],
    ['a string', 'str'],
    ['undefined (present)', undefined],
  ])(
    'a pending write under a parent the remote replaced by %s re-bases as an add, without throwing',
    (_d, parent) => {
      const res = rebaseOps(
        { a: { b: 'mine' } },
        [[{ kind: 'set', path: ['a', 'b'], next: 'mine', prev: 'orig' }]],
        [{ kind: 'set', path: ['a'], next: parent, prev: { b: 'orig' } }],
      );
      expect(res.pending[0][0]).toStrictEqual({
        kind: 'set',
        path: ['a', 'b'],
        next: 'mine',
      });
    },
  );

  it('a pending delete stays a delete and leaves the key absent, not present-undefined', () => {
    const res = rebaseOps(
      { j: 2 } as Record<string, unknown>,
      [[{ kind: 'delete', path: ['k'], prev: 'v' }]],
      [{ kind: 'set', path: ['j'], next: 2, prev: 1 }],
    );
    expect(res.pending[0][0].kind).toBe('delete');
    expect(res.root).toStrictEqual({ j: 2 });
    expect('k' in res.root).toBe(false);
  });

  describe('a custom merge is asked only when both sides changed the path', () => {
    const calls: Array<readonly (string | number)[]> = [];
    const combine: MergeFn = (_a, m, t, ctx) => {
      calls.push(ctx.path);
      return `${String(m)}+${String(t)}`;
    };
    const policies = [{ path: 'v', merge: combine }];
    beforeEach(() => (calls.length = 0));

    it('a pending add over a remote add lands whole', () => {
      const res = rebaseOps(
        { v: 'mine' },
        [[{ kind: 'set', path: ['v'], next: 'mine' } as StoreOp]],
        [{ kind: 'set', path: ['v'], next: 'theirs' } as StoreOp],
        policies,
      );
      expect(res.root).toStrictEqual({ v: 'mine' });
      expect(calls).toEqual([]);
    });

    it('a pending set over an untouched base lands whole', () => {
      const res = rebaseOps(
        { v: 'mine', w: 0 },
        [[{ kind: 'set', path: ['v'], next: 'mine', prev: 'orig' }]],
        [{ kind: 'set', path: ['w'], next: 1, prev: 0 }],
        policies,
      );
      expect(res.root).toStrictEqual({ v: 'mine', w: 1 });
      expect(calls).toEqual([]);
    });

    it('a both-sides change merges, and the merge gets the op path', () => {
      const res = rebaseOps(
        { v: 'mine' },
        [[{ kind: 'set', path: ['v'], next: 'mine', prev: 'orig' }]],
        [{ kind: 'set', path: ['v'], next: 'theirs', prev: 'orig' }],
        policies,
      );
      expect(res.root).toStrictEqual({ v: 'mine+theirs' });
      expect(calls).toEqual([['v']]);
    });
  });
});
