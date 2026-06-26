import { ApplicationRef, EnvironmentInjector, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { stored } from './stored';

describe('stored', () => {
  let mockStore: any;

  beforeEach(() => {
    mockStore = {
      getItem: vi.fn().mockReturnValue(null),
      setItem: vi.fn(),
      removeItem: vi.fn(),
    };
  });

  it('should initialize with fallback if nothing in store', () => {
    TestBed.runInInjectionContext(() => {
      const sig = stored('light', { key: 'theme', store: mockStore });
      expect(sig()).toBe('light');
      expect(mockStore.getItem).toHaveBeenCalledWith('theme');
    });
  });

  it('should initialize with value from store', () => {
    mockStore.getItem.mockReturnValue('"dark"'); // JSON string
    TestBed.runInInjectionContext(() => {
      const sig = stored('light', { key: 'theme', store: mockStore });
      expect(sig()).toBe('dark');
    });
  });

  it('should store value on set via effect', async () => {
    TestBed.runInInjectionContext(async () => {
      const sig = stored('light', { key: 'theme', store: mockStore });

      sig.set('dark');
      TestBed.tick();
      await TestBed.inject(ApplicationRef).whenStable();

      expect(mockStore.setItem).toHaveBeenCalledWith('theme', '"dark"');
    });
  });

  it('should remove from store on clear', async () => {
    await TestBed.runInInjectionContext(async () => {
      const sig = stored('light', { key: 'theme', store: mockStore });

      sig.clear();
      TestBed.tick();
      await TestBed.inject(ApplicationRef).whenStable();

      expect(mockStore.removeItem).toHaveBeenCalledWith('theme');
      expect(sig()).toBe('light'); // Reverts to fallback
    });
  });

  it('pauses persistence while paused and flushes the latest on resume (opt-in)', async () => {
    const paused = signal(true);
    await TestBed.runInInjectionContext(async () => {
      const sig = stored('light', {
        key: 'theme',
        store: mockStore,
        pause: paused,
      });

      sig.set('dark');
      TestBed.tick();
      await TestBed.inject(ApplicationRef).whenStable();

      // paused: nothing persisted, but the value stays live
      expect(mockStore.setItem).not.toHaveBeenCalled();
      expect(sig()).toBe('dark');

      paused.set(false);
      TestBed.tick();
      await TestBed.inject(ApplicationRef).whenStable();

      // resumed: the latest value is flushed
      expect(mockStore.setItem).toHaveBeenCalledWith('theme', '"dark"');
    });
  });

  it('accepts an explicit injector (created outside an injection context)', () => {
    const injector = TestBed.inject(EnvironmentInjector);
    const sig = stored('light', { key: 'theme', store: mockStore, injector });
    expect(sig()).toBe('light');
  });
});
