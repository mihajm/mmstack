import {
  computed,
  type ResourceRef,
  type ResourceSnapshot,
  type Signal,
  signal,
} from '@angular/core';
import { TestBed } from '@angular/core/testing';
import {
  NavigationCancel,
  NavigationCancellationCode,
  NavigationEnd,
  NavigationError,
  NavigationSkipped,
  NavigationSkippedCode,
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

/**
 * Test double shaped like the read surface `holdThroughNavigation` consumes — including the part
 * that bites: a real resource THROWS from `value()` while it is in the error state.
 */
function snapshotBackedResource<T>(snapshot: Signal<ResourceSnapshot<T>>) {
  return {
    status: computed(() => snapshot().status),
    value: computed(() => {
      const s = snapshot();
      if (s.status === 'error') throw s.error;
      return s.value;
    }),
    error: computed(() => {
      const s = snapshot();
      return s.status === 'error' ? s.error : undefined;
    }),
  };
}

function setup<T>(
  initial: ResourceSnapshot<T>,
  reload: () => boolean = () => true,
) {
  const events = new Subject<unknown>();
  TestBed.configureTestingModule({
    providers: [{ provide: Router, useValue: { events } }],
  });
  const snapshot = signal<ResourceSnapshot<T>>(initial);
  const source = {
    ...snapshotBackedResource(snapshot),
    reload,
  } as unknown as ResourceRef<T>;
  const held = TestBed.runInInjectionContext(() =>
    holdThroughNavigation(source),
  );
  return { events, snapshot, held };
}

describe('holdThroughNavigation', () => {
  it('surfaces an errored resource without reading its value', () => {
    const boom = new Error('boom');
    const { snapshot, held } = setup(resolved('a'));

    snapshot.set({ status: 'error', error: boom });

    expect(held.status()).toBe('error');
    expect(held.error()).toBe(boom);
    expect(held.value()).toBeUndefined();
    expect(held.hasValue()).toBe(false);
  });

  it('holds the last good value through a navigation that errors the resource', () => {
    const boom = new Error('boom');
    const { events, snapshot, held } = setup(resolved('a'));

    events.next(new NavigationStart(1, '/x'));
    snapshot.set({ status: 'error', error: boom });
    expect(held.value()).toBe('a');
    expect(held.error()).toBeUndefined();

    events.next(new NavigationEnd(1, '/x', '/x'));
    expect(held.error()).toBe(boom);
  });

  it('passes state through when not navigating', () => {
    const { snapshot, held } = setup(resolved('a'));
    expect(held.value()).toBe('a');
    snapshot.set(resolved('b'));
    expect(held.value()).toBe('b');
  });

  it('freezes during a navigation and reveals the new state on success', () => {
    const { events, snapshot, held } = setup(resolved('a'));

    events.next(new NavigationStart(1, '/x'));
    snapshot.set(loading('a'));
    expect(held.value()).toBe('a');
    expect(held.isLoading()).toBe(false);

    snapshot.set(resolved('b'));
    events.next(new NavigationEnd(1, '/x', '/x'));
    expect(held.value()).toBe('b');
  });

  it('reveals on NavigationSkipped (treated like success)', () => {
    const { events, snapshot, held } = setup(resolved('a'));
    events.next(new NavigationStart(1, '/x'));
    snapshot.set(resolved('b'));
    expect(held.value()).toBe('a');
    events.next(
      new NavigationSkipped(
        1,
        '/x',
        '',
        NavigationSkippedCode.IgnoredSameUrlNavigation,
      ),
    );
    expect(held.value()).toBe('b');
  });

  it('rolls back on NavigationError, holding until the load settles', () => {
    const { events, snapshot, held } = setup(resolved('a'));

    events.next(new NavigationStart(1, '/y'));
    snapshot.set(loading('partial'));
    events.next(new NavigationError(1, '/y', new Error('boom')));
    expect(held.value()).toBe('a');

    snapshot.set(resolved('a'));
    expect(held.value()).toBe('a');
  });

  it('rolls back on a guard-rejected cancel', () => {
    const { events, snapshot, held } = setup(resolved('a'));

    events.next(new NavigationStart(1, '/y'));
    snapshot.set(loading('partial'));
    events.next(
      new NavigationCancel(
        1,
        '/y',
        '',
        NavigationCancellationCode.GuardRejected,
      ),
    );
    expect(held.value()).toBe('a');
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
    expect(held.value()).toBe('a');

    events.next(new NavigationStart(2, '/z'));
    expect(held.value()).toBe('a');
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

  describe('settle-aware reveal (post-NavigationEnd refetch)', () => {
    it('holds through a refetch that starts after NavigationEnd', () => {
      const { events, snapshot, held } = setup(resolved('a'));

      events.next(new NavigationStart(1, '/users/2'));
      events.next(new NavigationEnd(1, '/users/2', '/users/2'));
      expect(held.value()).toBe('a');

      snapshot.set(loading(undefined as unknown as string));
      expect(held.value()).toBe('a');
      expect(held.isLoading()).toBe(false);

      snapshot.set(resolved('b'));
      expect(held.value()).toBe('b');
    });

    it('after the cycle completes, a later load passes through live (reload indicator visible)', () => {
      const { events, snapshot, held } = setup(resolved('a'));

      events.next(new NavigationStart(1, '/x'));
      events.next(new NavigationEnd(1, '/x', '/x'));
      snapshot.set(loading('a'));
      expect(held.value()).toBe('a');
      snapshot.set(resolved('b'));
      expect(held.value()).toBe('b');

      snapshot.set(loading('b'));
      expect(held.isLoading()).toBe(true);
    });

    it('holds at the LAST SETTLED snapshot, not the pre-navigation one', () => {
      const { events, snapshot, held } = setup(resolved('a'));

      events.next(new NavigationStart(1, '/x'));
      snapshot.set(resolved('b'));
      events.next(new NavigationEnd(1, '/x', '/x'));
      expect(held.value()).toBe('b');

      snapshot.set(loading(undefined as unknown as string));
      expect(held.value()).toBe('b');

      snapshot.set(resolved('c'));
      expect(held.value()).toBe('c');
    });

    it('a navigation starting mid-hold freezes at the held value', () => {
      const { events, snapshot, held } = setup(resolved('a'));

      events.next(new NavigationStart(1, '/x'));
      events.next(new NavigationEnd(1, '/x', '/x'));
      snapshot.set(loading(undefined as unknown as string));
      expect(held.value()).toBe('a');

      events.next(new NavigationStart(2, '/y'));
      expect(held.value()).toBe('a');
      events.next(new NavigationEnd(2, '/y', '/y'));
      snapshot.set(resolved('d'));
      expect(held.value()).toBe('d');
    });
  });
});

const start = (id: number) => new NavigationStart(id, '/x');
const end = (id: number) => new NavigationEnd(id, '/x', '/x');
const cancel = (id: number, code: NavigationCancellationCode) =>
  new NavigationCancel(id, '/x', '', code);

describe('holdThroughNavigation contract', () => {
  it('passes a load through before the first navigation', () => {
    const { snapshot, held } = setup(resolved('a'));
    expect(held.value()).toBe('a');
    snapshot.set(loading('a'));
    expect(held.isLoading()).toBe(true);
  });

  it('a redirect chain first read mid-chain still shows the pre-navigation state', () => {
    const { events, snapshot, held } = setup(resolved('a'));
    events.next(start(1));
    snapshot.set(loading('partial'));
    events.next(cancel(1, NavigationCancellationCode.Redirect));
    events.next(start(2));
    expect(held.value()).toBe('a');
    expect(held.isLoading()).toBe(false);
  });

  it('a real NavigationSkipped after a superseded cancel reveals the new state', () => {
    const { events, snapshot, held } = setup(resolved('a'));
    events.next(start(1));
    events.next(
      cancel(1, NavigationCancellationCode.SupersededByNewNavigation),
    );
    snapshot.set(resolved('b'));
    expect(held.value()).toBe('a');
    events.next(
      new NavigationSkipped(
        2,
        '/x',
        '',
        NavigationSkippedCode.IgnoredSameUrlNavigation,
      ),
    );
    expect(held.value()).toBe('b');
  });

  it('a guard-rejected cancel tracks live again once the rollback settles', () => {
    const { events, snapshot, held } = setup(resolved('a'));
    events.next(start(1));
    snapshot.set(loading('partial'));
    events.next(cancel(1, NavigationCancellationCode.GuardRejected));
    snapshot.set(resolved('a'));
    expect(held.value()).toBe('a');
    snapshot.set(resolved('b'));
    expect(held.value()).toBe('b');
  });

  it('a superseded cancel stays frozen until the next navigation', () => {
    const { events, snapshot, held } = setup(resolved('a'));
    events.next(start(1));
    snapshot.set(loading('partial'));
    expect(held.value()).toBe('a');
    events.next(
      cancel(1, NavigationCancellationCode.SupersededByNewNavigation),
    );
    snapshot.set(resolved('mid'));
    expect(held.value()).toBe('a');
  });

  it('a redirect cancel stays frozen until the next navigation', () => {
    const { events, snapshot, held } = setup(resolved('a'));
    events.next(start(1));
    snapshot.set(loading('partial'));
    expect(held.value()).toBe('a');
    events.next(cancel(1, NavigationCancellationCode.Redirect));
    snapshot.set(resolved('mid'));
    expect(held.value()).toBe('a');
  });

  it('after a rollback completes its cycle, a later reload shows its indicator', () => {
    const { events, snapshot, held } = setup(resolved('a'));
    events.next(start(1));
    events.next(cancel(1, NavigationCancellationCode.GuardRejected));
    snapshot.set(loading('a'));
    expect(held.isLoading()).toBe(false);
    snapshot.set(resolved('a'));
    expect(held.value()).toBe('a');
    snapshot.set(loading('a'));
    expect(held.isLoading()).toBe(true);
  });

  it('a load that finished before NavigationEnd does not count: the first refetch after it is held', () => {
    const { events, snapshot, held } = setup(resolved('a'));
    events.next(start(1));
    snapshot.set(loading('a'));
    expect(held.isLoading()).toBe(false);
    snapshot.set(resolved('b'));
    events.next(end(1));
    expect(held.value()).toBe('b');
    snapshot.set(loading('b'));
    expect(held.isLoading()).toBe(false);
  });

  it('once the cycle completed, every later load passes through', () => {
    const { events, snapshot, held } = setup(resolved('a'));
    events.next(start(1));
    events.next(end(1));
    snapshot.set(loading('a'));
    expect(held.value()).toBe('a');
    snapshot.set(resolved('b'));
    expect(held.value()).toBe('b');
    snapshot.set(loading('b'));
    expect(held.isLoading()).toBe(true);
    snapshot.set(loading('x'));
    expect(held.value()).toBe('x');
    snapshot.set(resolved('c'));
    expect(held.value()).toBe('c');
    snapshot.set(loading('c'));
    expect(held.isLoading()).toBe(true);
  });

  it('holds through every change of the cycle while it is still loading', () => {
    const { events, snapshot, held } = setup(resolved('a'));
    events.next(start(1));
    events.next(end(1));
    snapshot.set(loading(undefined as unknown as string));
    expect(held.value()).toBe('a');
    snapshot.set({
      status: 'reloading',
      value: undefined as unknown as string,
    });
    expect(held.isLoading()).toBe(false);
    expect(held.value()).toBe('a');
  });

  it('reload() is delegated to the source', () => {
    const reload = vi.fn(() => true);
    const { held } = setup(resolved('a'), reload);
    expect(held.reload()).toBe(true);
    expect(reload).toHaveBeenCalledTimes(1);
  });
});
