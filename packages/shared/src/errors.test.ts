import { describe, expect, it } from 'vitest';
import { ERROR_HTTP_STATUS, isErrorCode } from './errors.ts';

// Copied from spec tab 4 so a change to either side fails this test.
const SPEC_TABLE: Record<number, string[]> = {
  400: ['VALIDATION_ERROR'],
  401: ['UNAUTHENTICATED', 'MFA_REQUIRED', 'SESSION_EXPIRED'],
  403: ['FORBIDDEN', 'MODULE_DISABLED', 'PROPERTY_NOT_LIVE'],
  404: ['NOT_FOUND'],
  409: [
    'BOOKING_CONFLICT',
    'VERSION_CONFLICT',
    'STATE_TRANSITION_INVALID',
    'IDEMPOTENCY_KEY_REUSED',
    'PAYMENT_DUPLICATE',
    'BUSINESS_DAY_CLOSED',
    'SHIFT_NOT_OPEN',
    'ROOM_NOT_READY',
    'FOLIO_BALANCE_OUTSTANDING',
    'CREDIT_LIMIT_EXCEEDED',
    'AUDIT_IN_PROGRESS',
    // Added in T-023 (not in tab 4): file not scanned yet, or blocked.
    'FILE_NOT_READY',
  ],
  422: ['RATE_BELOW_LIMIT', 'RESTRICTION_VIOLATED', 'APPROVAL_EXPIRED'],
  429: ['RATE_LIMITED'],
  500: ['INTERNAL'],
};

describe('ERROR_HTTP_STATUS', () => {
  it('matches the spec error table exactly', () => {
    const fromCode: Record<number, string[]> = {};
    for (const [code, status] of Object.entries(ERROR_HTTP_STATUS)) {
      (fromCode[status] ??= []).push(code);
    }
    for (const codes of Object.values(fromCode)) codes.sort();
    const expected = Object.fromEntries(
      Object.entries(SPEC_TABLE).map(([status, codes]) => [status, [...codes].sort()]),
    );
    expect(fromCode).toEqual(expected);
  });
});

describe('isErrorCode', () => {
  it('accepts known codes', () => {
    expect(isErrorCode('BOOKING_CONFLICT')).toBe(true);
  });

  it.each(['booking_conflict', 'UNKNOWN', 'toString', 42, null])('rejects %j', (value) => {
    expect(isErrorCode(value)).toBe(false);
  });
});
