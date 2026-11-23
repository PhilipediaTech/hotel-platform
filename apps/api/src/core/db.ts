import { PrismaPg } from '@prisma/adapter-pg';
import pg from 'pg';
import { PrismaClient, type Prisma } from '../generated/prisma/client.ts';
import { currentTenant } from './tenancy.ts';

export type Db = PrismaClient;
/** Either the root client or the `tx` handed to `db.$transaction(async (tx) => …)`. */
export type DbClient = PrismaClient | Prisma.TransactionClient;

// Row-level security (spec tab 2 "Tenancy", tab 3 rule 6; T-144): the second tenancy layer.
// Every tenant table has a policy that compares its row with `app.property_id` (or
// `app.organisation_id`). The pool sets both from the current tenant each time a query or
// transaction takes a connection, and clears them when there is no tenant, so a query
// can only ever see the tenant of the code that runs it. Code with no tenant (sign-in,
// platform, the worker's sweeps, migrations) sets nothing and the policies let it through:
// the application layer (tenant-db.ts) stays the first line.

const TENANT_KEY = Symbol('tenant');

type TaggedClient = pg.PoolClient & { [TENANT_KEY]?: string };
type ConnectCallback = (
  err: Error | undefined,
  client: pg.PoolClient | undefined,
  done: (release?: unknown) => void,
) => void;

/** A pg pool that hands out connections already set to the caller's tenant. */
export class TenantPool extends pg.Pool {
  /** Tests only: run as this (non-superuser) role, so the policies apply as in production. */
  private readonly role: string | undefined;

  constructor(config: pg.PoolConfig, role?: string) {
    super(config);
    if (role !== undefined && !/^[a-z_][a-z0-9_]*$/.test(role)) {
      throw new Error('Invalid database role name');
    }
    this.role = role;
  }

  override connect(): Promise<pg.PoolClient>;
  override connect(callback: ConnectCallback): void;
  override connect(callback?: ConnectCallback): Promise<pg.PoolClient> | void {
    // Read now, in the caller's async context: the pool may hand the connection out later.
    const tenant = currentTenant();
    const key = tenant ? `${tenant.propertyId}|${tenant.organisationId}` : '';
    const ready = (super.connect() as Promise<TaggedClient>).then(async (client) => {
      try {
        if (client[TENANT_KEY] === undefined && this.role) {
          await client.query(`SET ROLE ${this.role}`);
        }
        if (client[TENANT_KEY] !== key) {
          await client.query(
            "SELECT set_config('app.property_id', $1, false), set_config('app.organisation_id', $2, false)",
            [tenant?.propertyId ?? '', tenant?.organisationId ?? ''],
          );
          client[TENANT_KEY] = key;
        }
        return client;
      } catch (err) {
        // A connection in an unknown state is thrown away, never reused.
        client.release(err instanceof Error ? err : true);
        throw err;
      }
    });
    if (!callback) return ready;
    ready.then(
      (client) => callback(undefined, client, (release) => client.release(release as boolean)),
      (err: unknown) =>
        callback(err instanceof Error ? err : new Error(String(err)), undefined, () => undefined),
    );
  }
}

/** Prisma 7 talks to PostgreSQL through the `pg` driver adapter. */
export function createDb(databaseUrl: string, options: { role?: string } = {}): Db {
  const pool = new TenantPool({ connectionString: databaseUrl }, options.role);
  return new PrismaClient({ adapter: new PrismaPg(pool, { disposeExternalPool: true }) });
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

/**
 * True when the error is a trigger's `RAISE EXCEPTION '<text>'` (SQLSTATE P0001). Answers
 * yes or no only, so the database's message (which may hold row data) is never passed on.
 */
export function raisedBy(err: unknown, text: string): boolean {
  const cause = (
    err as { meta?: { driverAdapterError?: { cause?: Record<string, unknown> } } } | null
  )?.meta?.driverAdapterError?.cause;
  return cause?.['originalCode'] === 'P0001' && cause['originalMessage'] === text;
}
