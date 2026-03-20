import { signal } from '@angular/core';
import { tooltip } from './tooltip';

describe('Tooltip Utility', () => {
  it('should not shorten messages shorter than maxLen', () => {
    const message = signal('Hello World');
    const { shortened, tooltip: tooltipSignal } = tooltip(message, () => 20);

    expect(shortened()).toBe('Hello World');
    expect(tooltipSignal()).toBe('');
  });

  it('should shorten messages longer than maxLen', () => {
    const message = signal('This is a very long message that should be shortened');
    const { shortened, tooltip: tooltipSignal } = tooltip(message, () => 10);

    expect(shortened()).toBe('This is a ...');
    expect(tooltipSignal()).toBe('This is a very long message that should be shortened');
  });

  it('should use default maxLen of 40', () => {
    const message = signal('a'.repeat(41));
    const { shortened, tooltip: tooltipSignal } = tooltip(message);

    expect(shortened()).toBe('a'.repeat(40) + '...');
    expect(tooltipSignal()).toBe('a'.repeat(41));
  });

  it('should update when message signal changes', () => {
    const message = signal('Short');
    const { shortened } = tooltip(message, () => 10);

    expect(shortened()).toBe('Short');

    message.set('Very long message indeed');
    expect(shortened()).toBe('Very long ...');
  });
});
