import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import {
  form,
  type FieldTree,
  type SchemaFn,
} from '@angular/forms/signals';
import {
  CHANGED,
  changedEqual,
  changedWith,
  commitChanges,
  reconcile,
  trackChanges,
} from './changed';
import { changedCount, changedPaths, changedValues } from './changed-values';

type Model = {
  name: string;
  profile: { age: number; address: { city: string; zip: string } };
  tags: string[];
  contacts: { email: string; primary: boolean }[];
};

const initial = (): Model => ({
  name: 'ann',
  profile: { age: 30, address: { city: 'nyc', zip: '10001' } },
  tags: ['a', 'b'],
  contacts: [
    { email: 'a@x.com', primary: true },
    { email: 'b@x.com', primary: false },
  ],
});

function changedOf(tree: FieldTree<unknown>): boolean {
  return tree().metadata(CHANGED)?.changed() ?? false;
}

function setup(schema?: SchemaFn<Model>) {
  return TestBed.runInInjectionContext(() => {
    const model = signal<Model>(initial());
    const track = trackChanges(model);
    const f = form(model, (p) => {
      schema?.(p);
      track(p);
    });
    commitChanges(f);
    return { model, f };
  });
}

describe('changedValues / changedPaths / changedCount', () => {
  it('returns undefined / [] / 0 when nothing changed', () => {
    const { f } = setup();
    expect(changedValues(f)).toBeUndefined();
    expect(changedPaths(f)()).toEqual([]);
    expect(changedCount(f)()).toBe(0);
  });

  it('extracts a single edited leaf as a minimal nested partial', () => {
    const { f } = setup();
    f.name().value.set('bob');

    expect(changedValues(f)).toEqual({ name: 'bob' });
    expect(changedPaths(f)()).toEqual(['name']);
    expect(changedCount(f)()).toBe(1);
  });

  it('narrows deep object edits to the changed leaf only', () => {
    const { f } = setup();
    f.profile.address.city().value.set('sf');

    expect(changedValues(f)).toEqual({
      profile: { address: { city: 'sf' } },
    });
    expect(changedPaths(f)()).toEqual(['profile.address.city']);
  });

  it('merges multiple edited branches into one partial', () => {
    const { f } = setup();
    f.name().value.set('bob');
    f.profile.age().value.set(31);

    expect(changedValues(f)).toEqual({ name: 'bob', profile: { age: 31 } });
    expect(changedPaths(f)().toSorted()).toEqual(['name', 'profile.age']);
    expect(changedCount(f)()).toBe(2);
  });

  it('emits arrays whole (the honest unit), for both leaf-array and item edits', () => {
    const { f } = setup();

    f.tags().value.set(['a', 'b', 'c']);
    expect(changedValues(f)).toEqual({ tags: ['a', 'b', 'c'] });
    expect(changedPaths(f)()).toEqual(['tags']);

    commitChanges(f);
    f.contacts[0].email().value.set('changed@x.com');
    const extracted = changedValues(f);
    // JSON round-trip: signal-forms stamps array items with an identity symbol — symbol keys
    // never serialize, so the payload is wire-identical to the plain shape.
    expect(JSON.parse(JSON.stringify(extracted?.contacts))).toEqual([
      { email: 'changed@x.com', primary: true },
      { email: 'b@x.com', primary: false },
    ]);
    expect(changedPaths(f)()).toEqual(['contacts']);
  });

  it('agrees with the boolean flag through edit → revert cycles (never a stale payload)', () => {
    const { f } = setup();

    f.name().value.set('bob');
    expect(changedValues(f)).toBeDefined();
    expect(changedOf(f)).toBe(true);

    f.name().value.set('ann'); // revert to baseline
    expect(changedValues(f)).toBeUndefined();
    expect(changedOf(f)).toBe(false);
  });

  it('honors changedEqual overrides — an equal-under-override edit is not extracted', () => {
    const { f } = setup((p) =>
      changedEqual(p.name, (a, b) => a.toLowerCase() === b.toLowerCase()),
    );

    f.name().value.set('ANN'); // equal under override
    expect(changedValues(f)).toBeUndefined();
    expect(changedOf(f)).toBe(false);

    f.name().value.set('bob');
    expect(changedValues(f)).toEqual({ name: 'bob' });
  });

  it('treats an override-bearing container as a whole unit', () => {
    const { f } = setup((p) =>
      changedEqual(p.profile, (a, b) => a.age === b.age),
    );

    f.profile.address.city().value.set('sf'); // invisible to the override
    expect(changedValues(f)).toBeUndefined();

    f.profile.age().value.set(31);
    // the override is authoritative for the subtree — no deeper attribution
    expect(changedValues(f)).toEqual({
      profile: { age: 31, address: { city: 'sf', zip: '10001' } },
    });
    expect(changedPaths(f)()).toEqual(['profile']);
  });

  it('honors changedWith — a subtree whose custom fn says unchanged is excluded', () => {
    const { f } = setup((p) =>
      changedWith(p.profile, (init, cur) => init.age !== cur.age),
    );

    f.profile.address.city().value.set('sf');
    expect(changedValues(f)).toBeUndefined(); // custom fn only watches age
    expect(changedOf(f.profile)).toBe(false); // ...and the flag agrees
  });

  it('re-baselining clears extraction: commitChanges and reconcile both zero it out', () => {
    const { f } = setup();

    f.name().value.set('bob');
    commitChanges(f);
    expect(changedValues(f)).toBeUndefined();

    f.profile.age().value.set(40);
    reconcile(f, { ...initial(), profile: { ...initial().profile, age: 41 } });
    // the in-flight edit survives reconcile and reads changed vs the new baseline
    expect(changedValues(f)).toEqual({ profile: { age: 40 } });
  });

  it('changedPaths / changedCount are live signals', () => {
    const { f } = setup();
    const paths = changedPaths(f);
    const count = changedCount(f);

    expect(count()).toBe(0);
    f.name().value.set('bob');
    expect(paths()).toEqual(['name']);
    expect(count()).toBe(1);

    f.profile.age().value.set(31);
    expect(count()).toBe(2);

    commitChanges(f);
    expect(paths()).toEqual([]);
    expect(count()).toBe(0);
  });

  it('key churn makes the record a whole unit (per-child delegation cannot attribute it)', () => {
    const f = TestBed.runInInjectionContext(() => {
      const model = signal<Record<string, unknown>>({ a: 1, b: 2 });
      const forms = form(model, trackChanges(model));
      commitChanges(forms);
      return forms;
    });

    // add a key: the container's key set changed — emitted whole, path is the container
    f().value.set({ a: 1, b: 2, c: 3 });
    expect(changedValues(f)).toEqual({ a: 1, b: 2, c: 3 });
    expect(changedPaths(f)()).toEqual(['']);

    // reverting the shape returns to clean — and the extraction agrees
    f().value.set({ a: 1, b: 2 });
    expect(changedValues(f)).toBeUndefined();

    // remove a key: same whole-unit rule
    f().value.set({ a: 1 });
    expect(changedValues(f)).toEqual({ a: 1 });
    expect(changedPaths(f)()).toEqual(['']);
  });

  it('returns undefined (with no throw) for an untracked form', () => {
    const f = TestBed.runInInjectionContext(() => {
      const model = signal<Model>(initial());
      return form(model);
    });
    expect(changedValues(f)).toBeUndefined();
    expect(changedPaths(f)()).toEqual([]);
  });
});
