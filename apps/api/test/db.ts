import { expect } from 'vitest';
import { createDb, pgErrorInfo, type Db } from '../src/core/db.ts';

export const SQLSTATE = {
  UNIQUE: '23505',
  FOREIGN_KEY: '23503',
  CHECK: '23514',
} as const;

/** Asserts that a write fails on one specific PostgreSQL constraint. */
export async function expectViolation(
  write: Promise<unknown>,
  sqlState: (typeof SQLSTATE)[keyof typeof SQLSTATE],
  constraint: string,
): Promise<void> {
  const err: unknown = await write.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(err, `expected ${constraint} to reject the write`).toBeDefined();
  expect(pgErrorInfo(err)).toEqual({ sqlState, constraint });
}

/**
 * The integration-test database URL. Refuses anything whose database name doesn't end in
 * `_test`, so a mis-set variable can never truncate hotel_dev or production.
 */
export function testDatabaseUrl(): string {
  try {
    process.loadEnvFile('.env');
  } catch {
    // CI sets the variable directly.
  }
  const url = process.env.TEST_DATABASE_URL;
  if (!url) throw new Error('TEST_DATABASE_URL is not set (see .env.example).');
  const dbName = new URL(url).pathname.replace(/^\//, '');
  if (!dbName.endsWith('_test')) {
    throw new Error(`Refusing to run tests against "${dbName}": name must end in _test.`);
  }
  return url;
}

let shared: Db | undefined;

/** One client per test worker. */
export function testDb(): Db {
  shared ??= createDb(testDatabaseUrl());
  return shared;
}

/** Empties every application table (keeps the migrations table). */
export async function resetDb(db: Db): Promise<void> {
  const tables = await db.$queryRaw<{ tablename: string }[]>`
    SELECT tablename FROM pg_tables
    WHERE schemaname = 'public' AND tablename <> '_prisma_migrations'`;
  if (tables.length === 0) return;
  const list = tables.map((t) => `"${t.tablename}"`).join(', ');
  await db.$executeRawUnsafe(`TRUNCATE ${list} RESTART IDENTITY CASCADE`);
}
