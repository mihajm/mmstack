import {
  Component,
  Directive,
  signal,
  type WritableSignal,
} from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { form, FormField, type FieldTree } from '@angular/forms/signals';
import { By } from '@angular/platform-browser';
import { composition } from '../compose/compose';
import {
  CHANGED,
  commitChanges,
  reconcile,
  reconciliation,
  trackChanges,
} from './changed';
import { changedValues } from './changed-values';
import { submitChanges } from './submit-changes';

function changedOf(tree: FieldTree<unknown> | undefined): boolean {
  return tree?.().metadata(CHANGED)?.changed() ?? false;
}

function tracked<T>(value: T) {
  return TestBed.runInInjectionContext(() => {
    const model: WritableSignal<T> = signal(value);
    const f = form(model, trackChanges(model));
    commitChanges(f as FieldTree<unknown>);
    return { model, f };
  });
}

function fakeMutation() {
  const calls: unknown[] = [];
  let deferred: PromiseWithResolvers<unknown> | null = null;
  return {
    calls,
    mutateAsync: (value: unknown) => {
      calls.push(value);
      deferred = Promise.withResolvers<unknown>();
      return deferred.promise;
    },
    resolve: (value: unknown) => deferred?.resolve(value),
  };
}

async function saveAndResolve<T>(
  f: FieldTree<T>,
  opts?: { payload: 'full' },
  result?: unknown,
) {
  const mutation = fakeMutation();
  const pending = opts
    ? submitChanges(f, mutation, opts)()
    : submitChanges(f, mutation)();
  mutation.resolve(result);
  return { ok: await pending, calls: mutation.calls };
}

describe('reconcile: shapes without tracked children', () => {
  it('an untracked dict key adopts the incoming value', () => {
    const { model, f } = tracked<{ dict: Record<string, number> }>({
      dict: { a: 1 },
    });
    model.set({ dict: { a: 1, c: 3 } });
    commitChanges(f as FieldTree<unknown>);
    reconcile(f, { dict: { a: 1, c: 7 } });
    expect(model().dict['c']).toBe(7);
    expect(changedOf(f)).toBe(false);
  });

  it('null to a server object is adopted', () => {
    const { model, f } = tracked<{ address: { city: string } | null }>({
      address: null,
    });
    reconcile(f, { address: { city: 'x' } });
    expect(model().address).toEqual({ city: 'x' });
    expect(changedOf(f)).toBe(false);
  });

  it('a record under an initially null field reconciles without throwing', () => {
    type Geo = { geo: { lat: number } };
    const { model, f } = tracked<{ address: Geo | null }>({ address: null });
    model.set({ address: { geo: { lat: 1 } } });
    commitChanges(f as FieldTree<unknown>);
    reconcile(f, { address: { geo: { lat: 2 } } });
    expect(model().address?.geo.lat).toBe(2);
    expect(changedOf(f)).toBe(false);
  });
});

describe('reconciliation() fragment', () => {
  const [, injectRec] = composition({ ...reconciliation<string>() });

  @Directive({ selector: 'input[formField]' })
  class Probe {
    readonly field = injectRec();
  }

  @Component({
    imports: [FormField, Probe],
    template: `<input [formField]="f.name" />`,
  })
  class Host {
    readonly model = signal({ name: 'a' });
    readonly f = form(this.model, trackChanges(this.model));
  }

  function setup() {
    const fixture = TestBed.createComponent(Host);
    fixture.detectChanges();
    TestBed.tick();
    const probe = fixture.debugElement
      .query(By.directive(Probe))
      .injector.get(Probe);
    return { host: fixture.componentInstance, field: probe.field };
  }

  it('an unchanged field adopts the incoming value', () => {
    const { host, field } = setup();
    field.reconcile('srv');
    expect(host.model().name).toBe('srv');
    expect(field.changed()).toBe(false);
  });

  it('a changed field keeps the edit and reads changed against the incoming value', () => {
    const { host, field } = setup();
    host.f.name().value.set('mine');
    field.reconcile('srv');
    expect(host.model().name).toBe('mine');
    expect(field.changed()).toBe(true);
  });
});

describe('submitChanges: post-save state', () => {
  it("payload 'full' leaves every level clean", async () => {
    const { f } = tracked({ name: 'ann', age: 30, profile: { city: 'nyc' } });
    f.name().value.set('bob');
    f.profile.city().value.set('sf');
    const { ok } = await saveAndResolve(f, { payload: 'full' });
    expect(ok).toBe(true);
    expect(changedOf(f)).toBe(false);
    expect(changedOf(f.name)).toBe(false);
    expect(changedOf(f.profile.city)).toBe(false);
  });

  it("payload 'full' with an undefined key resolves and stays clean", async () => {
    const { f } = tracked<{ name: string; nick?: string }>({
      name: 'ann',
      nick: undefined,
    });
    f.name().value.set('bob');
    const { ok } = await saveAndResolve(f, { payload: 'full' });
    expect(ok).toBe(true);
    expect(changedOf(f)).toBe(false);
  });

  it('an edited untracked dict key is saved', async () => {
    const { model, f } = tracked<{ dict: Record<string, number> }>({
      dict: { a: 1 },
    });
    model.set({ dict: { a: 1, c: 3 } });
    commitChanges(f as FieldTree<unknown>);
    f.dict['c']().value.set(4);
    const { ok, calls } = await saveAndResolve(f);
    expect(calls).toEqual([{ dict: { c: 4 } }]);
    expect(ok).toBe(true);
    expect(changedOf(f)).toBe(false);
  });

  it('an array unit with an undefined item is saved', async () => {
    const { f } = tracked<{ arr: (string | undefined)[] }>({
      arr: [undefined, 'y'],
    });
    f.arr[1]!().value.set('z');
    const { ok } = await saveAndResolve(f);
    expect(ok).toBe(true);
    expect(changedOf(f)).toBe(false);
  });

  it('a leaf set to null is saved', async () => {
    const { f } = tracked<{ name: string | null }>({ name: 'a' });
    f.name().value.set(null);
    const { ok, calls } = await saveAndResolve(f);
    expect(calls).toEqual([{ name: null }]);
    expect(ok).toBe(true);
    expect(changedOf(f)).toBe(false);
    expect(changedValues(f)).toBeUndefined();
  });

  it("the default 'commit' does not merge the mutation result", async () => {
    const { f } = tracked({ name: 'ann', age: 30 });
    f.age().value.set(31);
    const { ok } = await saveAndResolve(f, undefined, { name: 'SERVER' });
    expect(ok).toBe(true);
    expect(f.name().value()).toBe('ann');
    expect(f.age().value()).toBe(31);
    expect(changedOf(f)).toBe(false);
  });
});
