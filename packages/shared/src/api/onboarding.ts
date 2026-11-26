import { z } from 'zod';
import { IMPORT_KINDS } from '../imports.ts';
import { defineRoute } from './contract.ts';
import { Instant, Uuid } from './primitives.ts';

// Onboarding tracker (Versions V2 "enhanced onboarding"; Strategy "go-live within 2 working
// days", "remote training sessions per role", "named onboarding contact"; T-171, Philip
// 2026-11-26). Platform staff follow each property toward go-live in S31 and book training per
// role; the hotel sees its own sessions under Help.

const Ref = z.object({ id: Uuid, name: z.string() });

export const TrainingSessionItem = z
  .object({
    id: Uuid,
    role: Ref,
    /** Null: for the whole group. */
    propertyName: z.string().nullable(),
    scheduledAt: Instant,
    heldAt: Instant.nullable(),
    cancelledAt: Instant.nullable(),
    trainer: Ref,
    note: z.string().nullable(),
  })
  .meta({ id: 'TrainingSession' });

export const OnboardingRow = z
  .object({
    organisation: Ref,
    property: z.object({
      id: Uuid,
      name: z.string(),
      code: z.string(),
      status: z.enum(['SETUP', 'LIVE', 'SUSPENDED']),
    }),
    contact: Ref.nullable(),
    createdAt: Instant,
    /** When it went live; null while in setup (or live before this was recorded). */
    wentLiveAt: Instant.nullable(),
    /** Monday-to-Friday days from creation to go-live, or to today while in setup. */
    workingDays: z.number().int(),
    onTarget: z.boolean(),
    checklist: z.object({
      done: z.number().int(),
      required: z.number().int(),
      /** Required steps still to do. */
      todo: z.array(z.string()),
    }),
    /** Applied imports by kind. */
    imports: z.partialRecord(z.enum(IMPORT_KINDS), z.number().int()),
    staff: z.object({ members: z.number().int(), invitations: z.number().int() }),
    training: z.object({
      /** Roles with staff here and no session held for them yet. */
      needed: z.array(Ref),
      held: z.number().int(),
      next: z.object({ scheduledAt: Instant, role: z.string() }).nullable(),
    }),
  })
  .meta({ id: 'OnboardingRow' });

const PLATFORM = { tags: ['Platform'], platform: true as const };
const SessionParams = z.object({ sessionId: Uuid });

export const listOnboarding = defineRoute({
  ...PLATFORM,
  operationId: 'listOnboarding',
  method: 'get',
  path: '/platform/onboarding',
  summary: 'Every property’s way to go-live: properties in setup first, then the newest',
  response: z.object({ targetWorkingDays: z.number().int(), data: z.array(OnboardingRow) }),
});

export const listTenantTraining = defineRoute({
  ...PLATFORM,
  operationId: 'listTenantTraining',
  method: 'get',
  path: '/platform/tenants/{organisationId}/training',
  summary: 'A hotel group’s training sessions, with its roles and properties to book for',
  params: z.object({ organisationId: Uuid }),
  response: z.object({
    roles: z.array(Ref),
    properties: z.array(Ref),
    data: z.array(TrainingSessionItem),
  }),
});

export const bookTraining = defineRoute({
  ...PLATFORM,
  operationId: 'bookTraining',
  method: 'post',
  path: '/platform/tenants/{organisationId}/training',
  summary: 'Book a remote training session for a role (the caller trains)',
  params: z.object({ organisationId: Uuid }),
  status: 201,
  body: z.object({
    roleId: Uuid,
    propertyId: Uuid.nullable().default(null),
    scheduledAt: Instant,
    note: z.string().trim().max(500).nullable().default(null),
  }),
  response: TrainingSessionItem,
});

export const markTrainingHeld = defineRoute({
  ...PLATFORM,
  operationId: 'markTrainingHeld',
  method: 'post',
  path: '/platform/training/{sessionId}/held',
  summary: 'Record that a training session took place',
  params: SessionParams,
  response: TrainingSessionItem,
  errors: ['STATE_TRANSITION_INVALID'],
});

export const cancelTraining = defineRoute({
  ...PLATFORM,
  operationId: 'cancelTraining',
  method: 'post',
  path: '/platform/training/{sessionId}/cancel',
  summary: 'Cancel a training session that has not taken place',
  params: SessionParams,
  response: TrainingSessionItem,
  errors: ['STATE_TRANSITION_INVALID'],
});

export const listMyTraining = defineRoute({
  tags: ['Support'],
  propertyScoped: true,
  operationId: 'listMyTraining',
  method: 'get',
  path: '/support/training',
  summary: 'The group’s training sessions with the support team (cancelled ones left out)',
  response: z.object({ data: z.array(TrainingSessionItem) }),
});

export const ONBOARDING_ROUTES = {
  listOnboarding,
  listTenantTraining,
  bookTraining,
  markTrainingHeld,
  cancelTraining,
  listMyTraining,
} as const;
