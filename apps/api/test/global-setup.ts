import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { testDatabaseUrl } from './db.ts';

const prismaCli = createRequire(import.meta.url).resolve('prisma/build/index.js');

/**
 * Brings the test database up to the latest migration once per `vitest` run.
 * `migrate deploy` only applies pending migrations and never drops data; each test
 * empties the tables it needs with resetDb().
 */
export default function setup(): void {
  const url = testDatabaseUrl();
  try {
    execFileSync(process.execPath, [prismaCli, 'migrate', 'deploy'], {
      env: { ...process.env, DATABASE_URL: url },
      stdio: 'pipe',
    });
  } catch (err) {
    const e = err as { stdout?: Buffer; stderr?: Buffer };
    throw new Error(
      `prisma migrate deploy failed for the test database:\n${String(e.stdout ?? '')}${String(e.stderr ?? '')}`,
      { cause: err },
    );
  }
}
