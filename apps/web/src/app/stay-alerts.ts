import { useQuery } from '@tanstack/react-query';
import { api } from '../lib/api.ts';

// Front desk alerts (PRD M14-01; T-055): one query shared by the top bar's count and the
// front desk's Alerts tab, under the front desk key so check-ins, check-outs and payments
// that refresh the lists refresh it too.

export const stayAlertsKey = (propertyId: string | null) => [
  'front-desk',
  propertyId ?? '',
  'alerts',
];

/** Refreshed every minute: the alerts follow the clock as well as the data. */
export function useStayAlerts(propertyId: string | null, enabled: boolean) {
  return useQuery({
    queryKey: stayAlertsKey(propertyId),
    queryFn: () => api.call('listStayAlerts', {}),
    enabled: enabled && !!propertyId,
    refetchInterval: 60_000,
  });
}
