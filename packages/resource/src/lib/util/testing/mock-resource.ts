import { type HttpHeaders, type HttpResourceRef } from '@angular/common/http';
import { computed, signal, type WritableSignal } from '@angular/core';

type ResourceStatus = 'idle' | 'error' | 'loading' | 'reloading' | 'resolved' | 'local';

/**
 * Creates a minimal mock of HttpResourceRef for unit testing utilities.
 */
export function createMockResource<T>(
  initialValue: T,
  options?: {
    status?: ResourceStatus;
    statusCode?: number;
    error?: Error;
  },
): HttpResourceRef<T> & {
  _status: WritableSignal<ResourceStatus>;
  _error: WritableSignal<Error | undefined>;
  _statusCode: WritableSignal<number | undefined>;
  _reloadSpy: ReturnType<typeof vi.fn>;
  _destroySpy: ReturnType<typeof vi.fn>;
} {
  const _value = signal(initialValue);
  const _status = signal<ResourceStatus>(options?.status ?? 'idle');
  const _error = signal<Error | undefined>(options?.error ?? undefined);
  const _statusCode = signal<number | undefined>(options?.statusCode);
  const _reloadSpy = vi.fn(() => true);
  const _destroySpy = vi.fn();

  const value = Object.assign(_value, {
    asReadonly: () => _value.asReadonly(),
  });

  const resource: HttpResourceRef<T> = {
    value,
    status: _status as any,
    error: _error,
    statusCode: _statusCode,
    headers: signal(undefined) as unknown as WritableSignal<HttpHeaders | undefined>,
    isLoading: computed(() => _status() === 'loading'),
    progress: signal(undefined) as any,
    hasValue: (() => _value() !== undefined) as HttpResourceRef<T>['hasValue'],
    reload: _reloadSpy,
    destroy: _destroySpy,
    set: (v: T) => _value.set(v),
    update: (fn: (v: T) => T) => _value.update(fn),
    asReadonly: () => resource as any,
    snapshot: undefined as any,
  };

  return Object.assign(resource, {
    _status,
    _error,
    _statusCode,
    _reloadSpy,
    _destroySpy,
  });
}
