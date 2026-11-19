import {
  Component,
  Directive,
  signal,
  type WritableSignal,
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
import {
  CHANGED,
  changedWith,
  commitChanges,
  injectChanged,
  resetChanged,
  trackChanges,
} from './changed';

function changedOf(tree: FieldTree<unknown> | undefined): boolean {
  return tree?.().metadata(CHANGED)?.changed() ?? false;
}

function tracked<T>(value: T, schema?: SchemaFn<T>) {
  return TestBed.runInInjectionContext(() => {
    const model: WritableSignal<T> = signal(value);
    const track = trackChanges(model);
    const f = form(model, (p) => {
      schema?.(p);
      track(p);
    });
    commitChanges(f as FieldTree<unknown>);
    return { model, f };
  });
}

describe('changed: nested values inside array items', () => {
  type Row = { cells: number[] };

  it('a deep clone of the rows reads unchanged', () => {
    const { model, f } = tracked<{ rows: Row[] }>({
      rows: [{ cells: [1, 2] }],
    });
    model.set(structuredClone(model()));
    expect(changedOf(f.rows)).toBe(false);
    expect(changedOf(f)).toBe(false);
  });

  it.each([
    ['shrinks', [1]],
    ['changes one cell', [1, 3]],
  ])('a nested array that %s reads changed', (_, cells) => {
    const { model, f } = tracked<{ rows: Row[] }>({
      rows: [{ cells: [1, 2] }],
    });
    model.set({ rows: [{ cells }] });
    expect(changedOf(f.rows)).toBe(true);
  });

  it('null to array inside an item reads changed', () => {
    const { model, f } = tracked<{ arr: (number[] | null)[] }>({ arr: [null] });
    model.set({ arr: [[1]] });
    expect(changedOf(f.arr)).toBe(true);
  });

  it('null to record inside an item reads changed', () => {
    const { model, f } = tracked<{ items: ({ a: number } | null)[] }>({
      items: [null],
    });
    model.set({ items: [{ a: 1 }] });
    expect(changedOf(f.items)).toBe(true);
  });

  it('an item losing an optional key reads changed', () => {
    type C = { email: string; primary?: boolean };
    const { model, f } = tracked<{ contacts: C[] }>({
      contacts: [{ email: 'a', primary: true }],
    });
    model.set({ contacts: [{ email: 'a' }] });
    expect(changedOf(f.contacts)).toBe(true);
  });

  it('an undefined item reads changed against its baseline', () => {
    const { model, f } = tracked<{ arr: (string | undefined)[] }>({
      arr: ['x', 'y'],
    });
    model.set({ arr: [undefined, 'y'] });
    expect(changedOf(f.arr)).toBe(true);
  });

  it('an item-level changedWith applies at equal length', () => {
    type C = { email: string };
    const { model, f } = tracked<{ contacts: C[] }>(
      { contacts: [{ email: 'a' }] },
      (p) => applyEach(p.contacts, (c) => changedWith(c, () => false)),
    );
    model.set({ contacts: [{ email: 'b' }] });
    expect(changedOf(f.contacts)).toBe(false);
  });
});

describe('changed: undefined values', () => {
  it('clearing an optional key reads changed at the parent', () => {
    const { f } = tracked<{ name: string; nick?: string | undefined }>({
      name: 'n',
      nick: 'x',
    });
    f.nick!().value.set(undefined as unknown as string);
    expect(changedOf(f)).toBe(true);
  });

  it('auto-commit seeds a model with an undefined key without throwing', () => {
    const { f, model } = TestBed.runInInjectionContext(() => {
      const model = signal<{ name: string; nick?: string }>({
        name: 'n',
        nick: undefined,
      });
      return { model, f: form(model, trackChanges(model)) };
    });
    TestBed.tick();
    expect(changedOf(f)).toBe(false);
    model.update((m) => ({ ...m, name: 'm' }));
    expect(changedOf(f)).toBe(true);
  });
});

describe('changed: manualCommit and later nodes', () => {
  it('an array field reads changed before the first commit', () => {
    const { f } = TestBed.runInInjectionContext(() => {
      const model = signal({ tags: ['a'], name: 'n' });
      return { f: form(model, trackChanges(model, { manualCommit: true })) };
    });
    TestBed.tick();
    expect(changedOf(f.tags)).toBe(true);
  });

  it('an item pushed after init stays changed across effect flushes', () => {
    const { model, f } = TestBed.runInInjectionContext(() => {
      const model = signal({ contacts: [{ email: 'a' }, { email: 'b' }] });
      return { model, f: form(model, trackChanges(model)) };
    });
    TestBed.tick();
    model.update((m) => ({ contacts: [...m.contacts, { email: 'c' }] }));
    expect(changedOf(f.contacts[2])).toBe(true);
    TestBed.tick();
    expect(changedOf(f.contacts[2])).toBe(true);
    expect(changedOf(f.contacts)).toBe(true);
  });
});

describe('changed projector on an untracked form', () => {
  @Directive({ selector: 'input[formField]' })
  class Probe {
    readonly changed = injectChanged();
  }

  @Component({
    imports: [FormField, Probe],
    template: `<input [formField]="f.name" />`,
  })
  class Host {
    readonly model = signal({ name: 'x' });
    readonly f = form(this.model);
  }

  it('reads false instead of throwing', () => {
    const fixture = TestBed.createComponent(Host);
    fixture.detectChanges();
    const probe = fixture.debugElement
      .query(By.directive(Probe))
      .injector.get(Probe);
    expect(probe.changed()).toBe(false);
    fixture.componentInstance.model.set({ name: 'y' });
    expect(probe.changed()).toBe(false);
  });
});

describe('resetChanged on an untracked form', () => {
  it('is a no-op', () => {
    const { model, f } = TestBed.runInInjectionContext(() => {
      const model = signal({ name: 'x' });
      return { model, f: form(model) };
    });
    model.set({ name: 'y' });
    expect(() => resetChanged(f)).not.toThrow();
    expect(model()).toEqual({ name: 'y' });
  });
});
