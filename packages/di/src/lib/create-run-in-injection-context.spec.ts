import { inject, InjectionToken, Injector } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { createRunInInjectionContext } from './create-run-in-injection-context';

describe('createRunInInjectionContext', () => {
  it('should securely capture the current injection context natively', () => {
    const MY_TOKEN = new InjectionToken<string>('MyToken');

    TestBed.configureTestingModule({
      providers: [{ provide: MY_TOKEN, useValue: 'captured-value' }],
    });

    let contextRunner: (<T>(fn: () => T) => T) | undefined;

    TestBed.runInInjectionContext(() => {
      contextRunner = createRunInInjectionContext();
    });

    expect(contextRunner).toBeDefined();

    if (!contextRunner) throw new Error('contextRunner is not defined');

    const result = contextRunner(() => inject(MY_TOKEN));

    expect(result).toBe('captured-value');
  });

  it('should accept an explicit injector manually if passed', () => {
    const MY_TOKEN = new InjectionToken<string>('MyExplicitToken');

    TestBed.configureTestingModule({
      providers: [{ provide: MY_TOKEN, useValue: 'explicit-value' }],
    });

    const rootInjector = TestBed.inject(Injector);

    const runner = createRunInInjectionContext(rootInjector);

    const result = runner(() => inject(MY_TOKEN));

    expect(result).toBe('explicit-value');
  });

  it('should throw immediately if invoked entirely outside an injection context without an explicit injector', () => {
    const executeBadCapture = () => createRunInInjectionContext();

    expect(executeBadCapture).toThrow();
  });
});
