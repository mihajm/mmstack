import { TestBed } from '@angular/core/testing';
import { pageVisibility } from './page-visibility';

describe('pageVisibility', () => {
  it('should update signal when visibility changes', () => {
    TestBed.runInInjectionContext(() => {
      const visibility = pageVisibility();
      
      expect(visibility()).toBe('visible'); // default in jsdom

      Object.defineProperty(document, 'visibilityState', {
        value: 'hidden',
        configurable: true
      });
      document.dispatchEvent(new Event('visibilitychange'));

      expect(visibility()).toBe('hidden');
    });
  });
});
