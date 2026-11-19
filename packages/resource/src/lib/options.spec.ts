import { provideHttpClient } from '@angular/common/http';
import {
  HttpTestingController,
  provideHttpClientTesting,
} from '@angular/common/http/testing';
import {
  createEnvironmentInjector,
  EnvironmentInjector,
  type Provider,
} from '@angular/core';
import { TestBed } from '@angular/core/testing';
import {
  injectTransitionScope,
  provideTransitionScope,
} from '@mmstack/primitives';
import { provideResourceOptions } from './options';
import { mutationResource } from './mutation-resource';
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
  it('the factory form of provideResourceOptions applies too', () => {
    setup([provideResourceOptions(() => ({ register: 'indicator' }))]);
    TestBed.runInInjectionContext(() => {
      const scope = injectTransitionScope();
      queryResource(() => 'https://example.test/a');
      expect(scope.resources().length).toBe(1);
    });
  });

  it("only a mutation with register: 'suspend' gets the suspend warning", () => {
    setup([]);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    TestBed.runInInjectionContext(() => {
      queryResource(() => 'https://example.test/a', { register: 'suspend' });
      mutationResource(() => ({ url: 'https://example.test/m' }), {
        register: 'indicator',
      });
    });
    const suspendWarnings = warn.mock.calls.filter((c) =>
      String(c[0]).includes("'suspend'"),
    );
    expect(suspendWarnings).toEqual([]);
    warn.mockRestore();
  });

  it('a resource created in a child injector leaves the scope when that injector is destroyed', () => {
    setup([]);
    const scope = TestBed.runInInjectionContext(() => injectTransitionScope());
    const child = createEnvironmentInjector(
      [],
      TestBed.inject(EnvironmentInjector),
    );
    queryResource(() => 'https://example.test/a', {
      register: 'indicator',
      injector: child,
    });
    expect(scope.resources().length).toBe(1);
    child.destroy();
    expect(scope.resources().length).toBe(0);
  });

  it('destroy() on a registered resource also stops it', () => {
    setup([]);
    const res = TestBed.runInInjectionContext(() =>
      queryResource(() => 'https://example.test/a', { register: 'indicator' }),
    );
    TestBed.tick();
    const http = TestBed.inject(HttpTestingController);
    const req = http.expectOne('https://example.test/a');
    res.destroy();
    expect(res.status()).toBe('idle');
    expect(req.cancelled).toBe(true);
  });
});
