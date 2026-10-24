import { defineConfig } from 'vitest/config';

const ignored = ['**/node_modules/**', '**/dist/**', 'apps/api/src/generated/**'];

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'unit',
          include: ['{apps,packages,scripts,prisma}/**/*.test.{ts,mjs}'],
          exclude: [...ignored, '**/*.int.test.ts'],
        },
      },
      {
        // Real PostgreSQL (TEST_DATABASE_URL). Files run one at a time because each test
        // starts from truncated tables.
        test: {
          name: 'integration',
          include: ['{apps,packages,prisma}/**/*.int.test.ts'],
          exclude: ignored,
          globalSetup: ['apps/api/test/global-setup.ts'],
          fileParallelism: false,
          testTimeout: 20_000,
          hookTimeout: 60_000,
        },
      },
    ],
  },
});
