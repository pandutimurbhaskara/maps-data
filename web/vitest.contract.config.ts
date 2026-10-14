import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['contract/**/*.test.ts'],
    globalSetup: ['./contract/globalSetup.ts'],
    testTimeout: 60_000,
    hookTimeout: 300_000,
  },
});
