import { createHash } from 'node:crypto';
import type { RequestHandler, Request, Response } from 'express';
import type { ErrorCode } from '@hotel/shared';
import type { Prisma } from '../generated/prisma/client.ts';
import type { Clock } from './clock.ts';
import type { Db } from './db.ts';
import { AppError } from './errors.ts';

// Idempotency (tab 2 "Idempotency"; T-020). POSTs marked ● in tab 4 carry an
// `Idempotency-Key` (a UUID). The first request with a key claims it and runs; its response
// is stored for 48 hours. A repeat with the same body gets the stored response (header
// `Idempotent-Replayed: true`) without running again; a different body, method, path or
// property with the same key gets 409 IDEMPOTENCY_KEY_REUSED. Keys belong to the signed-in
// user, so two users can never collide.
//
// - Client errors (4xx) are stored and replayed like successes: the same request gets the
//   same answer. Server errors (5xx) release the key, so the client can safely retry.
// - A repeat while the first is still running gets 409 IDEMPOTENCY_KEY_REUSED with
//   `details.reason = 'IN_PROGRESS'` and `Retry-After`.
// - A claim left without a response for 5 minutes (the process died mid-request) can be
//   claimed again; handlers keep their own uniqueness constraints as the second line.

export const IDEMPOTENCY_TTL_MS = 48 * 60 * 60_000;
export const IDEMPOTENCY_STALE_MS = 5 * 60_000;

interface Store {
  db: Db;
  clock: Clock;
}

const STORE = Symbol('idempotency');

/** Middleware before the routes: makes the store available to `mountRoute`. */
export function idempotencyStore(store: Store): RequestHandler {
  return (_req, res, next) => {
    (res.locals as Record<symbol, Store>)[STORE] = store;
    next();
  };
}

/** Same JSON for the same data, whatever the key order. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

/** What makes two requests "the same": method, path with query, property and body. */
export function requestHash(req: Request): string {
  return createHash('sha256')
    .update(
      canonical({
        method: req.method,
        path: req.originalUrl,
        propertyId: req.get('X-Property-Id') ?? null,
        body: req.body as unknown,
      }),
    )
    .digest('base64url');
}

interface StoredError {
  error: { code: ErrorCode; message: string; details?: Record<string, unknown> };
}

export interface IdempotentResult {
  /** True when the stored response was sent instead of running the handler. */
  replayed: boolean;
  status: number;
  body: unknown;
}

/**
 * Runs `run` at most once per user and key. `run` returns the status and JSON body to send;
 * an AppError it throws is stored (4xx) or releases the key (5xx and any other error).
 */
export async function withIdempotency(
  req: Request,
  res: Response,
  userId: string,
  run: () => Promise<{ status: number; body: unknown }>,
): Promise<IdempotentResult> {
  const store = (res.locals as Record<symbol, Store | undefined>)[STORE];
  if (!store) throw new Error('idempotencyStore() middleware is not installed');
  const { db, clock } = store;
  const key = req.get('Idempotency-Key') ?? '';
  const hash = requestHash(req);
  const now = clock();
  const path = req.originalUrl.split('?')[0] ?? req.originalUrl;

  // Claim: a new key, an expired one, or one abandoned mid-request.
  const claimed = await db.$queryRaw<{ created_at: Date }[]>`
    INSERT INTO idempotency_keys (user_id, key, method, path, request_hash, created_at, expires_at)
    VALUES (${userId}::uuid, ${key}, ${req.method}, ${path}, ${hash}, ${now},
            ${new Date(now.getTime() + IDEMPOTENCY_TTL_MS)})
    ON CONFLICT (user_id, key) DO UPDATE SET
      method = EXCLUDED.method, path = EXCLUDED.path, request_hash = EXCLUDED.request_hash,
      response_status = NULL, response_body = NULL,
      created_at = EXCLUDED.created_at, expires_at = EXCLUDED.expires_at
    WHERE idempotency_keys.expires_at <= ${now}
       OR (idempotency_keys.response_status IS NULL
           AND idempotency_keys.created_at <= ${new Date(now.getTime() - IDEMPOTENCY_STALE_MS)})
    RETURNING created_at`;

  if (claimed.length === 0) {
    const existing = await db.idempotencyKey.findUnique({
      where: { userId_key: { userId, key } },
    });
    if (!existing || existing.requestHash !== hash) {
      throw new AppError(
        'IDEMPOTENCY_KEY_REUSED',
        'This Idempotency-Key was already used for a different request.',
      );
    }
    if (existing.responseStatus === null) {
      res.set('Retry-After', '1');
      throw new AppError(
        'IDEMPOTENCY_KEY_REUSED',
        'The first request with this Idempotency-Key is still being processed. Try again shortly.',
        { reason: 'IN_PROGRESS' },
      );
    }
    res.set('Idempotent-Replayed', 'true');
    if (existing.responseStatus >= 400) {
      const { error } = existing.responseBody as unknown as StoredError;
      throw new AppError(error.code, error.message, error.details);
    }
    return { replayed: true, status: existing.responseStatus, body: existing.responseBody };
  }

  const ours = { userId, key, createdAt: claimed[0]?.created_at ?? now };
  const save = (status: number, body: unknown) =>
    db.idempotencyKey.updateMany({
      where: ours,
      data: {
        responseStatus: status,
        responseBody: (body ?? null) as Prisma.InputJsonValue,
      },
    });
  let result: { status: number; body: unknown };
  try {
    result = await run();
  } catch (err) {
    if (err instanceof AppError && err.status < 500) {
      const stored: StoredError = {
        error: {
          code: err.code,
          message: err.message,
          ...(err.details && { details: err.details }),
        },
      };
      await save(err.status, stored);
    } else {
      await db.idempotencyKey.deleteMany({ where: { ...ours, responseStatus: null } });
    }
    throw err;
  }
  await save(result.status, result.body);
  return { replayed: false, ...result };
}
