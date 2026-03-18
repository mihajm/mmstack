import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { MessageBus, tabSync } from './tabSync';

describe('tabSync', () => {
  it('should sync signal across tabs and broadcast changes', () => {
    TestBed.runInInjectionContext(() => {
      const bus = TestBed.inject(MessageBus);
      const subscribeSpy = vi.spyOn(bus, 'subscribe');

      const sig = tabSync(signal('dark'), { id: 'theme-sync' });

      expect(subscribeSpy).toHaveBeenCalledWith(
        'theme-sync',
        expect.any(Function),
      );

      TestBed.tick();

      vi.spyOn(bus as any, 'unsubscribe').mockImplementation(() => {
        // noop
      });

      sig.set('light');
      TestBed.tick();

      expect(sig()).toBe('light');
    });
  });
});
