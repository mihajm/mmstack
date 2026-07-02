import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { form, required } from '@angular/forms/signals';
import { CHANGED, commitChanges, trackChanges } from './changed';
import type { DeepPartial } from './changed-values';
import { submitChanges } from './submit-changes';

type Model = { name: string; age: number };

function setup(opts?: { requireName?: boolean }) {
  return TestBed.runInInjectionContext(() => {
    const model = signal<Model>({ name: 'ann', age: 30 });
    const track = trackChanges(model);
    const f = form(model, (p) => {
      if (opts?.requireName) required(p.name);
      track(p);
    });
    commitChanges(f);
    return { model, f };
  });
}

/** A manual mutation double: records calls, resolves/rejects on command. */
function fakeMutation<TResult = Model>() {
  const calls: unknown[] = [];
  let deferred: PromiseWithResolvers<TResult> | null = null;
  return {
    calls,
    mutateAsync: (value: unknown) => {
      calls.push(value);
      deferred = Promise.withResolvers<TResult>();
      return deferred.promise;
    },
    resolve: (value: TResult) => deferred?.resolve(value),
    reject: (err: unknown) => deferred?.reject(err),
  };
}

const changedOf = (f: ReturnType<typeof setup>['f']) =>
  f().metadata(CHANGED)?.changed() ?? false;

