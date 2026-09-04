import { defineConfig } from 'vitest/config';

// Unit tests only — browser e2e lives in tests/e2e/*.e2e.mjs and is run by
// tests/run-e2e.mjs (vite preview + playwright), not by vitest.
export default defineConfig({
  test: {
    include: ['tests/unit/**/*.test.js'],
    environment: 'node',
  },
});
