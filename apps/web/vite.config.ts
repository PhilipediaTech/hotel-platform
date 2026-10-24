import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';
import { VitePWA } from 'vite-plugin-pwa';

// Brand accent is a placeholder until the product name and brand are chosen.
const THEME_COLOR = '#0f766e';

export default defineConfig({
  plugins: [
    react(),
    tailwindcss(),
    VitePWA({
      // Never reload under a user mid-check-in: show "update available" and let them choose.
      registerType: 'prompt',
      injectRegister: false,
      includeAssets: ['favicon.svg'],
      manifest: {
        name: 'Hotel Platform',
        short_name: 'Hotel',
        description: 'Front desk, housekeeping, finance and owner app',
        start_url: '/',
        display: 'standalone',
        background_color: '#ffffff',
        theme_color: THEME_COLOR,
        icons: [
          { src: 'icons/icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: 'icons/icon-512.png', sizes: '512x512', type: 'image/png' },
          {
            src: 'icons/icon-maskable-512.png',
            sizes: '512x512',
            type: 'image/png',
            purpose: 'maskable',
          },
        ],
      },
      workbox: {
        // App shell only. API data is cached in IndexedDB (Dexie) by T-093, never by the SW.
        globPatterns: ['**/*.{js,css,html,svg,png,woff2}'],
        navigateFallback: '/index.html',
        navigateFallbackDenylist: [/^\/api\//, /^\/public\//],
        cleanupOutdatedCaches: true,
      },
    }),
  ],
  server: { port: 5173, strictPort: true },
  preview: { port: 4173, strictPort: true },
  build: { target: 'es2022', sourcemap: true },
});
