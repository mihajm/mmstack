import {
  createEnvironmentInjector,
  EnvironmentInjector,
  PLATFORM_ID,
} from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { pageVisibility } from './page-visibility';

function setVisibility(value: DocumentVisibilityState) {
  Object.defineProperty(document, 'visibilityState', {
    value,
    configurable: true,
  });
}

describe('pageVisibility', () => {
  afterEach(() => {
    delete (document as { visibilityState?: unknown }).visibilityState;
  });

  it('should update signal when visibility changes', () => {
    TestBed.runInInjectionContext(() => {
      const visibility = pageVisibility();

      expect(visibility()).toBe('visible'); // default in jsdom

      Object.defineProperty(document, 'visibilityState', {
        value: 'hidden',
        configurable: true,
      });
      document.dispatchEvent(new Event('visibilitychange'));

      expect(visibility()).toBe('hidden');
    });
  });

  it('ignores visibilitychange after destroy', () => {
    const child = createEnvironmentInjector(
      [],
      TestBed.inject(EnvironmentInjector),
    );
    const visibility = pageVisibility({ injector: child });
    expect(visibility()).toBe('visible');
    child.destroy();
    setVisibility('hidden');
    document.dispatchEvent(new Event('visibilitychange'));
    expect(visibility()).toBe('visible');
  });

  it('is visible on the server whatever the document says', () => {
    TestBed.configureTestingModule({
      providers: [{ provide: PLATFORM_ID, useValue: 'server' }],
    });
    setVisibility('hidden');
    const visibility = TestBed.runInInjectionContext(() => pageVisibility());
    expect(visibility()).toBe('visible');
  });
});
