import { defineConfig } from 'vitest/config';

// This line's unit-test builder has no `isolate` option, and the specs each mock the drag-and-drop adapter, so files must not share a module cache.
export default defineConfig({
  test: { isolate: true },
});
