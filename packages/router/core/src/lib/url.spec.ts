import { TestBed } from '@angular/core/testing';
import { EventType, Router } from '@angular/router';
import { Subject } from 'rxjs';
import { url } from './url';

describe('url', () => {
  let routerMock: Partial<Router>;
  let eventsSubject: Subject<EventType | any>;

  beforeEach(() => {
    eventsSubject = new Subject();
    routerMock = {
      url: '/initial',
      events: eventsSubject,
    };

    TestBed.configureTestingModule({
      providers: [{ provide: Router, useValue: routerMock }],
    });
  });

  it('should get initial url', () => {
    TestBed.runInInjectionContext(() => {
      const u = url();
      expect(u()).toBe('/initial');
    });
  });

  it('should use the provided router if passed in', () => {
    const mock = {
      ...routerMock,
      url: '/mocked',
    } as Router;

    const u = TestBed.runInInjectionContext(() => url(mock));
    expect(u()).toBe(mock.url);
  });

  it('should update url on navigation end', () => {
    let u: any;
    TestBed.runInInjectionContext(() => {
      u = url();
    });

    eventsSubject.next({
      type: EventType.NavigationEnd,
      urlAfterRedirects: '/home',
    });
    expect(u()).toBe('/home');

    eventsSubject.next({
      type: EventType.NavigationEnd,
      urlAfterRedirects: '/about',
    });
    expect(u()).toBe('/about');

    eventsSubject.next({ type: EventType.NavigationStart, url: '/other' });
    expect(u()).toBe('/about'); // Should not update on other event types
  });
});
