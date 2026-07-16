import type { Key, OpEnvelope, StoreOp } from './wire';

/**
 * The principal behind a connection, as authenticated by the adapter. `kind` distinguishes non-human peers: an agent is a user, just one
 * whose policy is usually narrower.
 */
export type PrincipalCtx = {
  readonly writer: string;
  readonly kind?: 'human' | 'agent' | (string & {});
  readonly claims?: Readonly<Record<string, unknown>>;
};

/**
 * Pure, deterministic, versioned validation. Run symmetrically on emit and on
 * apply: honest peers never emit invalid ops, so any violation observed on the wire is a
 * buggy or malicious writer — tripwire semantics eject it deterministically. Never skip an
 * op mid-log.
 *
 * This is a WRITE ACL, not a read ACL: every room member sees the whole root, so the room is
 * the confidentiality boundary. Data with different audiences belongs in different rooms.
 *
 * A `clear` op counts as a write at its path (it retires that path's register as part of a
 * subtree replace), so `canWrite` and `validate` see clears like any other op.
 *
 * This gates SHAPE and PATH access on a trusted `ctx.writer` (your adapter authenticates it). It
 * does not by itself check the precedence an op claims or the authenticity of its citations; a rule
 * like "only this role may override" belongs in `validate` against that trusted writer. A direct
 * peer-to-peer connection bypasses the relay, so a peer-to-peer room is trust-full for authority.
 *
 * Every hook receives the `room` it is evaluating in, so one relay can hold different authority
 * per room (a role that owns one care context but not another). A policy that ignores the
 * parameter applies uniformly. The room does not weaken the shared `policyVersion` pin: rules for
 * ANY room changing means the one pin bumps.
 */
export type OpPolicy = {
  canWrite?(ctx: PrincipalCtx, path: readonly Key[], room: string): boolean;
  validate?(op: StoreOp, ctx: PrincipalCtx, room: string): boolean;
  /**
   * Authority gate for epoch raises, evaluated at the relay against the room's retained
   * register state. An op whose `epoch` EXCEEDS the room's observed max at its path is a BUMP
   * (it claims new precedence) and is admitted only if this grants it; an op at or below the
   * observed max CARRIES existing precedence forward and is always admitted regardless of
   * authority — any writer that observed a bumped op must be able to cite it and carry its
   * epoch, or writes at bumped paths stop merging. Violations eject with reason
   * `'epoch-bump'`. Relay-side only (a direct peer-to-peer room bypasses it); omit to leave
   * epochs ungated.
   */
  canBump?(
    ctx: PrincipalCtx,
    path: readonly Key[],
    epoch: number,
    room: string,
  ): boolean;
  /**
   * Reject an op citing a dot the room has no record of at that path (reason
   * `'unknown-citation'`): defense in depth against forged citations, which would raise a
   * victim origin's supersession watermark and kill writes it never made. Known-partial by
   * design — citing a REAL dot the writer never actually observed still passes. Cites at or
   * below the room's compaction frontier are exempt: the relay can no longer verify them
   * there, and a forged cite below the frontier can kill nothing (below-frontier deliveries
   * are already rejected at admission). Enable only for rooms where every op transits the
   * relay AND the relay is durable (hydrated across restarts): a room that loses its retained
   * state forgets the dots honest writers still cite.
   */
  readonly verifyCitations?: boolean;
};

export type PolicyViolation = {
  readonly writer: string;
  readonly reason:
    | 'can-write'
    | 'validate'
    | 'malformed'
    | 'writer-mismatch'
    | 'proto'
    | 'ops-limit'
    | 'rate'
    | 'epoch-bump'
    | 'unknown-citation';
  /** the specific failure: the well-formedness reason for `'malformed'`, the offending
   *  epoch vs the observed max for `'epoch-bump'`, the cited dot for `'unknown-citation'`. */
  readonly detail?: string;
  readonly path?: readonly Key[];
};

/** Check one envelope against a policy, in the given room; `null` means clean. */
export function checkEnvelope(
  policy: OpPolicy | undefined,
  env: OpEnvelope,
  ctx: PrincipalCtx,
  room: string,
): PolicyViolation | null {
  if (env.writer !== ctx.writer) {
    return { writer: ctx.writer, reason: 'writer-mismatch' };
  }
  if (!policy) return null;
  for (const op of env.ops) {
    if (policy.canWrite && !policy.canWrite(ctx, op.path, room)) {
      return { writer: ctx.writer, reason: 'can-write', path: op.path };
    }
    if (policy.validate && !policy.validate(op, ctx, room)) {
      return { writer: ctx.writer, reason: 'validate', path: op.path };
    }
  }
  return null;
}

/**
 * S3-key-policy-style path ACL: each rule grants a principal predicate write access to one
 * path prefix (`'*'` matches a single segment; a rule for `[]` grants the whole store).
 * Composes into `OpPolicy.canWrite`; deny-by-default once any rule exists for a writer.
 */
export type PathAclRule = {
  readonly prefix: readonly (Key | '*')[];
  readonly allow: (ctx: PrincipalCtx, room: string) => boolean;
};

export function pathPrefixAcl(rules: readonly PathAclRule[]): OpPolicy {
  return {
    canWrite: (ctx, path, room) =>
      rules.some((rule) => {
        if (rule.prefix.length > path.length) return false;
        for (let i = 0; i < rule.prefix.length; i++) {
          if (
            rule.prefix[i] !== '*' &&
            String(rule.prefix[i]) !== String(path[i])
          ) {
            return false;
          }
        }
        return rule.allow(ctx, room);
      }),
  };
}
