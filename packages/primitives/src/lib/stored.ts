import { isPlatformServer } from '@angular/common';
import {
  computed,
  DestroyRef,
  effect,
  inject,
  isDevMode,
  isSignal,
  PLATFORM_ID,
  signal,
  untracked,
  type CreateSignalOptions,
  type Signal,
  type WritableSignal,
} from '@angular/core';
import { toWritable } from './to-writable';

/**
 * Interface for storage mechanisms compatible with the `stored` signal.
 * Matches the essential parts of the `Storage` interface (`localStorage`, `sessionStorage`).
 */
type Store = {
  /** Retrieves an item from storage for a given key. */
  getItem: (key: string) => string | null;
  /** Sets an item in storage for a given key. */
  setItem: (key: string, value: string) => void;
  /** Removes an item from storage for a given key. */
  removeItem: (key: string) => void;
};

// Internal dummy store for server-side rendering
const noopStore: Store = {
  getItem: () => null,
  setItem: () => {
    /* noop */
  },
  removeItem: () => {
    /* noop */
  },
};

/**
 * Options for creating a signal synchronized with persistent storage using `stored()`.
 * Extends Angular's `CreateSignalOptions`.
 *
 * @template T The type of value held by the signal.
 */
export type CreateStoredOptions<T> = CreateSignalOptions<T> & {
  /**
   * The key used to identify the item in storage.
   * Can be a static string or a function/signal returning a string for dynamic keys
   * (e.g., based on user ID or other application state).
   */
  key: string | (() => string);
  /**
   * Optional custom storage implementation (e.g., `sessionStorage` or a custom adapter).
   * Must conform to the `Store` interface (`getItem`, `setItem`, `removeItem`).
   * Defaults to `localStorage` in browser environments and a no-op store on the server.
   */
  store?: Store;
  /**
   * Optional function to serialize the value (type `T`) into a string before storing.
   * Defaults to `JSON.stringify`.
   * @param {T} value The value to serialize.
   * @returns {string} The serialized string representation.
   */
  serialize?: (value: T) => string;
  /**
   * Optional function to deserialize the string retrieved from storage back into the value (type `T`).
   * Defaults to `JSON.parse`.
   * @param {string} value The string retrieved from storage.
   * @returns {T} The deserialized value.
   */
  deserialize?: (value: string) => T;
  /**
   * If `true`, the signal will attempt to synchronize its state across multiple browser tabs
   * using the `storage` event. Changes made in one tab (set, update, clear) will be
   * reflected in other tabs using the same storage key.
   * Requires a browser environment. Defaults to `false`.
   */
  syncTabs?: boolean;
  /**
   * Optional parameter to specify how key changes should be handled, load is the default.
   * - `load`: The signal will load the value from storage when the key changes & replace the signal's value.
   * - `store`: The signal will store the current value to the new key when the key changes.
   */
  onKeyChange?: 'load' | 'store';
  /**
   * If 'true', the signal will remove the old key from storage when the key changes, defaults to `false`.
   */
  cleanupOldKey?: boolean;
  /**
   * Optional validator, which is called on load of value. Store will be set to fallback if value is false
   */
  validate?: (value: T) => boolean;
};

/**
 * A specialized `WritableSignal` returned by the `stored()` function.
 * It synchronizes its value with persistent storage and provides additional methods.
 *
 * @template T The type of value held by the signal (matches the fallback type).
 */
export type StoredSignal<T> = WritableSignal<T> & {
  /**
   * Removes the item associated with the signal's key from the configured storage.
   * After clearing, reading the signal will return the fallback value until it's set again.
   */
  clear: () => void;
  /**
   * A `Signal<string>` containing the current storage key being used by this stored signal.
   * This is particularly useful if the key was configured dynamically. You can read or react
   * to this signal to know the active key.
   */
  key: Signal<string>;
};

