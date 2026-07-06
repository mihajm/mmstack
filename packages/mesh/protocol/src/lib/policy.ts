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
 */
export type OpPolicy = {
  canWrite?(ctx: PrincipalCtx, path: readonly Key[]): boolean;
  validate?(op: StoreOp, ctx: PrincipalCtx): boolean;
};

export type PolicyViolation = {
  readonly writer: string;
  readonly reason:
    | 'can-write'
    | 'validate'
    | 'writer-mismatch'
    | 'proto'
    | 'ops-limit'
    | 'rate';
  readonly path?: readonly Key[];
};

/** Check one envelope against a policy; `null` means clean. */
export function checkEnvelope(
  policy: OpPolicy | undefined,
  env: OpEnvelope,
  ctx: PrincipalCtx,
): PolicyViolation | null {
  if (env.writer !== ctx.writer) {
    return { writer: ctx.writer, reason: 'writer-mismatch' };
  }
  if (!policy) return null;
  for (const op of env.ops) {
    if (policy.canWrite && !policy.canWrite(ctx, op.path)) {
      return { writer: ctx.writer, reason: 'can-write', path: op.path };
    }
    if (policy.validate && !policy.validate(op, ctx)) {
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
  readonly allow: (ctx: PrincipalCtx) => boolean;
};

export function pathPrefixAcl(rules: readonly PathAclRule[]): OpPolicy {
  return {
    canWrite: (ctx, path) =>
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
        return rule.allow(ctx);
      }),
  };
}
