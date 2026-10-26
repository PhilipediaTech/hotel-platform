import { z } from 'zod';
import { defineRoute } from './contract.ts';
import { Instant, page, PageQuery, Uuid } from './primitives.ts';

// Audit log (tab 4 row "Audit"; PRD M1-11; S27). Events of the property named by
// X-Property-Id plus the organisation-level ones (roles, people, sign-ins). T-014.

/** Who did it: a person, the platform itself, or platform support. */
export const AuditActorType = z.enum(['USER', 'SYSTEM', 'SUPPORT']).meta({ id: 'AuditActorType' });

export const AuditEvent = z
  .object({
    /** Monotonic; a string because it is a 64-bit integer. */
    id: z.string(),
    occurredAt: Instant,
    actorType: AuditActorType,
    actor: z.object({ id: Uuid, name: z.string() }).nullable(),
    /** `resource.verb`, e.g. `role.updated`, `auth.signed_in`. */
    action: z.string(),
    entityType: z.string(),
    entityId: z.string(),
    /** Null for organisation-level events. */
    propertyId: Uuid.nullable(),
    before: z.unknown().nullable(),
    after: z.unknown().nullable(),
    reason: z.string().nullable(),
    approvalRequestId: Uuid.nullable(),
    requestId: z.string().nullable(),
    ip: z.string().nullable(),
    userAgent: z.string().nullable(),
  })
  .meta({ id: 'AuditEvent' });

export const AuditEventsQuery = PageQuery.extend({
  actorUserId: Uuid.optional(),
  entityType: z.string().min(1).max(60).optional(),
  entityId: z.string().min(1).max(100).optional(),
  /** Matches the action or every action under it: `user` matches `user.disabled`. */
  action: z
    .string()
    .regex(/^[a-z_]+(\.[a-z_]+)*$/)
    .max(60)
    .optional(),
  /** Inclusive lower bound on `occurredAt`. */
  from: Instant.optional(),
  /** Exclusive upper bound on `occurredAt`. */
  to: Instant.optional(),
});

export const listAuditEvents = defineRoute({
  operationId: 'listAuditEvents',
  method: 'get',
  path: '/audit-events',
  summary: 'The audit log, newest first',
  tags: ['Audit'],
  propertyScoped: true,
  permission: 'audit.read',
  query: AuditEventsQuery,
  response: page(AuditEvent),
});

export const AUDIT_ROUTES = { listAuditEvents } as const;
