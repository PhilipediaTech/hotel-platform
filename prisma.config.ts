import { defineConfig } from 'prisma/config';

// Prisma 7 does not read .env itself. Real environment variables (CI, Render) win.
try {
  process.loadEnvFile('.env');
} catch {
  // No .env file: rely on the process environment.
}

export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: {
    path: 'prisma/migrations',
    seed: 'node prisma/seed.ts',
  },
  datasource: {
    // Optional so `prisma generate` works without a database (e.g. on a build step).
    url: process.env.DATABASE_URL ?? '',
  },
});
