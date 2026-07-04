import { toResourceObject } from './to-resource-object';
import { createMockResource } from './testing/mock-resource';

describe('toResourceObject', () => {
  it('should create a plain object proxy with all HttpResourceRef members', () => {
    const mock = createMockResource('hello');

    const obj = toResourceObject(mock);

    expect(obj.value()).toBe('hello');

    expect(obj.status()).toBe('idle');

    obj.reload();
    expect(mock._reloadSpy).toHaveBeenCalledTimes(1);

    obj.destroy();
    expect(mock._destroySpy).toHaveBeenCalledTimes(1);
  });

  it('should forward set and update to original resource', () => {
    const mock = createMockResource('initial');
    const obj = toResourceObject(mock);

    obj.set('updated');
    expect(mock.value()).toBe('updated');

    obj.update((v) => v + '!');
    expect(mock.value()).toBe('updated!');
  });

  it('should forward hasValue', () => {
    const mock = createMockResource('value');
    const obj = toResourceObject(mock);

    expect(obj.hasValue()).toBe(true);
  });

  it('should return a new object reference (not same identity)', () => {
    const mock = createMockResource('data');
    const obj = toResourceObject(mock);

    expect(obj).not.toBe(mock);
    expect(obj.value).toBe(mock.value);
  });
});
