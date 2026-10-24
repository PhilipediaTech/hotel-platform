import { describe, expect, it } from 'vitest';
import { pgErrorInfo } from './db.ts';

function prismaLikeError(originalCode: string, originalMessage: string) {
  return { meta: { driverAdapterError: { cause: { originalCode, originalMessage } } } };
}

describe('pgErrorInfo', () => {
  it('reads SQLSTATE and constraint from a driver-adapter error', () => {
    const err = prismaLikeError(
      '23505',
      'duplicate key value violates unique constraint "users_email_key"',
    );
    expect(pgErrorInfo(err)).toEqual({ sqlState: '23505', constraint: 'users_email_key' });
  });

  it('returns an undefined constraint when PostgreSQL names none', () => {
    expect(pgErrorInfo(prismaLikeError('40001', 'could not serialize access'))).toEqual({
      sqlState: '40001',
      constraint: undefined,
    });
  });

  it.each([null, undefined, new Error('plain'), { meta: {} }, 'string'])(
    'returns undefined for %j',
    (err) => {
      expect(pgErrorInfo(err)).toBeUndefined();
    },
  );
});
