import { createContext, useContext } from 'react';

export interface ShellProperty {
  id: string;
  code: string;
  name: string;
  timeZone: string;
  baseCurrency: string;
  /** BCP 47 locale for dates, numbers and money (tab 5 rule 8), e.g. en-NG. */
  locale: string;
}

/** What the shell needs to render. Filled from GET /me and the business day from T-010/T-013. */
export interface ShellSession {
  userName: string;
  permissions: readonly string[];
  properties: readonly ShellProperty[];
  currentPropertyId: string | null;
  /** YYYY-MM-DD from business_days (never the device clock); null until known. */
  businessDate: string | null;
  pendingApprovals: number;
  openAlerts: number;
  /** True while showing PREVIEW_SESSION instead of a real signed-in user. */
  preview: boolean;
}

/**
 * Placeholder until sign-in exists (T-010) so the shell can be viewed and tested.
 * Mirrors the seeded demo property. Every permission the shell knows about is granted.
 */
export const PREVIEW_SESSION: ShellSession = {
  userName: 'Demo Owner',
  permissions: [
    'owner.read',
    'report.dashboard',
    'report.audit',
    'frontdesk.read',
    'reservation.create',
    'folio.read',
    'shift.open',
    'audit.run',
    'hk.read',
    'hk.assign',
    'hk.work',
    'task.create',
    'task.work',
    'task.report',
    'handover.manage',
    'approval.decide',
    'leakage.review',
    'rate.manage',
    'message.send',
    'room.manage',
    'tax.manage',
    'role.manage',
    'import.run',
    'subscription.read',
    'audit.read',
  ],
  properties: [
    {
      id: '0d0d0d0d-0000-4000-8000-000000000002',
      code: 'LAG',
      name: 'Demo Lagos Hotel',
      timeZone: 'Africa/Lagos',
      baseCurrency: 'NGN',
      locale: 'en-NG',
    },
  ],
  currentPropertyId: '0d0d0d0d-0000-4000-8000-000000000002',
  businessDate: null,
  pendingApprovals: 0,
  openAlerts: 0,
  preview: true,
};

export const SessionContext = createContext<ShellSession>(PREVIEW_SESSION);

export function useSession(): ShellSession {
  return useContext(SessionContext);
}
