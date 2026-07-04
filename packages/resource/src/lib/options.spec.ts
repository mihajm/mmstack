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
      provideTransitionScope(),
      ...extra,
    ],
  });
}

describe('resource options injection + auto-register', () => {
  it("per-call register: 'indicator' adds the resource to the nearest transition scope", () => {
    setup([]);
    TestBed.runInInjectionContext(() => {
      const scope = injectTransitionScope();
      expect(scope.resources().length).toBe(0);
      queryResource(() => 'https://example.test/a', { register: 'indicator' });
      expect(scope.resources().length).toBe(1);
      expect(scope.suspended('value')).toBe(false);
    });
  });

  it("per-call register: 'suspend' registers as suspending (blocks first paint)", () => {
    setup([]);
    TestBed.runInInjectionContext(() => {
      const scope = injectTransitionScope();
      queryResource(() => 'https://example.test/a', { register: 'suspend' });
      expect(scope.resources().length).toBe(1);
      expect(scope.suspended('value')).toBe(true);
    });
  });

  it("provideResourceOptions({ register: 'indicator' }) makes resources auto-register by default", () => {
    setup([provideResourceOptions({ register: 'indicator' })]);
    TestBed.runInInjectionContext(() => {
      const scope = injectTransitionScope();
      queryResource(() => 'https://example.test/a');
      expect(scope.resources().length).toBe(1);
    });
  });

  it('per-call register: false opts out of a provider default', () => {
    setup([provideResourceOptions({ register: 'indicator' })]);
    TestBed.runInInjectionContext(() => {
      const scope = injectTransitionScope();
      queryResource(() => 'https://example.test/a', { register: false });
      expect(scope.resources().length).toBe(0);
    });
  });

  it('precedence: provideQueryResourceOptions overrides provideResourceOptions', () => {
    setup([
      provideResourceOptions({ register: 'indicator' }),
      provideQueryResourceOptions({ register: false }),
    ]);
    TestBed.runInInjectionContext(() => {
      const scope = injectTransitionScope();
      queryResource(() => 'https://example.test/a');
      expect(scope.resources().length).toBe(0);
    });
  });

  it("a manually destroyed resource leaves the scope (doesn't wait for injector teardown)", () => {
    setup([]);
    TestBed.runInInjectionContext(() => {
      const scope = injectTransitionScope();
      const res = queryResource(() => 'https://example.test/a', {
        register: 'indicator',
      });
      expect(scope.resources().length).toBe(1);

      res.destroy();
      expect(scope.resources().length).toBe(0);
    });
  });
});
