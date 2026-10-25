import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  base: './',
  plugins: [vue()],
  resolve: {
    alias: {
      '@core': fileURLToPath(new URL('../src/core', import.meta.url)),
      'pxl-core': fileURLToPath(new URL('../vendor/pxl/src/core/index.ts', import.meta.url)),
    },
  },
  server: { host: '0.0.0.0', port: 5190 },
  build: {
    outDir: 'dist', emptyOutDir: true,
    rollupOptions: { input: { main: fileURLToPath(new URL('./index.html', import.meta.url)), escena: fileURLToPath(new URL('./escena.html', import.meta.url)), oraculo: fileURLToPath(new URL('./oraculo.html', import.meta.url)), 'oraculo-render': fileURLToPath(new URL('./oraculo-render.html', import.meta.url)), multitud: fileURLToPath(new URL('./multitud.html', import.meta.url)) } },
  },
});
