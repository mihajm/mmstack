import {
  Component,
  computed,
  Directive,
  isSignal,
  signal,
} from '@angular/core';
import { TestBed } from '@angular/core/testing';
import {
  applyEach,
  form,
  FormField,
  type FieldTree,
  type SchemaFn,
} from '@angular/forms/signals';
import { By } from '@angular/platform-browser';
import { composition } from '../compose/compose';
import {
  CHANGED,
  changedEqual,
  changedWith,
  changeTracking,
  commitChanges,
  injectChanged,
  reconcile,
  reconcileWith,
  resetChanged,
  resetInitial,
  trackChanges,
} from './changed';

type Contact = { email: string; primary: boolean };
type Model = {
  name: string;
  profile: { age: number; address: { city: string; zip: string } };
  tags: string[];
  contacts: Contact[];
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

// No explicit commitChanges — exercises the automatic baseline / option behavior.
// Ticks so the root tracking effect runs its first (seeding) pass.
function setupAuto(opts?: { manualCommit?: boolean }) {
  const r = TestBed.runInInjectionContext(() => {
    const model = signal<Model>(initial());
    const f = form(model, trackChanges(model, opts));
    return { model, f };
  });
  TestBed.tick(); // run the auto-commit / commit-on-submit effect's first pass
  return r;
}

describe('change tracking', () => {
  describe('defaults', () => {
    it('reports nothing changed initially, at every level', () => {
      const { f } = setup();
      expect(changedOf(f)).toBe(false);
      expect(changedOf(f.name)).toBe(false);
      expect(changedOf(f.profile)).toBe(false);
      expect(changedOf(f.profile.address)).toBe(false);
      expect(changedOf(f.profile.address.city)).toBe(false);
      expect(changedOf(f.tags)).toBe(false);
      expect(changedOf(f.contacts)).toBe(false);
      expect(changedOf(f.contacts[0])).toBe(false);
    });

    it('delegates a deep leaf change up the spine, leaving siblings unchanged', () => {
      const { f } = setup();
      f.profile.address.city().value.set('sf');

      expect(changedOf(f.profile.address.city)).toBe(true);
      expect(changedOf(f.profile.address)).toBe(true);
      expect(changedOf(f.profile)).toBe(true);
      expect(changedOf(f)).toBe(true);

      expect(changedOf(f.profile.address.zip)).toBe(false);
      expect(changedOf(f.profile.age)).toBe(false);
      expect(changedOf(f.name)).toBe(false);
      expect(changedOf(f.tags)).toBe(false);
    });

    it('returns to unchanged when a leaf reverts to its baseline', () => {
      const { f } = setup();
      f.name().value.set('bob');
      expect(changedOf(f)).toBe(true);
      f.name().value.set('ann');
      expect(changedOf(f.name)).toBe(false);
      expect(changedOf(f)).toBe(false);
    });

    it('tracks a nested number field', () => {
      const { f } = setup();
      f.profile.age().value.set(31);
      expect(changedOf(f.profile.age)).toBe(true);
      expect(changedOf(f.profile)).toBe(true);
      expect(changedOf(f.profile.address)).toBe(false);
    });
  });

  // "Is the data different?" — never "did the reference update?".
  describe('value identity, not reference', () => {
    it('treats a fresh object reference with unchanged leaves as not changed', () => {
      const { f, model } = setup();
      model.update((m) => ({
        ...m,
        profile: { ...m.profile, address: { ...m.profile.address } },
      }));
      expect(changedOf(f.profile.address)).toBe(false);
      expect(changedOf(f.profile)).toBe(false);
      expect(changedOf(f)).toBe(false);
    });

    it('treats fresh array references with unchanged items as not changed', () => {
      const { f, model } = setup();
      model.update((m) => ({
        ...m,
        tags: [...m.tags],
        contacts: m.contacts.map((c) => ({ ...c })),
      }));
      expect(changedOf(f.tags)).toBe(false);
      expect(changedOf(f.contacts)).toBe(false);
      expect(changedOf(f)).toBe(false);
    });
  });

  describe('reactivity', () => {
    it('does not recompute an ancestor container when an already-changed leaf is edited again', () => {
      const { f } = setup();
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
      const profileChanged = f.profile().metadata(CHANGED)!.changed;
      let runs = 0;
      const probe = computed(() => {
        runs++;
        return profileChanged();
      });

      expect(probe()).toBe(false); // first compute
      f.profile.age().value.set(31); // first change flips → ancestor recomputes
      expect(probe()).toBe(true);
      const at = runs;

      f.profile.age().value.set(32); // already changed, no flip → no ancestor recompute
      expect(probe()).toBe(true);
      expect(runs).toBe(at);
    });
  });

  describe('arrays', () => {
    it('marks changed on a primitive push (length) and on revert', () => {
      const { f, model } = setup();
      model.update((m) => ({ ...m, tags: [...m.tags, 'c'] }));
      expect(changedOf(f.tags)).toBe(true);
      expect(changedOf(f)).toBe(true);
      model.update((m) => ({ ...m, tags: ['a', 'b'] }));
      expect(changedOf(f.tags)).toBe(false);
    });

    it('marks changed on a primitive item edit', () => {
      const { f } = setup();
      f.tags[0]().value.set('z');
      expect(changedOf(f.tags)).toBe(true);
      expect(changedOf(f)).toBe(true);
    });

    it('marks changed on an object item edit, isolating siblings', () => {
      const { f } = setup();
      f.contacts[0].email().value.set('z@x.com');
      expect(changedOf(f.contacts[0])).toBe(true);
      expect(changedOf(f.contacts[0].email)).toBe(true);
      expect(changedOf(f.contacts)).toBe(true);
      expect(changedOf(f)).toBe(true);
      expect(changedOf(f.contacts[1])).toBe(false);
      expect(changedOf(f.contacts[0].primary)).toBe(false);
    });

    it('detects a reorder (same length, identity-tracked items)', () => {
      const { f, model } = setup();
      model.update((m) => ({ ...m, contacts: [m.contacts[1], m.contacts[0]] }));
      expect(changedOf(f.contacts)).toBe(true);
      expect(changedOf(f)).toBe(true);
    });

    it('detects item removal', () => {
      const { f, model } = setup();
      model.update((m) => ({ ...m, contacts: [m.contacts[0]] }));
      expect(changedOf(f.contacts)).toBe(true);
    });

    it('marks a newly pushed item changed (committed baseline)', () => {
      const { f, model } = setup();
      model.update((m) => ({
        ...m,
        contacts: [...m.contacts, { email: 'c@x.com', primary: false }],
      }));
      expect(changedOf(f.contacts)).toBe(true);
      expect(changedOf(f)).toBe(true);
    });
  });

  // Keys in the initial shape get their own tracking; keys added later are value-diffed by the
  // container (which subscribes to its value for them, so their edits/reverts stay live). Key
  // additions/removals are caught via the container's key-set dependency — including reverting
  // to the baseline shape, which reads unchanged again on its own.
  describe('dynamic object keys', () => {
    function setupDict(init: Record<string, number>) {
      return TestBed.runInInjectionContext(() => {
        const model = signal<{ dict: Record<string, number> }>({
          dict: { ...init },
        });
        const fld = form(model, trackChanges(model));
        commitChanges(fld);
        return { model, f: fld };
      });
    }

    it('detects a key addition', () => {
      const { f, model } = setupDict({ a: 1, b: 2 });
      expect(changedOf(f.dict)).toBe(false);
      model.update((m) => ({ dict: { ...m.dict, c: 3 } }));
      expect(changedOf(f.dict)).toBe(true);
      expect(changedOf(f)).toBe(true);
    });

    it('detects a key removal', () => {
      const { f, model } = setupDict({ a: 1, b: 2 });
      model.update(() => ({ dict: { a: 1 } }));
      expect(changedOf(f.dict)).toBe(true);
    });

    it('detects a key addition from the delegating loop path (fresh ref, same shape first)', () => {
      const { f, model } = setupDict({ a: 1, b: 2 });
      model.update((m) => ({ dict: { ...m.dict } })); // same shape → false via child delegation
      expect(changedOf(f.dict)).toBe(false);
      model.update((m) => ({ dict: { ...m.dict, c: 3 } }));
      expect(changedOf(f.dict)).toBe(true);
    });

    it('reads unchanged again after add + remove back to the baseline shape', () => {
      const { f, model } = setupDict({ a: 1, b: 2 });
      model.update((m) => ({ dict: { ...m.dict, c: 3 } }));
      expect(changedOf(f.dict)).toBe(true);
      model.update(() => ({ dict: { a: 1, b: 2 } })); // exact baseline shape + values again
      expect(changedOf(f.dict)).toBe(false);

      f.dict['a']().value.set(9); // tracking is still live after the churn
      expect(changedOf(f.dict)).toBe(true);
      f.dict['a']().value.set(1);
      expect(changedOf(f.dict)).toBe(false);
    });

    it('tracks edit AND revert of a dynamically added (untracked) key after commit', () => {
      const { f, model } = setupDict({ a: 1, b: 2 });
      model.update((m) => ({ dict: { ...m.dict, c: 3 } }));
      commitChanges(f); // baseline now includes c, which has no CHANGED entry of its own

      expect(changedOf(f.dict)).toBe(false);
      model.update((m) => ({ dict: { ...m.dict, c: 4 } }));
      expect(changedOf(f.dict)).toBe(true);
      model.update((m) => ({ dict: { ...m.dict, c: 3 } })); // revert the untracked key
      expect(changedOf(f.dict)).toBe(false);
    });

    it('re-evaluates after a changed key is removed, then recovers + keeps tracking on commit', () => {
      const { f, model } = setupDict({ a: 1, b: 2 });
      model.update((m) => ({ dict: { ...m.dict, b: 99 } })); // change b (delegated)
      expect(changedOf(f.dict)).toBe(true);
      model.update(() => ({ dict: { a: 1 } })); // drop the changed key — re-evaluates, still changed
      expect(changedOf(f.dict)).toBe(true);

      commitChanges(f); // adopt the new shape as baseline
      expect(changedOf(f.dict)).toBe(false);

      model.update((m) => ({ dict: { ...m.dict, a: 9 } })); // tracking survives churn
      expect(changedOf(f.dict)).toBe(true);
    });
  });

  // Items pushed into an initially-empty array have no tracking of their own (the schema had no
  // item shape to descend into) — the container falls back to a value diff and must stay reactive.
  describe('untracked children (initially-empty arrays)', () => {
    function setupItems() {
      return TestBed.runInInjectionContext(() => {
        const model = signal<{ items: { a: string; b: number }[] }>({
          items: [],
        });
        const fld = form(model, trackChanges(model));
        commitChanges(fld);
        return { model, f: fld };
      });
    }

    it('reads a pushed item as changed until committed', () => {
      const { f, model } = setupItems();
      model.update(() => ({ items: [{ a: 'x', b: 1 }] }));
      expect(changedOf(f.items[0])).toBe(true); // no baseline yet
      expect(changedOf(f.items)).toBe(true);

      commitChanges(f.items);
      expect(changedOf(f.items[0])).toBe(false);
      expect(changedOf(f.items)).toBe(false);
    });

    it('tracks edit and revert of item leaves after commit — item and array agree', () => {
      const { f, model } = setupItems();
      model.update(() => ({ items: [{ a: 'x', b: 1 }] }));
      commitChanges(f);

      f.items[0].a().value.set('y');
      expect(changedOf(f.items[0])).toBe(true);
      expect(changedOf(f.items)).toBe(true);

      f.items[0].b().value.set(2); // second leaf while already changed
      f.items[0].a().value.set('x'); // revert the first
      expect(changedOf(f.items[0])).toBe(true); // b still differs

      f.items[0].b().value.set(1); // revert the second
      expect(changedOf(f.items[0])).toBe(false);
      expect(changedOf(f.items)).toBe(false);
    });
  });

  describe('overrides', () => {
    it('propagates a leaf custom-equality up through delegation', () => {
      const { f } = setup((p) =>
        changedEqual(p.name, (a, b) => a.toLowerCase() === b.toLowerCase()),
      );
      f.name().value.set('ANN');
      expect(changedOf(f.name)).toBe(false); // own override
      expect(changedOf(f)).toBe(false); // delegation honors it at the root
      f.name().value.set('bob');
      expect(changedOf(f.name)).toBe(true);
      expect(changedOf(f)).toBe(true);
    });

    it('lets a container override replace the subtree diff', () => {
      const { f } = setup((p) =>
        // treat address as "changed" only when the zip changes
        changedEqual(p.profile.address, (a, b) => a.zip === b.zip),
      );
      f.profile.address.city().value.set('sf');
      expect(changedOf(f.profile.address)).toBe(false); // city ignored
      f.profile.address.zip().value.set('99999');
      expect(changedOf(f.profile.address)).toBe(true);
    });

    it('honors a fully custom changedWith', () => {
      const { f } = setup((p) =>
        // never considered changed
        changedWith(p.name, () => false),
      );
      f.name().value.set('bob');
      expect(changedOf(f.name)).toBe(false);
      expect(changedOf(f)).toBe(false);
    });

    it('honors an item-level changedEqual on array items at equal lengths', () => {
      const { f, model } = setup((p) =>
        // a contact only "changes" when its email does — primary flips are ignored
        applyEach(p.contacts, (c) =>
          changedEqual(c, (a, b) => a.email === b.email),
        ),
      );

      model.update((m) => ({
        ...m,
        contacts: [{ ...m.contacts[0], primary: false }, m.contacts[1]],
      }));
      expect(changedOf(f.contacts)).toBe(false); // rule says equal
      expect(changedOf(f)).toBe(false);

      model.update((m) => ({
        ...m,
        contacts: [{ ...m.contacts[0], email: 'new@x.com' }, m.contacts[1]],
      }));
      expect(changedOf(f.contacts)).toBe(true);
      expect(changedOf(f)).toBe(true);
    });

    it('item rules apply POSITIONALLY — a reorder stays visible through them', () => {
      const { f, model } = setup((p) =>
        applyEach(p.contacts, (c) =>
          changedEqual(c, (a, b) => a.email === b.email),
        ),
      );

      // swap the two contacts: each ITEM is unchanged, but position 0's email differs
      model.update((m) => ({
        ...m,
        contacts: [m.contacts[1], m.contacts[0]],
      }));
      expect(changedOf(f.contacts)).toBe(true);

      model.update((m) => ({
        ...m,
        contacts: [m.contacts[1], m.contacts[0]], // swap back
      }));
      expect(changedOf(f.contacts)).toBe(false);
    });

    it('length changes trump item rules (a rule cannot hide an add/remove)', () => {
      const { f, model } = setup((p) =>
        applyEach(p.contacts, (c) => changedWith(c, () => false)),
      );

      model.update((m) => ({ ...m, contacts: m.contacts.slice(0, 1) }));
      expect(changedOf(f.contacts)).toBe(true); // shorter — changed regardless of rules
    });
  });

  describe('edge values', () => {
    it('treats null↔value transitions correctly', () => {
      const { f } = TestBed.runInInjectionContext(() => {
        const model = signal<{ v: string | null }>({ v: null });
        const fld = form(model, trackChanges(model));
        commitChanges(fld);
        return { f: fld };
      });
      f.v().value.set('x');
      expect(changedOf(f.v)).toBe(true);
      f.v().value.set(null);
      expect(changedOf(f.v)).toBe(false);
    });

    it('detects a change deep inside a nested array', () => {
      type Nested = { rows: { cells: number[] }[] };
      const { f } = TestBed.runInInjectionContext(() => {
        const model = signal<Nested>({
          rows: [{ cells: [1, 2] }, { cells: [3] }],
        });
        const fld = form(model, trackChanges(model));
        commitChanges(fld);
        return { f: fld };
      });
      f.rows[0].cells[1]().value.set(9);
      expect(changedOf(f.rows[0].cells[1])).toBe(true);
      expect(changedOf(f.rows[0])).toBe(true);
      expect(changedOf(f.rows)).toBe(true);
      expect(changedOf(f)).toBe(true);
      expect(changedOf(f.rows[1])).toBe(false);
    });
  });

  describe('commit / reset', () => {
    it('commitChanges re-baselines the whole tree to current', () => {
      const { f } = setup();
      f.name().value.set('bob');
      f.profile.age().value.set(31);
      expect(changedOf(f)).toBe(true);
      commitChanges(f);
      expect(changedOf(f)).toBe(false);
      expect(changedOf(f.name)).toBe(false);
      expect(changedOf(f.profile.age)).toBe(false);
    });

    it('commitChanges can re-baseline only a subtree', () => {
      const { f } = setup();
      f.name().value.set('bob');
      f.profile.age().value.set(31);
      commitChanges(f.profile);
      expect(changedOf(f.profile)).toBe(false); // re-baselined
      expect(changedOf(f.name)).toBe(true); // untouched
      expect(changedOf(f)).toBe(true);
    });

    it('resetChanged reverts values to the baseline and clears touched', () => {
      const { f, model } = setup();
      f.name().value.set('bob');
      f.profile.address.city().value.set('sf');
      f.name().markAsTouched();
      resetChanged(f);
      expect(model().name).toBe('ann');
      expect(model().profile.address.city).toBe('nyc');
      expect(changedOf(f)).toBe(false);
      expect(f.name().touched()).toBe(false);
    });

    it('resetChanged can revert only a subtree', () => {
      const { f, model } = setup();
      f.name().value.set('bob');
      f.profile.age().value.set(99);
      resetChanged(f.profile);
      expect(model().profile.age).toBe(30); // reverted
      expect(model().name).toBe('bob'); // untouched
      expect(changedOf(f.profile)).toBe(false);
      expect(changedOf(f.name)).toBe(true);
    });

    it('resetInitial adopts a new value + baseline', () => {
      const { f, model } = setup();
      resetInitial(f.profile.address, { city: 'la', zip: '90001' });
      expect(model().profile.address.city).toBe('la');
      expect(changedOf(f.profile.address)).toBe(false); // new baseline
      f.profile.address.city().value.set('sf');
      expect(changedOf(f.profile.address)).toBe(true);
    });
  });

  describe('reconcile', () => {
    it('adopts server values for unchanged fields', () => {
      const { f, model } = setup();
      reconcile(f, {
        ...initial(),
        name: 'zoe',
        profile: { age: 41, address: { city: 'la', zip: '90001' } },
      });
      expect(model().name).toBe('zoe');
      expect(model().profile.age).toBe(41);
      expect(changedOf(f)).toBe(false); // adopted as the new baseline
    });

    it('preserves an in-flight edit while adopting server changes for siblings', () => {
      const { f, model } = setup();
      f.name().value.set('myEdit'); // changed locally
      reconcile(f, {
        ...initial(),
        name: 'serverName',
        profile: { age: 99, address: { city: 'nyc', zip: '10001' } },
      });

      expect(model().name).toBe('myEdit'); // edit preserved
      expect(model().profile.age).toBe(99); // sibling adopted
      expect(changedOf(f.name)).toBe(true); // still changed vs new baseline
      expect(changedOf(f.profile.age)).toBe(false);
    });

    it('clears a kept edit if the server caught up to it (rebaseline)', () => {
      const { f } = setup();
      f.name().value.set('samesame');
      reconcile(f, { ...initial(), name: 'samesame' });
      expect(changedOf(f.name)).toBe(false); // baseline := incoming === current edit
    });

    it('rebaselines items along with the array on a kept-edit reconcile', () => {
      const { f, model } = setup();
      f.tags[0]().value.set('z'); // array now changed → kept as a unit
      reconcile(f, { ...initial(), tags: ['A', 'B'] });

      expect(model().tags).toEqual(['z', 'b']); // edit kept
      expect(changedOf(f.tags)).toBe(true);
      expect(changedOf(f.tags[0])).toBe(true); // 'z' vs new baseline 'A'
      expect(changedOf(f.tags[1])).toBe(true); // 'b' vs new baseline 'B' — agrees with the array

      f.tags[1]().value.set('B');
      expect(changedOf(f.tags[1])).toBe(false);
      f.tags[0]().value.set('A'); // catch up to the server
      expect(changedOf(f.tags)).toBe(false);
    });

    it('gives a locally added item past the incoming length an undefined baseline', () => {
      const { f, model } = setup();
      model.update((m) => ({
        ...m,
        contacts: [...m.contacts, { email: 'new@x.com', primary: false }],
      }));
      reconcile(f, initial()); // server still has 2 contacts

      expect(model().contacts).toHaveLength(3); // kept as a unit
      expect(changedOf(f.contacts)).toBe(true);
      expect(changedOf(f.contacts[0])).toBe(false); // rebaselined to incoming[0]
      expect(changedOf(f.contacts[1])).toBe(false);
      expect(changedOf(f.contacts[2])).toBe(true); // no server counterpart
    });

    it('rebaselines the subtree under a reconcileWith override', () => {
      const { f, model } = setup((p) =>
        reconcileWith(p.tags, ({ current }) => current),
      );
      reconcile(f, { ...initial(), tags: ['A', 'B'] });

      expect(model().tags).toEqual(['a', 'b']); // override kept local values
      expect(changedOf(f.tags)).toBe(true); // vs the new baseline
      expect(changedOf(f.tags[0])).toBe(true);
      f.tags[0]().value.set('A');
      expect(changedOf(f.tags[0])).toBe(false);
    });

    it('honors a reconcileWith override at a path', () => {
      const { f, model } = setup((p) =>
        // always concatenate current + incoming for name
        reconcileWith(
          p.name,
          ({ current, incoming }) => `${current}+${incoming}`,
        ),
      );
      reconcile(f, { ...initial(), name: 'srv' });
      expect(model().name).toBe('ann+srv');
    });
  });

  describe('auto-commit (default)', () => {
    it('adopts the initial model value as the baseline without commitChanges', () => {
      const { f } = setupAuto();
      expect(changedOf(f)).toBe(false);
      expect(changedOf(f.name)).toBe(false);
      expect(changedOf(f.profile.address.city)).toBe(false);
      expect(changedOf(f.contacts[0])).toBe(false);
    });

    it('still tracks edits against the auto baseline', () => {
      const { f } = setupAuto();
      f.name().value.set('bob');
      expect(changedOf(f.name)).toBe(true);
      expect(changedOf(f)).toBe(true);
      expect(changedOf(f.profile)).toBe(false);
    });
  });

  describe('manualCommit', () => {
    it('leaves pre-filled fields reading changed until commitChanges establishes the baseline', () => {
      const { f } = setupAuto({ manualCommit: true });
      expect(changedOf(f.name)).toBe(true); // baseline undefined vs 'ann'
      expect(changedOf(f)).toBe(true);

      commitChanges(f);
      expect(changedOf(f)).toBe(false);
      expect(changedOf(f.name)).toBe(false);
    });
  });
});

const [, injectTrackedField] = composition({ ...changeTracking<string>() });

@Directive({
  // eslint-disable-next-line @angular-eslint/directive-selector
  selector: 'input[formField]',
})
class TrackProbe {
  readonly field = injectTrackedField();
  readonly changed = injectChanged();
}

@Component({
  imports: [FormField, TrackProbe],
  template: `<input [formField]="f.name" />`,
})
class TrackHost {
  readonly model = signal({ name: 'ann', other: 'x' });
  readonly f = form(this.model, trackChanges(this.model));
  constructor() {
    commitChanges(this.f);
  }
}

describe('change tracking — compose integration', () => {
  function setupProbe() {
    const fixture = TestBed.createComponent(TrackHost);
    fixture.detectChanges();
    const probe = fixture.debugElement
      .query(By.directive(TrackProbe))
      .injector.get(TrackProbe);
    return { probe, host: fixture.componentInstance };
  }

  it('exposes changed as a signal and reset as a method', () => {
    const { probe } = setupProbe();
    expect(isSignal(probe.field.changed)).toBe(true);
    expect(typeof probe.field.reset).toBe('function');
  });

  it('reflects edits through the composed and standalone readers', () => {
    const { probe, host } = setupProbe();
    expect(probe.field.changed()).toBe(false);
    expect(probe.changed()).toBe(false);
    host.f.name().value.set('bob');
    expect(probe.field.changed()).toBe(true);
    expect(probe.changed()).toBe(true);
  });

  it('reset() reverts the field to its baseline', () => {
    const { probe, host } = setupProbe();
    host.f.name().value.set('bob');
    probe.field.reset();
    expect(host.model().name).toBe('ann');
    expect(probe.field.changed()).toBe(false);
  });

  it('reset(initial) adopts a new baseline', () => {
    const { probe, host } = setupProbe();
    probe.field.reset('zed');
    expect(host.model().name).toBe('zed');
    expect(probe.field.changed()).toBe(false);
    host.f.name().value.set('zed2');
    expect(probe.field.changed()).toBe(true);
  });
});
