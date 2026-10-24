import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient, type Prisma } from '../generated/prisma/client.ts';

export type Db = PrismaClient;
/** Either the root client or the `tx` handed to `db.$transaction(async (tx) => …)`. */
export type DbClient = PrismaClient | Prisma.TransactionClient;

/** Prisma 7 talks to PostgreSQL through the `pg` driver adapter. */
export function createDb(databaseUrl: string): Db {
  return new PrismaClient({ adapter: new PrismaPg({ connectionString: databaseUrl }) });
}

export interface PgErrorInfo {
  /** PostgreSQL SQLSTATE, e.g. 23505 unique, 23503 foreign key, 23514 check, 23P01 exclusion. */
  sqlState: string;
  /** Constraint or index name when PostgreSQL reports one. */
  constraint: string | undefined;
}

const CONSTRAINT_IN_MESSAGE = /constraint "([^"]+)"/;

/** Pulls the PostgreSQL error code and constraint name out of a Prisma driver-adapter error. */
export function pgErrorInfo(err: unknown): PgErrorInfo | undefined {
  const cause = (
    err as { meta?: { driverAdapterError?: { cause?: Record<string, unknown> } } } | null
  )?.meta?.driverAdapterError?.cause;
  if (!cause || typeof cause.originalCode !== 'string') return undefined;
  const message = typeof cause.originalMessage === 'string' ? cause.originalMessage : '';
  return {
    sqlState: cause.originalCode,
    constraint: CONSTRAINT_IN_MESSAGE.exec(message)?.[1],
  };
}
