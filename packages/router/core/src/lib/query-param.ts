import {
  computed,
  inject,
  isSignal,
  untracked,
  type WritableSignal,
} from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { ActivatedRoute, Router } from '@angular/router';
import { toWritable } from '@mmstack/primitives';

/**
 * Creates a WritableSignal that synchronizes with a specific URL query parameter,
 * enabling two-way binding between the signal's state and the URL.
 *
 * Reading the signal provides the current value of the query parameter (or null if absent).
 * Setting the signal updates the URL query parameter using `Router.navigate`, triggering
 * navigation and causing the signal to update reactively if the navigation is successful.
 *
 * @param key The key of the query parameter to synchronize with.
 * Can be a static string (e.g., `'search'`) or a function/signal returning a string
 * for dynamic keys (e.g., `() => this.userId() + '_filter'` or `computed(() => this.category() + '_sort')`).
 * The signal will reactively update if the key returned by the function/signal changes.
 * @returns {WritableSignal<string | null>} A signal representing the query parameter's value.
 * - Reading returns the current value string, or `null` if the parameter is absent in the URL.
 * - Setting the signal to a string updates the query parameter in the URL (e.g., `signal.set('value')` results in `?key=value`).
 * - Setting the signal to `null` removes the query parameter from the URL (e.g., `signal.set(null)` results in `?otherParam=...`).
 * - Automatically reflects changes if the query parameters update due to external navigation.
 * @remarks
 * - Requires Angular's `ActivatedRoute` and `Router` to be available in the injection context.
 * - Uses `Router.navigate` with `queryParamsHandling: 'merge'` to preserve other existing query parameters during updates.
 * - Handles dynamic keys reactively. If the result of the `key` function/signal changes, the signal will start reflecting the value of the *new* query parameter key.
 * - During Server-Side Rendering (SSR), it reads the initial value from the route snapshot. Write operations (`set`) might have limited or no effect on the server depending on the platform configuration.
 *
 * @example
 * ```ts
 * import { Component, computed, effect, signal } from '@angular/core';
 * import { queryParam } from '@mmstack/router-core'; // Adjust import path as needed
 * // import { FormsModule } from '@angular/forms'; // If using ngModel
 *
 * @Component({
 * selector: 'app-product-list',
 * standalone: true,
 * // imports: [FormsModule], // If using ngModel
 * template: `
 * <div>
 * Sort By:
 * <select [value]="sortSignal() ?? ''" (change)="sortSignal.set($any($event.target).value || null)">
 * <option value="">Default</option>
 * <option value="price_asc">Price Asc</option>
 * <option value="price_desc">Price Desc</option>
 * <option value="name">Name</option>
 * </select>
 * <button (click)="sortSignal.set(null)" [disabled]="!sortSignal()">Clear Sort</button>
 * </div>
 * <div>
 * Page:
 * <input type="number" min="1" [value]="pageSignal() ?? '1'" #p (input)="setPage(p.value)"/>
 * </div>
 * * `
 * })
 * export class ProductListComponent {
 * // Two-way bind the 'sort' query parameter (?sort=...)
 * // Defaults to null if param is missing
 * sortSignal = queryParam('sort');
 *
 * // Example with a different type (needs serialization or separate logic)
 * // For simplicity, we treat page as string | null here
 * pageSignal = queryParam('page');
 *
 * constructor() {
 * effect(() => {
 * const currentSort = this.sortSignal();
 * const currentPage = this.pageSignal(); // Read as string | null
 * console.log('Sort/Page changed, reloading products for:', { sort: currentSort, page: currentPage });
 * // --- Fetch data based on currentSort and currentPage ---
 * });
 * }
 *
 * setPage(value: string): void {
 * const pageNum = parseInt(value, 10);
 * // Set to null if page is 1 (to remove param), otherwise set string value
 * this.pageSignal.set(isNaN(pageNum) || pageNum <= 1 ? null : pageNum.toString());
 * }
 * }
 * ```
 */
export function queryParam(
  key: string | (() => string),
  route = inject(ActivatedRoute),
): WritableSignal<string | null> {
  const router = inject(Router);

  const keySignal =
    typeof key === 'string'
      ? computed(() => key)
      : isSignal(key)
        ? key
        : computed(key);

  const queryParamMap = toSignal(route.queryParamMap, {
    initialValue: route.snapshot.queryParamMap,
  });

  const queryParams = toSignal(route.queryParams, {
    initialValue: route.snapshot.queryParams,
  });

  const queryParam = computed(() => queryParamMap().get(keySignal()));

  const set = (newValue: string | null) => {
    const next = {
      ...untracked(queryParams),
    };
    const key = untracked(keySignal);

    if (newValue === null) {
      delete next[key];
    } else {
      next[key] = newValue;
    }

    router.navigate([], {
      relativeTo: route,
      queryParams: next,
      queryParamsHandling: 'merge',
    });
  };

  return toWritable(queryParam, set);
}
