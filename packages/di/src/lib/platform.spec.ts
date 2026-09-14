import { isPlatformBrowser } from '@angular/common';
import { PLATFORM_ID } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { isBrowser } from './platform';

const PLATFORM_IDS = ['browser', 'server', 'browserWorkerApp', 'unknown', ''];

describe('platform', () => {
  it.each(PLATFORM_IDS)(
    'isBrowser agrees with @angular/common for %j',
    (id) => {
      TestBed.configureTestingModule({
        providers: [{ provide: PLATFORM_ID, useValue: id }],
      });
      TestBed.runInInjectionContext(() => {
        expect(isBrowser()).toBe(isPlatformBrowser(id));
      });
    },
  );
});
