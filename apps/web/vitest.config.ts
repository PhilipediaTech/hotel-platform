import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';
import { defineProject } from 'vitest/config';

// React components in a simulated browser. Included by the root vitest.config.ts as project "web".
export default defineProject({
  plugins: [react()],
  resolve: {
    alias: {
      'virtual:pwa-register/react': fileURLToPath(
        new URL('src/test/pwa-register-stub.ts', import.meta.url),
      ),
    },
  },
  test: {
    name: 'web',
    include: ['src/**/*.test.{ts,tsx}'],
    environment: 'jsdom',
    setupFiles: ['src/test/setup.ts'],
  },
});