describe('submitChanges', () => {
  it('sends the minimal changed subset and commits on success', async () => {
    const { f } = setup();
    const mutation = fakeMutation();
    const save = submitChanges(f, mutation);

    f.name().value.set('bob');
    const result = save();
    expect(mutation.calls).toEqual([{ name: 'bob' }]); // diffed payload, not the full model

    mutation.resolve({ name: 'bob', age: 30 });
    await expect(result).resolves.toBe(true);
    expect(changedOf(f)).toBe(false); // committed — saved-as-is baseline
  });

  it('skips the request entirely when nothing changed (successful no-op)', async () => {
    const { f } = setup();
    const mutation = fakeMutation();
    const save = submitChanges(f, mutation);

    await expect(save()).resolves.toBe(true);
    expect(mutation.calls).toEqual([]);
  });

  it("payload: 'full' sends the whole model even for partial edits", async () => {
    const { f } = setup();
    const mutation = fakeMutation();
    const save = submitChanges(f, mutation, { payload: 'full' });

    f.name().value.set('bob');
    const result = save();
    expect(mutation.calls).toEqual([{ name: 'bob', age: 30 }]);

    mutation.resolve({ name: 'bob', age: 30 });
    await expect(result).resolves.toBe(true);
  });

  it("payload: 'full' fires even when nothing changed", async () => {
    const { f } = setup();
    const mutation = fakeMutation();
    const save = submitChanges(f, mutation, { payload: 'full' });

    const result = save();
    expect(mutation.calls.length).toBe(1);
    mutation.resolve({ name: 'ann', age: 30 });
    await expect(result).resolves.toBe(true);
  });

  it("onSuccess: 'reconcile' adopts the server echo while keeping a mid-flight edit", async () => {
    const { f } = setup();
    const mutation = fakeMutation();
    const save = submitChanges(f, mutation, { onSuccess: 'reconcile' });

    f.name().value.set('bob');
    const result = save();

    f.age().value.set(99); // edit landing while the request is in flight

    // server echoes the entity, normalized (name uppercased) + its own age
    mutation.resolve({ name: 'BOB', age: 31 });
    await expect(result).resolves.toBe(true);

    expect(f.name().value()).toBe('BOB'); // unchanged-vs-flight field adopts the echo
    expect(f.age().value()).toBe(99); // in-flight edit survives
    expect(f.age().metadata(CHANGED)?.changed()).toBe(true); // ...and reads changed vs the echo
    expect(f.name().metadata(CHANGED)?.changed()).toBe(false);
  });

  it('a mid-flight edit stays dirty after a commit — only what was SENT is saved', async () => {
    const { f } = setup();
    const mutation = fakeMutation();
    const save = submitChanges(f, mutation);

    f.name().value.set('bob');
    const result = save(); // sends { name: 'bob' }

    f.name().value.set('bobby'); // further edit while the request is in flight
    f.age().value.set(99); // and an edit to a field that was never sent

    mutation.resolve({ name: 'bob', age: 30 });
    await expect(result).resolves.toBe(true);

    // baseline for name is the SENT 'bob' — the newer 'bobby' is unsaved work:
    expect(f.name().metadata(CHANGED)?.changed()).toBe(true);
    // age was never part of the payload — must not be absorbed by the commit:
    expect(f.age().metadata(CHANGED)?.changed()).toBe(true);
    expect(changedOf(f)).toBe(true);
  });

  it('rethrows an unmapped failure and leaves dirty state alone, ready to retry', async () => {
    const { f } = setup();
    const mutation = fakeMutation();
    const save = submitChanges(f, mutation);

    f.name().value.set('bob');
    const result = save();
    const boom = new Error('500');
    mutation.reject(boom);

    await expect(result).rejects.toBe(boom);
    expect(changedOf(f)).toBe(true); // still dirty
    expect(changedOf(f) && f().submitting()).toBe(false); // no stuck submitting state
    expect(f.name().value()).toBe('bob');
  });

  it('maps a failure into form errors via the errors option (resolves false)', async () => {
    const { f } = setup();
    const mutation = fakeMutation();
    const save = submitChanges(f, mutation, {
      errors: () => ({
        fieldTree: f.name,
        kind: 'server',
        message: 'name taken',
      }),
    });

    f.name().value.set('bob');
    const result = save();
    mutation.reject(new Error('409'));

    await expect(result).resolves.toBe(false);
    expect(
      f.name()
        .errors()
        .some((e) => e.kind === 'server'),
    ).toBe(true);
    expect(changedOf(f)).toBe(true); // dirty state intact for the retry
  });

  it('validation blocks the mutation: invalid form resolves false without a request', async () => {
    const { f } = setup({ requireName: true });
    const mutation = fakeMutation();
    const save = submitChanges(f, mutation);

    f.name().value.set(''); // violates required + is a change
    await expect(save()).resolves.toBe(false);
    expect(mutation.calls).toEqual([]);
  });

  it('guards against double-submit: a second call while in flight resolves false', async () => {
    const { f } = setup();
    const mutation = fakeMutation();
    const save = submitChanges(f, mutation);

    f.name().value.set('bob');
    const first = save();
    const second = save();

    await expect(second).resolves.toBe(false);
    expect(mutation.calls.length).toBe(1);

    mutation.resolve({ name: 'bob', age: 30 });
    await expect(first).resolves.toBe(true);
  });

  it('re-baselines an ARRAY-unit path to its sent value on success', async () => {
    const f = TestBed.runInInjectionContext(() => {
      const model = signal<{ tags: string[]; name: string }>({
        tags: ['a'],
        name: 'ann',
      });
      const forms = form(model, trackChanges(model));
      commitChanges(forms);
      return forms;
    });
    const mutation = fakeMutation<{ tags: string[]; name: string }>();
    const save = submitChanges(f, mutation);

    f.tags().value.set(['a', 'b']); // arrays extract whole — the unit path is 'tags'
    const result = save();
    expect(mutation.calls).toEqual([{ tags: ['a', 'b'] }]);

    f.tags().value.set(['a', 'b', 'c']); // mid-flight edit to the SAME array unit

    mutation.resolve({ tags: ['a', 'b'], name: 'ann' });
    await expect(result).resolves.toBe(true);

    // baseline for tags is the SENT ['a','b'] — the mid-flight 3-element edit stays dirty…
    expect(f.tags().metadata(CHANGED)?.changed()).toBe(true);
    // …and reverting to what was sent reads clean (the baseline really is the sent value)
    f.tags().value.set(['a', 'b']);
    expect(f.tags().metadata(CHANGED)?.changed()).toBe(false);
    expect(f.name().metadata(CHANGED)?.changed()).toBe(false); // never sent, never touched
  });

  it('type-level: a Partial-accepting mutation satisfies the default payload mode', () => {
    const { f } = setup();
    // compile-time contract — DeepPartial payloads feed Partial-typed mutations
    const mutation = {
      mutateAsync: (v: DeepPartial<Model>) => Promise.resolve(v),
    };
    const save = submitChanges(f, mutation);
    expect(typeof save).toBe('function');
  });
});
