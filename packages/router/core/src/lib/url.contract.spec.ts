import { createEnvironmentInjector, EnvironmentInjector } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { NavigationEnd, type Router } from '@angular/router';
import { Subject } from 'rxjs';
import { navigationEndTick, url } from './url';

describe('url contract', () => {
  it('navigationEndTick starts at 0 and counts navigations up', () => {
    const events = new Subject<unknown>();
    const router = { events, url: '/' } as unknown as Router;
    const tick = TestBed.runInInjectionContext(() => navigationEndTick(router));
    expect(tick()).toBe(0);
    events.next(new NavigationEnd(1, '/a', '/a'));
    expect(tick()).toBe(1);
    events.next(new NavigationEnd(2, '/b', '/b'));
    expect(tick()).toBe(2);
  });

  it('both helpers work outside an injection context when given an injector', () => {
    const events = new Subject<unknown>();
    const router = { events, url: '/start' } as unknown as Router;
    const injector = createEnvironmentInjector(
      [],
      TestBed.inject(EnvironmentInjector),
    );
    const tick = navigationEndTick(router, injector);
    const current = url(router, { injector });
    events.next(new NavigationEnd(1, '/a', '/b'));
    expect(tick()).toBe(1);
    expect(current()).toBe('/b');
    injector.destroy();
  });
});
