import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

const api = 'http://127.0.0.1:8080';

export default defineConfig({
  plugins: [react()],
  // changeOrigin stays false: mapsd builds tile URLs from the Host header, so they point back at this dev server.
  server: { proxy: { '/api': { target: api }, '/v3': { target: api } } },
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./src/test-setup.ts'],
    include: ['src/**/*.test.{ts,tsx}'],
  },
});
