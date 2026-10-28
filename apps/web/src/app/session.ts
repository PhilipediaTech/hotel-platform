import type { Me } from '@hotel/shared';
import { createContext, useContext } from 'react';
import type { z } from 'zod';

export interface ShellProperty {
  id: string;
  code: string;
  name: string;
  /** SETUP until the owner finishes the checklist and goes live (M1-02). */
  status: 'SETUP' | 'LIVE' | 'SUSPENDED' | 'ARCHIVED';
  timeZone: string;
  baseCurrency: string;
  /** BCP 47 locale for dates, numbers and money (tab 5 rule 8), e.g. en-NG. */
  locale: string;
}

/** What the shell needs to render: from GET /me; business date and counts arrive later. */
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
  /** A manager-opened shared device: offer "Switch user" (PIN, M1-07). */
  pinSwitchAvailable: boolean;
}

export type MeResponse = z.output<typeof Me>;

/** Queries about approval requests start with this key (the inbox invalidates them all). */
export const APPROVALS_QUERY_KEY = ['approvals'] as const;

/** Query key of GET /me; sign-in seeds it, sign-out clears it. */
export const ME_QUERY_KEY = ['me'] as const;

/**
 * Builds the shell session from GET /me for one property (the stored choice if the user
 * still has it, else the first). Permissions are the union of the user's roles that apply
 * there: property roles for that property and organisation-wide roles of its organisation.
 */
export function toShellSession(me: MeResponse, wantedPropertyId: string | null): ShellSession {
  const property = me.properties.find((p) => p.id === wantedPropertyId) ?? me.properties[0];
  const permissions = new Set<string>();
  if (property) {
    for (const m of me.memberships) {
      const applies =
        m.organisationId === property.organisationId &&
        (m.propertyId === null || m.propertyId === property.id);
      if (applies) for (const code of m.role.permissions) permissions.add(code);
    }
  }
  return {
    userName: me.user.name,
    permissions: [...permissions].sort(),
    properties: me.properties.map(({ id, code, name, status, timeZone, baseCurrency, locale }) => ({
      id,
      code,
      name,
      status,
      timeZone,
      baseCurrency,
      locale,
    })),
    currentPropertyId: property?.id ?? null,
    businessDate: null, // business_days arrive with night audit (T-070s)
    pendingApprovals: 0, // filled in by SessionGate from GET /approvals (T-022)
    openAlerts: 0, // T-090
    preview: false,
    pinSwitchAvailable: me.session.pinSwitchAvailable,
  };
}

export interface SessionActions {
  signOut: () => void;
  /** Ends this PIN session and opens the PIN screen for the next person. */
  switchUser: () => void;
  switchProperty: (propertyId: string) => void;
}

export const SessionActionsContext = createContext<SessionActions>({
  signOut: () => undefined,
  switchUser: () => undefined,
  switchProperty: () => undefined,
});

export function useSessionActions(): SessionActions {
  return useContext(SessionActionsContext);
}

/**
 * Fixed session for component tests and previews (the app itself uses GET /me).
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
      status: 'SETUP',
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
  pinSwitchAvailable: false,
};

export const SessionContext = createContext<ShellSession>(PREVIEW_SESSION);

export function useSession(): ShellSession {
  return useContext(SessionContext);
}
