import { provideHttpClient } from '@angular/common/http';
import { provideHttpClientTesting } from '@angular/common/http/testing';
import { type Provider } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import {
  injectTransitionScope,
  provideTransitionScope,
} from '@mmstack/primitives';
import { provideResourceOptions } from './options';
import { provideQueryResourceOptions, queryResource } from './query-resource';
import { provideQueryCache } from './util';

function setup(extra: Provider[]) {
  TestBed.configureTestingModule({
    providers: [
      provideHttpClient(),
      provideHttpClientTesting(),
      provideQueryCache(),
      provideTransitionScope(), // a scope for resources to register into
      ...extra,
    ],
  });
}

describe('resource options injection + auto-register', () => {
  it('per-call register: true adds the resource to the nearest transition scope', () => {
    setup([]);
    TestBed.runInInjectionContext(() => {
      const scope = injectTransitionScope();
      expect(scope.resources().length).toBe(0);
      queryResource(() => 'https://example.test/a', { register: true });
      expect(scope.resources().length).toBe(1);
    });
  });

  it('provideResourceOptions({ register: true }) makes resources auto-register by default', () => {
    setup([provideResourceOptions({ register: true })]);
    TestBed.runInInjectionContext(() => {
      const scope = injectTransitionScope();
      queryResource(() => 'https://example.test/a'); // no per-call register → inherits default
      expect(scope.resources().length).toBe(1);
    });
  });

  it('per-call register: false opts out of a provider default', () => {
    setup([provideResourceOptions({ register: true })]);
    TestBed.runInInjectionContext(() => {
      const scope = injectTransitionScope();
      queryResource(() => 'https://example.test/a', { register: false });
      expect(scope.resources().length).toBe(0);
    });
  });

  it('precedence: provideQueryResourceOptions overrides provideResourceOptions', () => {
    setup([
      provideResourceOptions({ register: true }),
      provideQueryResourceOptions({ register: false }),
    ]);
    TestBed.runInInjectionContext(() => {
      const scope = injectTransitionScope();
      queryResource(() => 'https://example.test/a'); // query layer (false) overrides general (true)
      expect(scope.resources().length).toBe(0);
    });
  });
});
