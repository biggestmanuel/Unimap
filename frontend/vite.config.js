import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    // Same-origin proxy so the app can talk to the API in dev.
    proxy: {
      '/api': {
        target: process.env.VITE_API_TARGET || 'http://localhost:4000',
        changeOrigin: true,
      },
    },
  },
  build: {
    // Phase 3 work: these targets drive Workbox precaching.
    // Raising the warning limit now avoids a surprise later.
    chunkSizeWarningLimit: 600,
    rollupOptions: {
      output: {
        manualChunks: {
          leaflet: ['leaflet', 'react-leaflet'],
        },
      },
    },
  },
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./src/test/setup.js'],
    include: ['src/**/*.test.{js,jsx}'],
    // e2e specs live in ./e2e and run under Playwright, not Vitest.
    exclude: ['node_modules', 'e2e'],
  },
});