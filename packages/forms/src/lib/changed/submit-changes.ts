import { untracked } from '@angular/core';
import {
  type FieldState,
  type FieldTree,
  submit,
} from '@angular/forms/signals';
import { rebaseline, reconcile } from './changed';
import { collectChanged, type DeepPartial } from './changed-values';

/**
 * The server-error shape Angular's `submit()` accepts from an action (`TreeValidationResult`
 * isn't exported directly, so it's derived from the signature).
 */
type SubmitErrors<T> = Awaited<
  ReturnType<NonNullable<Parameters<typeof submit<T>>[1]>>
>;

/** The mutation surface {@link submitChanges} drives — `mutationResource` satisfies it structurally. */
export type SubmitTarget<TPayload, TResult> = {
  mutateAsync: (value: TPayload) => Promise<TResult>;
};

export type SubmitChangesOptions<T, TResult> = {
  /**
   * What to send: `'changed'` (default) extracts the minimal changed subset via
   * {@link changedValues} — and *skips the request entirely* when nothing changed (the
   * returned promise resolves `true`); `'full'` always sends the whole form value.
   */
  readonly payload?: 'changed' | 'full';
  /**
   * What to do with the form's baseline on success. Either way, the submitted units are first
   * re-baselined to the values that were actually SENT — so an edit that landed while the
   * request was in flight stays dirty (it was never saved), instead of being silently absorbed:
   * - `'commit'` (default): that re-baseline is all — "what was sent is saved".
   * - `'reconcile'`: additionally merge the mutation's *result* back into the form (the server
   *   echoed the entity — its canonical version becomes value + baseline, while mid-flight
   *   edits survive per {@link reconcile}'s rules). Only offered when the mutation result is
   *   assignable to the form model.
   *
   * On error neither runs — dirty state is left alone, ready to retry.
   */
  readonly onSuccess?: [TResult] extends [T] ? 'commit' | 'reconcile' : 'commit';
  /**
   * Map a mutation failure into form errors (Angular's server-error channel — returned errors
   * attach to their fields until the next submit). Without it the failure rethrows out of the
   * returned promise; the mutation's own `onError` hooks fire either way.
   */
  readonly errors?: (error: unknown) => SubmitErrors<T>;
  /** Forwarded to Angular's `submit()` — which validators may block submission. */
  readonly ignoreValidators?: 'pending' | 'none' | 'all';
};

/**
 * The submit recipe everyone hand-writes, as one composition: validate via Angular's `submit()`
 * (touch-all, block-on-invalid, `submitting` state, double-submit guard), send the (diffed)
 * value through a mutation, then re-baseline what was sent — optionally `reconcile`-ing the
 * server echo — on success, and leave dirty state alone on error.
 *
 * Pure sugar over public pieces: the mutation is any `{ mutateAsync }` (an `@mmstack/resource`
 * `mutationResource` fits structurally, bringing its queue/supersede semantics along), and the
 * baseline handling is the `changed`-tree machinery (`reconcile` + submitted-unit re-baseline).
 *
 * @returns A submit function: `() => Promise<boolean>` — `true` when the form was valid and the
 * mutation succeeded (or there was nothing to send), `false` when validation blocked it or the
 * `errors` mapper attached errors. Unmapped mutation failures reject.
 *
 * @example
 * ```ts
 * const f = form(model, trackChanges(model));
 * const save = submitChanges(f, updateUser, { onSuccess: 'reconcile' });
 * // <button (click)="save()" [disabled]="f().submitting()">
 * ```
 */
export function submitChanges<T, TResult>(
  tree: FieldTree<T>,
  mutation: SubmitTarget<DeepPartial<T>, TResult>,
  options?: SubmitChangesOptions<T, TResult> & { payload?: 'changed' },
): () => Promise<boolean>;
export function submitChanges<T, TResult>(
  tree: FieldTree<T>,
  mutation: SubmitTarget<T, TResult>,
  options: SubmitChangesOptions<T, TResult> & { payload: 'full' },
): () => Promise<boolean>;
export function submitChanges<T, TResult>(
  tree: FieldTree<T>,
  mutation: SubmitTarget<never, TResult>,
  options?: SubmitChangesOptions<T, TResult>,
): () => Promise<boolean> {
  const payloadMode = options?.payload ?? 'changed';
  const onSuccess = options?.onSuccess ?? 'commit';

  return () =>
    submit(tree, {
      ignoreValidators: options?.ignoreValidators,
      action: async () => {
        // Snapshot at request time: the payload AND the unit paths it consists of, so success
        // can re-baseline exactly what was sent, at the sent values — never a mid-flight edit.
        const snapshot =
          payloadMode === 'full'
            ? {
                value: untracked(() => tree().value()) as unknown,
                paths: [''],
              }
            : collectChanged(tree);

        // nothing changed — a successful no-op, not a request
        if (!snapshot) return;

        let result: TResult;
        try {
          result = await mutation.mutateAsync(snapshot.value as never);
        } catch (err) {
          if (options?.errors) return options.errors(err);
          throw err; // Angular's submit() resets `submitting` in a finally — safe to propagate
        }

        // "What was sent is saved": each submitted unit's baseline becomes its sent value.
        untracked(() => {
          for (const path of snapshot.paths) {
            const state = stateAt(tree as FieldTree<unknown>, path);
            if (state) rebaseline(state, sliceAt(snapshot.value, path));
          }
        });

        if (onSuccess === 'reconcile') reconcile(tree, result as unknown as T);
        return;
      },
    });
}

/** Resolves the field state at a dot path (array indices as segments); '' is the root. */
function stateAt(
  tree: FieldTree<unknown>,
  path: string,
): FieldState<unknown> | undefined {
  if (!path) return tree();
  let node: unknown = tree;
  for (const seg of path.split('.')) {
    node = (node as Record<string, unknown> | undefined)?.[seg];
    if (node === undefined) return undefined;
  }
  return (node as FieldTree<unknown>)();
}

/** Reads the payload slice at a dot path; '' is the whole payload. */
function sliceAt(value: unknown, path: string): unknown {
  if (!path) return value;
  let out: unknown = value;
  for (const seg of path.split('.')) {
    out = (out as Record<string, unknown> | undefined)?.[seg];
  }
  return out;
}
