import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import pg from 'pg';
import { TEST_DB_ROLE, testDatabaseUrl } from './db.ts';

const prismaCli = createRequire(import.meta.url).resolve('prisma/build/index.js');

/**
 * Brings the test database up to the latest migration once per `vitest` run.
 * `migrate deploy` only applies pending migrations and never drops data; each test
 * empties the tables it needs with resetDb().
 */
export default async function setup(): Promise<void> {
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
  await createTestRole(url);
}

/**
 * Tests query as a role that is neither a superuser nor the tables' owner, so the
 * row-level security policies apply to them (T-144). Production connects as the owner, and
 * FORCE ROW LEVEL SECURITY makes the policies apply to it the same way.
 */
async function createTestRole(url: string): Promise<void> {
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    await client.query(`DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${TEST_DB_ROLE}') THEN
        CREATE ROLE ${TEST_DB_ROLE} NOLOGIN NOSUPERUSER NOBYPASSRLS;
      END IF; END $$`);
    await client.query(`GRANT USAGE ON SCHEMA public TO ${TEST_DB_ROLE};
      GRANT ALL ON ALL TABLES IN SCHEMA public TO ${TEST_DB_ROLE};
      GRANT ALL ON ALL SEQUENCES IN SCHEMA public TO ${TEST_DB_ROLE};
      GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO ${TEST_DB_ROLE}`);
  } finally {
    await client.end();
  }
}
