import { z } from 'zod';
import { defineRoute } from './contract.ts';
import { Instant, IsoDate } from './primitives.ts';

// Business day and night audit (tab 4 row "Night audit"; T-054, night audit T-073). A live
// property trades on one open business day; until night audit exists it rolls over when the
// property's local date changes.

export const DAY_STATUSES = ['OPEN', 'AUDITING', 'CLOSED'] as const;

export const BusinessDayItem = z
  .object({
    date: IsoDate,
    status: z.enum(DAY_STATUSES),
    /** Null while the property is not live (it has no business days yet). */
    openedAt: Instant.nullable(),
  })
  .meta({ id: 'BusinessDay' });

export const getBusinessDay = defineRoute({
  operationId: 'getBusinessDay',
  method: 'get',
  path: '/business-day',
  summary: 'The property’s current business day',
  tags: ['Night audit'],
  propertyScoped: true,
  permission: 'audit.run',
  response: BusinessDayItem,
});

export const NIGHT_AUDIT_ROUTES = { getBusinessDay } as const;
