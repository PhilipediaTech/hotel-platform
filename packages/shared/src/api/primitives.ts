import { z } from 'zod';
import { ERROR_HTTP_STATUS, type ErrorCode } from '../errors.ts';

// Wire formats from spec tab 4, "Conventions". Every request and response schema is built
// from these so the OpenAPI document, server validation and client types agree.
//
// Response schemas must not use transforms: the client trusts the server's output type
// without re-parsing, so what a schema outputs must be exactly what goes over the wire.

export const Uuid = z.uuid().meta({ id: 'Uuid', example: '0d0d0d0d-0000-4000-8000-000000000002' });

/** Calendar date, no time zone: `YYYY-MM-DD`. */
export const IsoDate = z.iso.date().meta({ id: 'IsoDate', example: '2026-11-12' });

/** Instant in ISO 8601 UTC, e.g. `2026-11-12T09:30:00Z`. */
export const Instant = z.iso
  .datetime({ offset: false })
  .meta({ id: 'Instant', example: '2026-11-12T09:30:00Z' });

/** ISO 4217 code. */
export const CurrencyCode = z
  .string()
  .regex(/^[A-Z]{3}$/)
  .meta({ id: 'CurrencyCode', example: 'NGN' });

/**
 * Money in minor units as a decimal string (kobo, cents), because BigInt does not fit JSON
 * numbers safely. Negative for credits.
 */
export const AmountMinor = z
  .string()
  .regex(/^-?(0|[1-9]\d{0,17})$/, 'Expected an integer amount in minor units, as a string')
  .meta({ id: 'AmountMinor', example: '4500000' });

export const Money = z
  .object({ amountMinor: AmountMinor, currency: CurrencyCode })
  .meta({ id: 'Money', description: 'An amount in minor units with its currency.' });

export const MAX_PAGE_LIMIT = 200;
export const DEFAULT_PAGE_LIMIT = 50;

/** Cursor pagination query: `?limit=50&cursor=<opaque>`. */
export const PageQuery = z.object({
  limit: z.coerce.number().int().min(1).max(MAX_PAGE_LIMIT).default(DEFAULT_PAGE_LIMIT),
  cursor: z.string().min(1).max(512).optional(),
});

/** Cursor page response: `{ data: [...], nextCursor }`. */
export function page<T extends z.ZodType>(item: T) {
  return z.object({ data: z.array(item), nextCursor: z.string().nullable() });
}

const errorCodes = Object.keys(ERROR_HTTP_STATUS) as [ErrorCode, ...ErrorCode[]];

export const ErrorEnvelopeSchema = z
  .object({
    error: z.object({
      code: z.enum(errorCodes),
      message: z.string(),
      details: z.record(z.string(), z.unknown()).optional(),
      requestId: z.string().meta({ example: 'req_6f1c0c3f2b8a4e7d9a1b2c3d4e5f6a7b' }),
    }),
  })
  .meta({
    id: 'ErrorEnvelope',
    description: 'Every error response. Clients branch on `code`, never on `message`.',
  });

/**
 * Body of a 202 when an action needs approval (tab 4, "Approvals"). Tab 5 rule: the screen
 * shows "Sent for approval" with the approver and the expiry, hence the two extra fields.
 */
export const ApprovalPending = z
  .object({
    approvalRequestId: Uuid,
    status: z.literal('PENDING'),
    expiresAt: Instant,
    /** Names of the roles that can decide. */
    approverRoles: z.array(z.string()),
  })
  .meta({ id: 'ApprovalPending' });
