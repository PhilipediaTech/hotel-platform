import { z } from 'zod';
import { defineRoute } from './contract.ts';
import { Uuid } from './primitives.ts';

// Getting started (Versions V2 "enhanced onboarding"; T-172): each person's first steps for
// their role, done when they really do them; managers see who has finished.

const Step = z.object({
  id: z.string(),
  /** Where it is done. */
  path: z.string(),
  done: z.boolean(),
});

export const listGettingStarted = defineRoute({
  operationId: 'listGettingStarted',
  method: 'get',
  path: '/getting-started',
  summary: 'The caller’s first steps here, and which are done',
  tags: ['Support'],
  propertyScoped: true,
  response: z.object({
    steps: z.array(Step),
    done: z.number().int(),
    total: z.number().int(),
  }),
});

export const GettingStartedMember = z
  .object({
    user: z.object({ id: Uuid, name: z.string() }),
    roles: z.array(z.string()),
    done: z.number().int(),
    total: z.number().int(),
    /** Steps not done yet. */
    missing: z.array(z.string()),
  })
  .meta({ id: 'GettingStartedMember' });

export const listTeamGettingStarted = defineRoute({
  operationId: 'listTeamGettingStarted',
  method: 'get',
  path: '/getting-started/team',
  summary: 'Every staff member here, with how many of their first steps are done',
  tags: ['Support'],
  propertyScoped: true,
  permission: 'staff.manage',
  response: z.object({ data: z.array(GettingStartedMember) }),
});

export const GETTING_STARTED_ROUTES = { listGettingStarted, listTeamGettingStarted } as const;
