import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { nestedEffect } from './nested-effect';

describe('nestedEffect', () => {
  it('should run the effect function', () => {
    TestBed.runInInjectionContext(() => {
      const spy = vi.fn();
      nestedEffect(spy);
      TestBed.tick();

      expect(spy).toHaveBeenCalledTimes(1);
    });
  });

  it('should re-run when tracked signals change', () => {
    TestBed.runInInjectionContext(() => {
      const count = signal(0);
      const spy = vi.fn();

      nestedEffect(() => {
        count();
        spy();
      });

      TestBed.tick();
      expect(spy).toHaveBeenCalledTimes(1);

      count.set(1);
      TestBed.tick();
      expect(spy).toHaveBeenCalledTimes(2);

      count.set(2);
      TestBed.tick();
      expect(spy).toHaveBeenCalledTimes(3);
    });
  });

  it('should call cleanup when re-running', () => {
    TestBed.runInInjectionContext(() => {
      const count = signal(0);
      const cleanupSpy = vi.fn();

      nestedEffect((onCleanup) => {
        count();
        onCleanup(cleanupSpy);
      });

      TestBed.tick();
      expect(cleanupSpy).not.toHaveBeenCalled();

      count.set(1);
      TestBed.tick();
      expect(cleanupSpy).toHaveBeenCalledTimes(1);
    });
  });

  it('should destroy child effects when parent re-runs', () => {
    TestBed.runInInjectionContext(() => {
      const outerSignal = signal('a');
      const innerSignal = signal(0);
      const innerSpy = vi.fn();

      nestedEffect(() => {
        outerSignal(); // track outer

        nestedEffect(() => {
          innerSignal(); // track inner
          innerSpy();
        });
      });

      TestBed.tick();
      expect(innerSpy).toHaveBeenCalledTimes(1);

      // Changing the inner signal should trigger inner effect
      innerSignal.set(1);
      TestBed.tick();
      expect(innerSpy).toHaveBeenCalledTimes(2);

      // Changing the outer signal should destroy+recreate the inner effect
      outerSignal.set('b');
      TestBed.tick();
      // Inner effect was destroyed and recreated: call count goes up by 1 (the recreated run)
      expect(innerSpy).toHaveBeenCalledTimes(3);

      // After parent re-ran, inner effect should still work
      innerSignal.set(2);
      TestBed.tick();
      expect(innerSpy).toHaveBeenCalledTimes(4);
    });
  });

  it('should stop child effects when parent is destroyed', () => {
    TestBed.runInInjectionContext(() => {
      const innerSignal = signal(0);
      const innerSpy = vi.fn();

      const ref = nestedEffect(() => {
        nestedEffect(() => {
          innerSignal();
          innerSpy();
        });
      });

      TestBed.tick();
      expect(innerSpy).toHaveBeenCalledTimes(1);

      ref.destroy();

      innerSignal.set(1);
      TestBed.tick();
      // Inner effect should NOT run after parent is destroyed
      expect(innerSpy).toHaveBeenCalledTimes(1);
    });
  });

  it('should conditionally create/destroy nested effects', () => {
    TestBed.runInInjectionContext(() => {
      const guard = signal(false);
      const hot = signal(0);
      const hotSpy = vi.fn();

      nestedEffect(() => {
        if (guard()) {
          nestedEffect(() => {
            hot();
            hotSpy();
          });
        }
      });

      TestBed.tick();
      // Guard is false, inner effect should not run
      expect(hotSpy).not.toHaveBeenCalled();

      // Toggling hot should NOT trigger anything since inner was never created
      hot.set(1);
      TestBed.tick();
      expect(hotSpy).not.toHaveBeenCalled();

      // Enable guard → inner effect is created
      guard.set(true);
      TestBed.tick();
      expect(hotSpy).toHaveBeenCalledTimes(1);

      // Now hot changes should be tracked
      hot.set(2);
      TestBed.tick();
      expect(hotSpy).toHaveBeenCalledTimes(2);

      // Disable guard → inner effect is destroyed
      guard.set(false);
      TestBed.tick();

      // Hot changes should no longer trigger
      hot.set(3);
      TestBed.tick();
      expect(hotSpy).toHaveBeenCalledTimes(2);
    });
  });

  it('should return a destroyable EffectRef', () => {
    TestBed.runInInjectionContext(() => {
      const count = signal(0);
      const spy = vi.fn();

      const ref = nestedEffect(() => {
        count();
        spy();
      });

      TestBed.tick();
      expect(spy).toHaveBeenCalledTimes(1);

      ref.destroy();

      count.set(1);
      TestBed.tick();
      expect(spy).toHaveBeenCalledTimes(1); // No more runs after destroy
    });
  });

  it('should be idempotent on double destroy', () => {
    TestBed.runInInjectionContext(() => {
      const ref = nestedEffect(() => {
        // noop
      });
      TestBed.tick();

      expect(() => {
        ref.destroy();
        ref.destroy();
      }).not.toThrow();
    });
  });
});
