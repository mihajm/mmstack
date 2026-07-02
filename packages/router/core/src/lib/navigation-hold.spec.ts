import {
  type ResourceRef,
  type ResourceSnapshot,
  signal,
} from '@angular/core';
import { TestBed } from '@angular/core/testing';
import {
  NavigationCancel,
  NavigationCancellationCode,
  NavigationEnd,
  NavigationError,
  NavigationSkipped,
  NavigationStart,
  Router,
} from '@angular/router';
import { Subject } from 'rxjs';
import { holdThroughNavigation } from './navigation-hold';

const resolved = <T>(value: T): ResourceSnapshot<T> => ({
  status: 'resolved',
  value,
});
const loading = <T>(value: T): ResourceSnapshot<T> => ({
  status: 'loading',
  value,
});

function setup<T>(initial: ResourceSnapshot<T>) {
  const events = new Subject<unknown>();
  TestBed.configureTestingModule({
    providers: [{ provide: Router, useValue: { events } }],
  });
  const snapshot = signal<ResourceSnapshot<T>>(initial);
  const source = { snapshot, reload: () => true } as unknown as ResourceRef<T>;
  const held = TestBed.runInInjectionContext(() => holdThroughNavigation(source));
  return { events, snapshot, held };
}

describe('holdThroughNavigation', () => {
  it('passes state through when not navigating', () => {
    const { snapshot, held } = setup(resolved('a'));
    expect(held.value()).toBe('a');
    snapshot.set(resolved('b'));
    expect(held.value()).toBe('b');
  });

  it('freezes during a navigation and reveals the new state on success', () => {
    const { events, snapshot, held } = setup(resolved('a'));

    events.next(new NavigationStart(1, '/x'));
    snapshot.set(loading('a')); // refetch lands mid-navigation
    expect(held.value()).toBe('a'); // frozen — no flash to loading
    expect(held.isLoading()).toBe(false);

    snapshot.set(resolved('b'));
    events.next(new NavigationEnd(1, '/x', '/x'));
    expect(held.value()).toBe('b'); // revealed on NavigationEnd
  });

  it('reveals on NavigationSkipped (treated like success)', () => {
    const { events, snapshot, held } = setup(resolved('a'));
    events.next(new NavigationStart(1, '/x'));
    snapshot.set(resolved('b'));
    expect(held.value()).toBe('a');
    events.next(
      new NavigationSkipped(1, '/x', undefined as never),
    );
    expect(held.value()).toBe('b');
  });

  it('rolls back on NavigationError, holding until the load settles', () => {
    const { events, snapshot, held } = setup(resolved('a'));

    events.next(new NavigationStart(1, '/y'));
    snapshot.set(loading('partial')); // would-be state of the route we abandon
    events.next(new NavigationError(1, '/y', new Error('boom')));
    expect(held.value()).toBe('a'); // held — still loading

    snapshot.set(resolved('a')); // settles back to the route we stayed on
    expect(held.value()).toBe('a'); // revealed cleanly
  });

  it('rolls back on a guard-rejected cancel', () => {
    const { events, snapshot, held } = setup(resolved('a'));

    events.next(new NavigationStart(1, '/y'));
    snapshot.set(loading('partial'));
    events.next(
      new NavigationCancel(1, '/y', '', NavigationCancellationCode.GuardRejected),
    );
    expect(held.value()).toBe('a'); // frozen while loading
    snapshot.set(resolved('a'));
    expect(held.value()).toBe('a');
  });

  it('does NOT roll back on a superseded cancel — stays frozen for the new navigation', () => {
    const { events, snapshot, held } = setup(resolved('a'));

    events.next(new NavigationStart(1, '/y'));
    snapshot.set(loading('partial'));
    events.next(
      new NavigationCancel(
        1,
        '/y',
        '',
        NavigationCancellationCode.SupersededByNewNavigation,
      ),
    );
    expect(held.value()).toBe('a'); // still frozen — not rolled back/revealed

    // the superseding navigation arrives and eventually completes
    events.next(new NavigationStart(2, '/z'));
    expect(held.value()).toBe('a'); // original snapshot kept across the supersede
    snapshot.set(resolved('z'));
    events.next(new NavigationEnd(2, '/z', '/z'));
    expect(held.value()).toBe('z');
  });

  it('tracks live again after a completed navigation', () => {
    const { events, snapshot, held } = setup(resolved('a'));
    events.next(new NavigationStart(1, '/x'));
    events.next(new NavigationEnd(1, '/x', '/x'));
    snapshot.set(resolved('b'));
    expect(held.value()).toBe('b');
    snapshot.set(resolved('c'));
    expect(held.value()).toBe('c');
  });

  // The navigation's refetch usually starts AFTER NavigationEnd (live params tick on it) —
  // the reveal must hold through that first load cycle, not flash it.
  describe('settle-aware reveal (post-NavigationEnd refetch)', () => {
    it('holds through a refetch that starts after NavigationEnd', () => {
      const { events, snapshot, held } = setup(resolved('a'));

      events.next(new NavigationStart(1, '/users/2'));
      events.next(new NavigationEnd(1, '/users/2', '/users/2'));
      expect(held.value()).toBe('a'); // revealed — same value, nothing loaded yet

      snapshot.set(loading(undefined as unknown as string)); // params ticked → refetch
      expect(held.value()).toBe('a'); // held — no flash
      expect(held.isLoading()).toBe(false);

      snapshot.set(resolved('b'));
      expect(held.value()).toBe('b'); // revealed on settle
    });

    it('after the cycle completes, a later load passes through live (reload indicator visible)', () => {
      const { events, snapshot, held } = setup(resolved('a'));

      events.next(new NavigationStart(1, '/x'));
      events.next(new NavigationEnd(1, '/x', '/x'));
      snapshot.set(loading('a'));
      // cycle tracking is observation-based (lazy computation) — a mounted template
      // reads every frame; the test stands in for it
      expect(held.value()).toBe('a');
      snapshot.set(resolved('b')); // navigation's cycle done
      expect(held.value()).toBe('b');

      snapshot.set(loading('b')); // an unrelated later load — passes through
      expect(held.isLoading()).toBe(true);
    });

    it('holds at the LAST SETTLED snapshot, not the pre-navigation one', () => {
      const { events, snapshot, held } = setup(resolved('a'));

      events.next(new NavigationStart(1, '/x'));
      snapshot.set(resolved('b')); // settled mid-navigation (e.g. a warm prefetch)
      events.next(new NavigationEnd(1, '/x', '/x'));
      expect(held.value()).toBe('b');

      snapshot.set(loading(undefined as unknown as string)); // post-nav refetch
      expect(held.value()).toBe('b'); // held at b — never back to a

      snapshot.set(resolved('c'));
      expect(held.value()).toBe('c');
    });

    it('a navigation starting mid-hold freezes at the held value', () => {
      const { events, snapshot, held } = setup(resolved('a'));

      events.next(new NavigationStart(1, '/x'));
      events.next(new NavigationEnd(1, '/x', '/x'));
      snapshot.set(loading(undefined as unknown as string)); // still settling…
      expect(held.value()).toBe('a');

      events.next(new NavigationStart(2, '/y')); // …when the next navigation begins
      expect(held.value()).toBe('a'); // frozen at what was displayed
      events.next(new NavigationEnd(2, '/y', '/y'));
      snapshot.set(resolved('d'));
      expect(held.value()).toBe('d');
    });
  });
});
