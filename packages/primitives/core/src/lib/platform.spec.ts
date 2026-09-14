import { isPlatformBrowser, isPlatformServer } from '@angular/common';
import { Injector, PLATFORM_ID } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { isBrowser, isServer } from './platform';

// Angular's platform ids. `isPlatformServer`/`isPlatformBrowser` from `@angular/common` are the
// reference; the library's own checks must agree with them for every id so `@angular/common`
// never has to be imported outside specs.
const PLATFORM_IDS = ['browser', 'server', 'browserWorkerApp', 'unknown', ''];

describe('platform', () => {
  describe.each(PLATFORM_IDS)('PLATFORM_ID = %j', (id) => {
    it('isServer agrees with @angular/common in an injection context', () => {
      TestBed.configureTestingModule({
        providers: [{ provide: PLATFORM_ID, useValue: id }],
      });
      TestBed.runInInjectionContext(() => {
        expect(isServer()).toBe(isPlatformServer(id));
        expect(isBrowser()).toBe(isPlatformBrowser(id));
      });
    });

    it('isServer agrees with @angular/common through an explicit injector', () => {
      const injector = Injector.create({
        providers: [{ provide: PLATFORM_ID, useValue: id }],
      });
      expect(isServer(injector)).toBe(isPlatformServer(id));
      expect(isBrowser(injector)).toBe(isPlatformBrowser(id));
    });
  });

  it('an unresolved platform id is neither server nor browser', () => {
    const bare = Injector.create({ providers: [] });
    expect(isServer(bare)).toBe(false);
    expect(isBrowser(bare)).toBe(false);
  });
});
