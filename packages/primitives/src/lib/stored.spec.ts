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

  it('should store value on set via effect', () => {
    TestBed.runInInjectionContext(() => {
      const sig = stored('light', { key: 'theme', store: mockStore });

      sig.set('dark');
      TestBed.tick();

      expect(mockStore.setItem).toHaveBeenCalledWith('theme', '"dark"');
    });
  });

  it('should remove from store on clear', () => {
    TestBed.runInInjectionContext(() => {
      const sig = stored('light', { key: 'theme', store: mockStore });

      sig.clear();
      TestBed.tick();

      expect(mockStore.removeItem).toHaveBeenCalledWith('theme');
      expect(sig()).toBe('light'); // Reverts to fallback
    });
  });
});
