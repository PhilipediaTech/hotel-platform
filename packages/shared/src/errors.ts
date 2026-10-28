/**
 * Stable API error codes and the HTTP status each maps to (spec tab 4, "Error envelope").
 * Clients branch on `code`, never on `message`.
 */
export const ERROR_HTTP_STATUS = {
  VALIDATION_ERROR: 400,

  UNAUTHENTICATED: 401,
  MFA_REQUIRED: 401,
  SESSION_EXPIRED: 401,

  FORBIDDEN: 403,
  MODULE_DISABLED: 403,
  PROPERTY_NOT_LIVE: 403,

  // Also returned for other tenants' records, so their existence never leaks.
  NOT_FOUND: 404,

  BOOKING_CONFLICT: 409,
  VERSION_CONFLICT: 409,
  STATE_TRANSITION_INVALID: 409,
  IDEMPOTENCY_KEY_REUSED: 409,
  PAYMENT_DUPLICATE: 409,
  BUSINESS_DAY_CLOSED: 409,
  SHIFT_NOT_OPEN: 409,
  ROOM_NOT_READY: 409,
  FOLIO_BALANCE_OUTSTANDING: 409,
  CREDIT_LIMIT_EXCEEDED: 409,
  AUDIT_IN_PROGRESS: 409,
  // Not in tab 4 (T-023): the file is still being scanned, or the scan blocked it.
  FILE_NOT_READY: 409,

  RATE_BELOW_LIMIT: 422,
  RESTRICTION_VIOLATED: 422,
  APPROVAL_EXPIRED: 422,

  RATE_LIMITED: 429,

  // Never carries details.
  INTERNAL: 500,
} as const;

export type ErrorCode = keyof typeof ERROR_HTTP_STATUS;

export interface ErrorBody {
  code: ErrorCode;
  message: string;
  details?: Record<string, unknown>;
  requestId: string;
}

export interface ErrorEnvelope {
  error: ErrorBody;
}

export function isErrorCode(value: unknown): value is ErrorCode {
  return typeof value === 'string' && Object.hasOwn(ERROR_HTTP_STATUS, value);
}
