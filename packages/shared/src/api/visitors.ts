import { z } from 'zod';
import { Phone } from './auth.ts';
import { defineRoute } from './contract.ts';
import { Instant, IsoDate, Uuid } from './primitives.ts';

// The visitor register (PRD M14-04, M14-05; T-057). The front desk or security signs a visitor
// in against a checked-in guest and out again. A visitor still signed in after the property's
// cut-off raises the VISITOR_OVERSTAY leakage alert, unless an extra person was added to the
// stay since they came (T-056).

export const VisitorItem = z
  .object({
    id: Uuid,
    stayId: Uuid,
    reservationId: Uuid,
    guestName: z.string(),
    roomNumber: z.string().nullable(),
    name: z.string(),
    phone: z.string().nullable(),
    note: z.string().nullable(),
    /** The ID photo, until the retention period clears it. */
    idFileId: Uuid.nullable(),
    signedInAt: Instant,
    signedInBy: z.string(),
    signedOutAt: Instant.nullable(),
  })
  .meta({ id: 'Visitor' });

export const VisitorQuery = z.object({
  /** Day they signed in, at the property; today when left out. Everyone still in is always listed. */
  date: IsoDate.optional(),
});

export const VisitorBody = z.object({
  /** The checked-in stay they are visiting. */
  stayId: Uuid,
  name: z.string().trim().min(1).max(120),
  phone: Phone.nullable().default(null),
  note: z.string().trim().max(500).nullable().default(null),
  /** An uploaded file of kind Visitor. */
  idFileId: Uuid.nullable().default(null),
});

export const listVisitors = defineRoute({
  operationId: 'listVisitors',
  method: 'get',
  path: '/visitors',
  summary: 'Visitors still signed in, then those who came on the date',
  tags: ['Front desk'],
  propertyScoped: true,
  permission: 'visitor.log',
  query: VisitorQuery,
  response: z.object({ date: IsoDate, data: z.array(VisitorItem) }),
});

export const signInVisitor = defineRoute({
  operationId: 'signInVisitor',
  method: 'post',
  path: '/visitors',
  summary: 'Sign a visitor in to a checked-in guest',
  description: '409 STATE_TRANSITION_INVALID when the stay is not checked in.',
  tags: ['Front desk'],
  propertyScoped: true,
  permission: 'visitor.log',
  idempotent: true,
  body: VisitorBody,
  status: 201,
  response: VisitorItem,
  errors: ['STATE_TRANSITION_INVALID'],
});

export const signOutVisitor = defineRoute({
  operationId: 'signOutVisitor',
  method: 'post',
  path: '/visitors/{visitorId}/sign-out',
  summary: 'Sign a visitor out',
  description: '409 STATE_TRANSITION_INVALID when they have already left.',
  tags: ['Front desk'],
  propertyScoped: true,
  permission: 'visitor.log',
  idempotent: true,
  params: z.object({ visitorId: Uuid }),
  body: z.object({}),
  response: VisitorItem,
  errors: ['STATE_TRANSITION_INVALID'],
});

export const VISITOR_ROUTES = { listVisitors, signInVisitor, signOutVisitor } as const;
