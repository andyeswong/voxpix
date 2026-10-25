import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  resolve: {
    alias: {
      'pxl-core': fileURLToPath(new URL('./vendor/pxl/src/core/index.ts', import.meta.url)),
      '@core': fileURLToPath(new URL('./src/core', import.meta.url)),
    },
  },
  test: { include: ['test/**/*.test.ts'] },
});
