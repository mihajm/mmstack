import {
  createEnvironmentInjector,
  EnvironmentInjector,
  Injector,
  PLATFORM_ID,
} from '@angular/core';
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
      expect(status.since().getTime()).toBeGreaterThanOrEqual(
        initialSince.getTime(),
      );

      window.dispatchEvent(new Event('online'));

      expect(status()).toBe(true);
    });
  });

  it('should support creation outside an injection context via the injector option', () => {
    const injector = TestBed.inject(Injector);

    // no runInInjectionContext wrapper — would previously throw NG0203
    const status = networkStatus({ injector });

    expect(status()).toBe(true);
    window.dispatchEvent(new Event('offline'));
    expect(status()).toBe(false);
    window.dispatchEvent(new Event('online'));
    expect(status()).toBe(true);
  });

  it('still accepts the positional debugName string form', () => {
    TestBed.runInInjectionContext(() => {
      const status = networkStatus('my-network');
      expect(status()).toBe(true);
    });
  });

  describe('timestamps', () => {
    const T0 = new Date('2026-01-01T00:00:00.000Z').getTime();
    beforeEach(() => {
      vi.useFakeTimers();
      vi.setSystemTime(T0);
    });
    afterEach(() => vi.useRealTimers());

    it('stamps since with creation time, then with each transition', () => {
      const status = TestBed.runInInjectionContext(() => networkStatus());
      expect(status.since().getTime()).toBe(T0);

      vi.setSystemTime(T0 + 1000);
      window.dispatchEvent(new Event('offline'));
      expect(status.since().getTime()).toBe(T0 + 1000);

      vi.setSystemTime(T0 + 2500);
      window.dispatchEvent(new Event('online'));
      expect(status.since().getTime()).toBe(T0 + 2500);
    });

    it('stamps since with creation time on the server', () => {
      TestBed.configureTestingModule({
        providers: [{ provide: PLATFORM_ID, useValue: 'server' }],
      });
      vi.setSystemTime(T0 + 60_000);
      const status = TestBed.runInInjectionContext(() => networkStatus());
      expect(status.since().getTime()).toBe(T0 + 60_000);
    });
  });

  it.each(['offline', 'online'])('ignores %s after destroy', (event) => {
    const child = createEnvironmentInjector(
      [],
      TestBed.inject(EnvironmentInjector),
    );
    const status = networkStatus({ injector: child });
    if (event === 'online') window.dispatchEvent(new Event('offline'));
    const before = status();
    child.destroy();
    window.dispatchEvent(new Event(event));
    expect(status()).toBe(before);
    window.dispatchEvent(new Event('online'));
  });

  it('is online on the server and ignores window events', () => {
    TestBed.configureTestingModule({
      providers: [{ provide: PLATFORM_ID, useValue: 'server' }],
    });
    const onLine = vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
    try {
      const status = TestBed.runInInjectionContext(() => networkStatus());
      expect(status()).toBe(true);
      window.dispatchEvent(new Event('offline'));
      expect(status()).toBe(true);
      expect(status.since()).toBeInstanceOf(Date);
    } finally {
      onLine.mockRestore();
    }
  });
});
