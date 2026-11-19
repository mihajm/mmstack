import { describe, expect, it } from 'vitest';
import { checkEnvelope, pathPrefixAcl } from './policy';
import { MESH_PROTO_VERSION, type OpEnvelope } from './wire';

const env = (writer: string): OpEnvelope => ({
  proto: MESH_PROTO_VERSION,
  instance: 'g',
  origin: 'o',
  writer,
  version: 1,
  hlc: { p: 1, l: 0 },
  policyVersion: 0,
  ops: [{ kind: 'set', path: ['a'], next: 1, cites: [], epoch: 0 }],
});

describe('checkEnvelope', () => {
  it('refuses an envelope whose writer is not the authenticated principal, with or without a policy', () => {
    const mismatch = { writer: 'a', reason: 'writer-mismatch' };
    expect(checkEnvelope(undefined, env('b'), { writer: 'a' }, 'r')).toEqual(
      mismatch,
    );
    expect(
      checkEnvelope({ canWrite: () => true }, env('b'), { writer: 'a' }, 'r'),
    ).toEqual(mismatch);
  });
  it('is clean for the principal own envelope, and names the failing hook and path', () => {
    expect(checkEnvelope(undefined, env('a'), { writer: 'a' }, 'r')).toBeNull();
    expect(
      checkEnvelope({ canWrite: () => false }, env('a'), { writer: 'a' }, 'r'),
    ).toEqual({ writer: 'a', reason: 'can-write', path: ['a'] });
    expect(
      checkEnvelope({ validate: () => false }, env('a'), { writer: 'a' }, 'r'),
    ).toEqual({ writer: 'a', reason: 'validate', path: ['a'] });
  });
});

describe('pathPrefixAcl: prefix boundaries', () => {
  const ctx = { writer: 'w' };
  it('grants a write exactly at the granted prefix, and the root rule grants the root', () => {
    const acl = pathPrefixAcl([{ prefix: ['notes'], allow: () => true }]);
    expect(acl.canWrite?.(ctx, ['notes'], 'r')).toBe(true);
    expect(acl.canWrite?.(ctx, ['notes', 'x'], 'r')).toBe(true);
    const root = pathPrefixAcl([{ prefix: [], allow: () => true }]);
    expect(root.canWrite?.(ctx, [], 'r')).toBe(true);
  });
  it('a wildcard segment never matches a missing segment: no write above the rule', () => {
    const acl = pathPrefixAcl([{ prefix: ['cases', '*'], allow: () => true }]);
    expect(acl.canWrite?.(ctx, ['cases'], 'r')).toBe(false);
    expect(acl.canWrite?.(ctx, ['cases', 7], 'r')).toBe(true);
  });
  it('denies every path that no rule grants', () => {
    expect(pathPrefixAcl([]).canWrite?.(ctx, ['a'], 'r')).toBe(false);
    const acl = pathPrefixAcl([{ prefix: ['a'], allow: () => true }]);
    expect(acl.canWrite?.(ctx, ['b'], 'r')).toBe(false);
  });
});
