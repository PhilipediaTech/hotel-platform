import { z } from 'zod';
import { defineRoute } from './contract.ts';
import { AmountMinor, IsoDate, Uuid } from './primitives.ts';

// Travel-agent commissions (PRD M4-22 "As finance, I calculate and settle travel-agent
// commissions", ar.commission; tab 3 commissions; T-127). Tab 4 lists no routes for it. A
// commission is earned on a checked-out stay booked through a travel agent: the agent's rate on
// the stay's room revenue net of tax (discounts and reversals counted). It is then paid to the
// agent, or set off against what the agent owes on the city ledger.

export const COMMISSION_STATUSES = ['DUE', 'PAID', 'OFFSET'] as const;

export const CommissionItem = z
  .object({
    id: Uuid,
    agent: z.object({ id: Uuid, name: z.string() }),
    stay: z.object({
      id: Uuid,
      confirmationNo: z.string(),
      guestName: z.string(),
      arrival: IsoDate,
      departure: IsoDate,
    }),
    checkedOutOn: IsoDate,
    /** Room revenue net of tax. */
    baseMinor: AmountMinor,
    rateBps: z.number().int(),
    amountMinor: AmountMinor,
    status: z.enum(COMMISSION_STATUSES),
    settledOn: IsoDate.nullable(),
    reference: z.string().nullable(),
  })
  .meta({ id: 'Commission' });

export const CommissionList = z
  .object({
    data: z.array(CommissionItem),
    /** What is still due on the commissions listed. */
    dueMinor: AmountMinor,
  })
  .meta({ id: 'CommissionList' });

export const CommissionCalculateBody = z
  .object({ from: IsoDate, to: IsoDate })
  .refine((q) => q.to >= q.from, { path: ['to'], message: 'The end is on or after the start' });

export const CommissionCalculateResult = z
  .object({
    /** New commissions. */
    created: z.number().int(),
    /** Due commissions whose stay's room revenue changed since. */
    updated: z.number().int(),
    data: z.array(CommissionItem),
  })
  .meta({ id: 'CommissionCalculateResult' });

export const CommissionSettleBody = z.object({
  commissionIds: z.array(Uuid).min(1).max(200),
  /** PAID: paid to the agent. OFFSET: credited to the agent's city-ledger account. */
  as: z.enum(['PAID', 'OFFSET']),
  settledOn: IsoDate,
  reference: z.string().trim().max(80).nullable().default(null),
});

const COMMON = {
  tags: ['City ledger'],
  propertyScoped: true as const,
  permission: 'ar.commission',
};

export const listCommissions = defineRoute({
  ...COMMON,
  operationId: 'listCommissions',
  method: 'get',
  path: '/commissions',
  summary: 'Travel-agent commissions (M4-22)',
  query: z.object({
    status: z.enum(COMMISSION_STATUSES).optional(),
    agentId: Uuid.optional(),
  }),
  response: CommissionList,
});

export const calculateCommissions = defineRoute({
  ...COMMON,
  operationId: 'calculateCommissions',
  method: 'post',
  path: '/commissions/calculate',
  summary: 'Work out commissions on stays checked out in a period (M4-22)',
  description:
    'For each stay checked out in the period and booked through a travel agent with a commission rate: the rate on the room revenue net of tax. Running it again adds new stays and brings due ones up to date; settled ones never change.',
  idempotent: true,
  body: CommissionCalculateBody,
  response: CommissionCalculateResult,
});

export const settleCommissions = defineRoute({
  ...COMMON,
  operationId: 'settleCommissions',
  method: 'post',
  path: '/commissions/settle',
  summary: 'Mark commissions paid, or set them off against the agent’s account (M4-22)',
  description:
    'All must be due and for one agent. OFFSET credits the total to the agent’s city-ledger account and allocates it to the oldest open invoices.',
  idempotent: true,
  body: CommissionSettleBody,
  response: z.object({ data: z.array(CommissionItem) }),
  errors: ['STATE_TRANSITION_INVALID'],
});

export const COMMISSION_ROUTES = {
  listCommissions,
  calculateCommissions,
  settleCommissions,
} as const;
