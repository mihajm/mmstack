import {
  Component,
  computed,
  Directive,
  HostAttributeToken,
  Injectable,
  InjectionToken,
  signal,
  type Signal,
} from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { By } from '@angular/platform-browser';
import { injectLazy } from './inject-lazy';

describe('injectLazy', () => {
  it('should lazily instantiate the dependency', () => {
    let instanceCount = 0;

    @Injectable()
    class HeavyService {
      constructor() {
        instanceCount++;
      }
      doWork() {
        return 'done';
      }
    }

    TestBed.configureTestingModule({
      providers: [HeavyService],
    });

    let getHeavyService: (() => HeavyService) | undefined;

    TestBed.runInInjectionContext(() => {
      getHeavyService = injectLazy(HeavyService);
    });

    expect(instanceCount).toBe(0);

    assert(getHeavyService !== undefined, 'getHeavyService is not defined');

    const service = getHeavyService();

    expect(instanceCount).toBe(1);
    expect(service).toBeInstanceOf(HeavyService);
    expect(service.doWork()).toBe('done');

    const service2 = getHeavyService();
    expect(instanceCount).toBe(1);
    expect(service2).toBe(service);
  });

  it('should support optional resolution', () => {
    const MY_TOKEN = new InjectionToken<string>('MyToken');

    TestBed.configureTestingModule({});

    let getOptionalToken: (() => string | null) | undefined;

    TestBed.runInInjectionContext(() => {
      getOptionalToken = injectLazy(MY_TOKEN, { optional: true });
    });

    assert(getOptionalToken !== undefined, 'getOptionalToken is not defined');

    expect(getOptionalToken()).toBeNull();
  });

  it('should throw if dependency is required but missing', () => {
    const MY_TOKEN = new InjectionToken<string>('MissingToken');

    TestBed.configureTestingModule({});

    let getToken: (() => string) | undefined;

    TestBed.runInInjectionContext(() => {
      getToken = injectLazy(MY_TOKEN);
    });

    expect(() => {
      assert(getToken !== undefined, 'getToken is not defined');
      return getToken();
    }).toThrow();
  });

  it('should lazily resolve a HostAttributeToken', () => {
    // eslint-disable-next-line @angular-eslint/directive-selector
    @Directive({ selector: '[lazyAttr]' })
    class LazyAttrDirective {
      readonly getRole = injectLazy(new HostAttributeToken('role'));
    }

    @Component({
      template: `<div lazyAttr role="button"></div>`,
      imports: [LazyAttrDirective],
    })
    class HostCmp {}

    const fixture = TestBed.createComponent(HostCmp);
    fixture.detectChanges();

    const dir = fixture.debugElement
      .query(By.directive(LazyAttrDirective))
      .injector.get(LazyAttrDirective);

    expect(dir.getRole()).toBe('button');
    expect(dir.getRole()).toBe('button'); // cached
  });

  it('should correctly handle reactive contexts', () => {
    let getSignal: (() => Signal<number>) | undefined;

    const token = new InjectionToken<Signal<number>>('SignalToken');

    const sig = signal(1);

    TestBed.configureTestingModule({
      providers: [{ provide: token, useValue: sig }],
    });

    TestBed.runInInjectionContext(() => {
      getSignal = injectLazy(token);
    });

    const derivation = computed(() => {
      assert(getSignal !== undefined, 'getSignal is not defined');
      return getSignal()() + 1;
    });

    expect(derivation()).toBe(2);
    sig.set(2);
    expect(derivation()).toBe(3);
  });
});
