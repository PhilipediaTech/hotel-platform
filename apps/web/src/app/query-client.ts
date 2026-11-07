import { QueryClient } from '@tanstack/react-query';

const MAX_RETRIES = 2;

/** An error carrying an HTTP status (the typed API client from T-007 throws these). */
function httpStatus(error: unknown): number | undefined {
  const status = (error as { status?: unknown } | null)?.status;
  return typeof status === 'number' ? status : undefined;
}

/**
 * Retry network failures and 5xx a couple of times; never retry 4xx (validation,
 * permission, tenancy and conflict errors won't fix themselves).
 */
export function shouldRetry(failureCount: number, error: unknown): boolean {
  const status = httpStatus(error);
  if (status !== undefined && status < 500) return false;
  return failureCount < MAX_RETRIES;
}

export function createQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      // offlineFirst (T-093): offline, a query still runs once, so saved lists answer
      // instead of the screen waiting for the network; retries wait for the connection.
      queries: {
        staleTime: 30_000,
        retry: shouldRetry,
        refetchOnWindowFocus: true,
        networkMode: 'offlineFirst',
      },
      // Writes are never retried automatically: money and room actions use idempotency keys
      // and the user decides whether to resend. They always run (T-093): offline, the
      // whitelisted ones are queued and the rest are refused at once with a clear message,
      // instead of waiting silently for the connection.
      mutations: { retry: false, networkMode: 'always' },
    },
  });
}
