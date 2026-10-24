import { describe, expect, it } from 'vitest';
import { createQueryClient, shouldRetry } from './query-client.ts';

describe('shouldRetry', () => {
  it.each([400, 401, 403, 404, 409, 422, 429])('never retries HTTP %i', (status) => {
    expect(shouldRetry(0, { status })).toBe(false);
  });

  it('retries 5xx and network errors twice, then stops', () => {
    expect(shouldRetry(0, { status: 503 })).toBe(true);
    expect(shouldRetry(1, new TypeError('Failed to fetch'))).toBe(true);
    expect(shouldRetry(2, { status: 500 })).toBe(false);
  });
});

describe('createQueryClient', () => {
  it('never retries mutations automatically', () => {
    expect(createQueryClient().getDefaultOptions().mutations?.retry).toBe(false);
  });
});
