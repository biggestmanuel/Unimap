import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';
import { resolve } from 'node:path';

export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['icons/*.png', 'favicon-16.png', 'favicon-32.png', 'apple-touch-icon.png'],
      manifest: {
        name: 'UniMap — Rivers State University',
        short_name: 'UniMap',
        description:
          'Find buildings and get walking directions across the RSU campus. Works offline.',
        theme_color: '#2563eb',
        background_color: '#0f172a',
        display: 'standalone',
        orientation: 'portrait',
        // Nigeria is in the UTC+1 zone, no DST.
        start_url: '/',
        scope: '/',
        icons: [
          { src: '/icons/pwa-192.png', sizes: '192x192', type: 'image/png' },
          { src: '/icons/pwa-512.png', sizes: '512x512', type: 'image/png' },
          // "any maskable" needs the image to survive a circular crop, which
          // this logo does not (it has a wordmark across the bottom), so the
          // maskable slot is deliberately left empty rather than filled with
          // something that renders badly on Android.
        ],
      },
      workbox: {
        // Precache the app shell and the campus data, but NOT the admin
        // bundle: students must never download it, and precaching would put
        // the moderation UI on every phone.
        //
        // The hashed patterns matter as much as the directory one -- Vite
        // emits `assets/admin-<hash>.js`, which `**/admin/**` does not match.
        globPatterns: ['**/*.{js,css,html,svg,png,woff2}'],
        globIgnores: [
          '**/admin/**',
          '**/admin.html',
          '**/admin-*.js',
          '**/admin-*.css',
        ],
        maximumFileSizeToCacheInBytes: 3 * 1024 * 1024,

        navigateFallback: '/index.html',

        runtimeCaching: [
          {
            // Campus data. Network first so corrections propagate, cache as
            // the fallback for when there is no signal.
            urlPattern: ({ url }) => url.pathname.endsWith('/data/unimap.geojson'),
            handler: 'NetworkFirst',
            options: {
              cacheName: 'unimap-campus-data',
              networkTimeoutSeconds: 4,
              expiration: { maxEntries: 4, maxAgeSeconds: 60 * 60 * 24 * 30 },
            },
          },
          {
            // The walk graph never changes between deploys, so cache it hard.
            urlPattern: ({ url }) => url.pathname.endsWith('/data/walk-graph.json'),
            handler: 'CacheFirst',
            options: {
              cacheName: 'unimap-walk-graph',
              expiration: { maxEntries: 2, maxAgeSeconds: 60 * 60 * 24 * 30 },
            },
          },
          {
            // Map tiles.
            //
            // Capped hard on purpose: the OSM tile usage policy expects a
            // self-hosted or otherwise-approved tile source for anything
            // beyond light use, and an uncached tile cache is how a student
            // project ends up hammering a free public server. 3000 tiles is
            // roughly z16-17 over the campus and its surroundings.
            urlPattern: /^https:\/\/[abc]\.tile\.openstreetmap\.org\/.*/i,
            handler: 'CacheFirst',
            options: {
              cacheName: 'unimap-tiles',
              expiration: {
                maxEntries: 3000,
                maxAgeSeconds: 60 * 60 * 24 * 14,
                // Trim rather than let the browser evict everything at once.
                purgeOnQuotaError: true,
              },
              cacheableResponse: { statuses: [0, 200] },
            },
          },
        ],
      },
      devOptions: { enabled: false },
    }),
  ],
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
    chunkSizeWarningLimit: 600,
    rollupOptions: {
      // Two entries, deliberately separate bundles. The admin panel must not
      // be part of the student PWA payload: students should never download the
      // moderation UI, and the service worker precache excludes it too.
      input: {
        main: resolve(__dirname, 'index.html'),
        admin: resolve(__dirname, 'admin.html'),
      },
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
    // src/ holds unit tests beside the code they cover; test/ holds the
    // shared navigation/offline helpers.
    include: ['src/**/*.test.{js,jsx}', 'test/**/*.test.{js,jsx}'],
    // e2e specs live in ./e2e and run under Playwright, not Vitest.
    exclude: ['node_modules', 'e2e'],
  },
});