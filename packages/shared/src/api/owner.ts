import { z } from 'zod';
import { defineRoute } from './contract.ts';
import { AmountMinor, IsoDate, Uuid } from './primitives.ts';

// Owner home (PRD M6-11, M4-15; tab 4 row "Owner": GET /owner/home, all properties; S04;
// T-091). One card per property the caller owns: today's numbers, cash and transfers,
// alerts and approvals waiting, and the last closed day's flash report.

export const OwnerFlash = z.object({
  businessDate: IsoDate,
  roomsAvailable: z.number().int(),
  roomsSold: z.number().int(),
  /** Rooms sold ÷ rooms available, in basis points (7200 = 72%). */
  occupancyBps: z.number().int(),
  roomRevenueMinor: AmountMinor,
  /** Room revenue ÷ rooms sold (night stays). */
  adrMinor: AmountMinor,
  /** Room revenue ÷ rooms available. */
  revparMinor: AmountMinor,
  paymentsMinor: AmountMinor,
});

export const OwnerPropertyCard = z
  .object({
    id: Uuid,
    code: z.string(),
    name: z.string(),
    currency: z.string(),
    status: z.string(),
    /** The open business day the "today" figures are for. */
    businessDate: IsoDate,
    roomsAvailable: z.number().int(),
    /** Rooms with a guest checked in for the night (day-use excluded). */
    roomsOccupied: z.number().int(),
    occupancyBps: z.number().int(),
    /** Charges posted on the business day, without deposits and transfers between folios. */
    revenueTodayMinor: AmountMinor,
    /** The same, from the first of the month through the business day. */
    revenueMonthMinor: AmountMinor,
    cashTodayMinor: AmountMinor,
    /** Bank transfers and virtual-account payments of the day. */
    transfersTodayMinor: AmountMinor,
    openAlerts: z.number().int(),
    pendingApprovals: z.number().int(),
    lastFlash: OwnerFlash.nullable(),
  })
  .meta({ id: 'OwnerPropertyCard' });

export const getOwnerHome = defineRoute({
  operationId: 'getOwnerHome',
  method: 'get',
  path: '/owner/home',
  summary: 'Owner home: a card per property (M6-11)',
  description:
    'Every property of the organisation where the caller holds owner.read, whichever ' +
    'property the request names. Figures are live for the open business day; the flash ' +
    'report is the last closed day’s, as night audit kept it.',
  tags: ['Owner'],
  propertyScoped: true,
  permission: 'owner.read',
  module: 'owner',
  response: z.object({ properties: z.array(OwnerPropertyCard) }),
});

export const OWNER_ROUTES = { getOwnerHome } as const;
