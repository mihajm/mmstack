import { computed, type Signal } from '@angular/core';

type TooltipedSignals = {
  shortened: Signal<string>;
  tooltip: Signal<string>;
};

export function tooltip(
  message: Signal<string>,
  providedMaxLen?: () => number,
): TooltipedSignals {
  const maxLen = computed(() => providedMaxLen?.() ?? 40);
  const resolved = computed(() => {
    const max = maxLen();
    const m = message();
    if (m.length <= maxLen()) {
      return { value: m, tooltip: '' };
    }

    return {
      value: `${m.slice(0, max)}...`,
      tooltip: m,
    };
  });

  return {
    shortened: computed(() => resolved().value),
    tooltip: computed(() => resolved().tooltip),
  };
}