/**
 * Creates a `WritableSignal` whose state is automatically synchronized with persistent storage
 * (like `localStorage` or `sessionStorage`).
 *
 * It handles Server-Side Rendering (SSR) gracefully, allows dynamic storage keys,
 * custom serialization/deserialization, custom storage providers, and optional
 * synchronization across browser tabs.
 *
 * @template T The type of value held by the signal and stored (after serialization).
 * @param fallback The default value of type `T` to use when no value is found in storage
 * or when deserialization fails. The signal's value will never be `null` or `undefined`
 * publicly, it will always revert to this fallback.
 * @param options Configuration options (`CreateStoredOptions<T>`). Requires at least the `key`.
 * @returns A `StoredSignal<T>` instance. This signal behaves like a standard `WritableSignal<T>`,
 * but its value is persisted. It includes a `.clear()` method to remove the item from storage
 * and a `.key` signal providing the current storage key.
 *
 * @remarks
 * - **Persistence:** The signal automatically saves its value to storage whenever the signal's
 * value or its configured `key` changes. This is managed internally using `effect`.
 * - **SSR Safety:** Detects server environments and uses a no-op storage, preventing errors.
 * - **Error Handling:** Catches and logs errors during serialization/deserialization in dev mode.
 * - **Tab Sync:** If `syncTabs` is true, listens to `storage` events to keep the signal value
 * consistent across browser tabs using the same key. Cleanup is handled automatically
 * using `DestroyRef`.
 * - **Removal:** Use the `.clear()` method on the returned signal to remove the item from storage.
 * Setting the signal to the fallback value will store the fallback value, not remove the item.
 *
 * @example
 * ```ts
 * import { Component, effect, signal } from '@angular/core';
 * import { stored } from '@mmstack/primitives'; // Adjust import path
 *
 * @Component({
 * selector: 'app-settings',
 * standalone: true,
 * template: `
 * Theme:
 * <select [ngModel]="theme()" (ngModelChange)="theme.set($event)">
 * <option value="light">Light</option>
 * <option value="dark">Dark</option>
 * </select>
 * <button (click)="theme.clear()">Clear Theme Setting</button>
 * <p>Storage Key Used: {{ theme.key() }}</p>
 * ` // Requires FormsModule for ngModel
 * })
 * export class SettingsComponent {
 *  theme = stored<'light' | 'dark'>('light', { key: 'app-theme', syncTabs: true });
 * }
 * ```
 */
export function stored<T>(
  fallback: T,
  {
    key,
    store: providedStore,
    serialize = JSON.stringify,
    deserialize = JSON.parse,
    syncTabs = false,
    equal = Object.is,
    onKeyChange = 'load',
    cleanupOldKey = false,
    validate = () => true,
    ...rest
  }: CreateStoredOptions<T>,
): StoredSignal<T> {
  const isServer = isPlatformServer(inject(PLATFORM_ID));

  const fallbackStore = isServer ? noopStore : localStorage;
  const store = providedStore ?? fallbackStore;

  const keySig =
    typeof key === 'string'
      ? computed(() => key)
      : isSignal(key)
        ? key
        : computed(key);

  const getValue = (key: string): T | null => {
    const found = store.getItem(key);
    if (found === null) return null;
    try {
      const deserialized = deserialize(found);
      if (!validate(deserialized)) return null;
      return deserialized;
    } catch (err) {
      if (isDevMode())
        console.error(`Failed to parse stored value for key "${key}":`, err);
      return null;
    }
  };

  const storeValue = (key: string, value: T | null) => {
    try {
      if (value === null) return store.removeItem(key);
      const serialized = serialize(value);
      store.setItem(key, serialized);
    } catch (err) {
      if (isDevMode())
        console.error(`Failed to store value for key "${key}":`, err);
    }
  };

  const opt = {
    ...rest,
    equal,
  };

  const initialKey = untracked(keySig);
  const internal = signal(getValue(initialKey), {
    ...opt,
    equal: (a, b) => {
      if (a === null && b === null) return true;
      if (a === null || b === null) return false;
      return equal(a, b);
    },
  });

  let prevKey = initialKey;

  if (onKeyChange === 'store') {
    effect(() => {
      const k = keySig();
      storeValue(k, internal());
      if (prevKey !== k) {
        if (cleanupOldKey) store.removeItem(prevKey);
        prevKey = k;
      }
    });
  } else {
    effect(() => {
      const k = keySig();
      const internalValue = internal();
      if (k === prevKey) {
        return storeValue(k, internalValue); // normal operation
      } else {
        if (cleanupOldKey) store.removeItem(prevKey);
        const value = getValue(k);

        prevKey = k;
        internal.set(value); // load new value
      }
    });
  }

  if (syncTabs && !isServer) {
    const destroyRef = inject(DestroyRef);
    const sync = (e: StorageEvent) => {
      if (e.key !== untracked(keySig)) return;

      if (e.newValue === null) internal.set(null);
      else internal.set(getValue(e.key));
    };

    window.addEventListener('storage', sync);

    destroyRef.onDestroy(() => window.removeEventListener('storage', sync));
  }

  const writable = toWritable<T>(
    computed(() => internal() ?? fallback, opt),
    internal.set,
  ) as StoredSignal<T>;

  writable.clear = () => {
    internal.set(null);
  };
  writable.key = keySig;
  return writable;
}
