import { TestBed } from '@angular/core/testing';
import { networkStatus } from './network-status';

describe('networkStatus', () => {
  it('should initialize to online state and react to window events', () => {
    TestBed.runInInjectionContext(() => {
      const status = networkStatus();
      
      expect(status()).toBe(true); // Default behavior in jsdom
      const initialSince = status.since();
      expect(initialSince).toBeInstanceOf(Date);

      window.dispatchEvent(new Event('offline'));
      
      expect(status()).toBe(false);
      expect(status.since().getTime()).toBeGreaterThanOrEqual(initialSince.getTime());

      window.dispatchEvent(new Event('online'));
      
      expect(status()).toBe(true);
    });
  });
});
