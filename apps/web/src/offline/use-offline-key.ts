import { useQueryClient } from '@tanstack/react-query';
import { ME_QUERY_KEY, useSession, type MeResponse } from '../app/session.ts';

/** The saved-copy key of a list for the signed-in person and current property (T-093). */
export function useOfflineKey(name: string): string {
  const queryClient = useQueryClient();
  const { currentPropertyId } = useSession();
  const userId = queryClient.getQueryData<MeResponse>(ME_QUERY_KEY)?.user.id ?? '';
  return `${userId}|${currentPropertyId ?? ''}|${name}`;
}

/** Who a queued action belongs to (T-093). */
export function useOfflineWho(): { userId: string; propertyId: string } {
  const queryClient = useQueryClient();
  const { currentPropertyId } = useSession();
  return {
    userId: queryClient.getQueryData<MeResponse>(ME_QUERY_KEY)?.user.id ?? '',
    propertyId: currentPropertyId ?? '',
  };
}
