import {
  computed,
  linkedSignal,
  type ResourceRef,
  type Signal,
  signal,
} from '@angular/core';

/**
 * @internal A resource's `loads` counter, kept in step with its status. Angular's resource starts
 * a load whenever its request changes to a defined value or a reload is accepted, so the counter
 * is keyed on exactly those two inputs and moves when read, never later.
 *
 * Several changes between two reads count once. The counter is only compared for "has it moved",
 * so a collapsed count loses nothing.
 */
export function countLoads<T extends Pick<ResourceRef<unknown>, 'reload'>>(
  request: Signal<unknown>,
  resource: T,
): { readonly loads: Signal<number>; readonly resource: T } {
  const reloads = signal(0);
  const key = computed(() => ({ req: request(), run: reloads() }), {
    equal: (a, b) => a.req === b.req && a.run === b.run,
  });
  const loads = linkedSignal<{ req: unknown; run: number }, number>({
    source: key,
    computation: (k, prev) =>
      (prev?.value ?? 0) + (k.req === undefined ? 0 : 1),
  });
  // captured now: a caller may install the wrapped reload on `resource` itself
  const reload = resource.reload.bind(resource);
  return {
    loads: loads.asReadonly(),
    resource: {
      ...resource,
      reload: () => {
        const accepted = reload();
        if (accepted) reloads.update((n) => n + 1);
        return accepted;
      },
    },
  };
}
