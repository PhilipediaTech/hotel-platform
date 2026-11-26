import { z } from 'zod';
import { defineRoute } from './contract.ts';
import { Instant, Uuid } from './primitives.ts';

// In-app support (Versions V2 "enhanced onboarding, support tooling"; Strategy "Support":
// in-app chat, first response under 15 minutes in business hours, a named onboarding contact;
// T-170, Philip 2026-11-26). Hotel staff ask from Help; everyone sees what they asked, and
// support.manage sees and answers the whole group's. Platform staff answer from S31.

export const SUPPORT_URGENCIES = ['NORMAL', 'BLOCKER'] as const;
export const SUPPORT_STATUSES = ['OPEN', 'ANSWERED', 'RESOLVED'] as const;
/** Strategy tab: support first response under 15 minutes (business hours). */
export const SUPPORT_FIRST_RESPONSE_MINUTES = 15;

const Person = z.object({ id: Uuid, name: z.string() });

export const SupportMessageItem = z
  .object({
    id: Uuid,
    /** True for the platform team's answers. */
    fromPlatform: z.boolean(),
    author: Person,
    body: z.string(),
    createdAt: Instant,
  })
  .meta({ id: 'SupportMessage' });

export const SupportTicketSummary = z
  .object({
    id: Uuid,
    subject: z.string(),
    /** BLOCKER: the front desk can't work. */
    urgency: z.enum(SUPPORT_URGENCIES),
    /** OPEN: waiting on the support team; ANSWERED: waiting on the hotel. */
    status: z.enum(SUPPORT_STATUSES),
    /** The app page it was asked from. */
    page: z.string().nullable(),
    propertyName: z.string().nullable(),
    openedBy: Person,
    createdAt: Instant,
    lastMessageAt: Instant,
    firstResponseAt: Instant.nullable(),
    resolvedAt: Instant.nullable(),
    /** An answer this side hasn't opened yet. */
    unread: z.boolean(),
  })
  .meta({ id: 'SupportTicketSummary' });

export const SupportTicketDetail = SupportTicketSummary.extend({
  messages: z.array(SupportMessageItem),
}).meta({ id: 'SupportTicketDetail' });

/** The platform team's view adds the hotel group and who is on it. */
export const PlatformSupportTicket = SupportTicketSummary.extend({
  organisation: z.object({ id: Uuid, name: z.string() }),
  assignedAdmin: Person.nullable(),
}).meta({ id: 'PlatformSupportTicket' });

export const PlatformSupportTicketDetail = PlatformSupportTicket.extend({
  messages: z.array(SupportMessageItem),
}).meta({ id: 'PlatformSupportTicketDetail' });

const Message = z.string().trim().min(1).max(4000);
const TicketParams = z.object({ ticketId: Uuid });

export const SupportTicketBody = z.object({
  subject: z.string().trim().min(1).max(120),
  message: Message,
  urgency: z.enum(SUPPORT_URGENCIES).default('NORMAL'),
  page: z.string().trim().max(200).nullable().default(null),
});

// ── The hotel's side ────────────────────────────────────────────────────────────────────

const HOTEL = { tags: ['Support'], propertyScoped: true as const };
/** A group suspended for non-payment can still reach support (Philip, 2026-11-26). */
const EVEN_SUSPENDED = { allowWhenSuspended: true as const };

export const listSupportTickets = defineRoute({
  ...HOTEL,
  operationId: 'listSupportTickets',
  method: 'get',
  path: '/support/tickets',
  summary: 'The caller’s support conversations (the whole group’s with support.manage)',
  response: z.object({
    /** The group's named onboarding contact on the platform team. */
    contact: z.object({ name: z.string(), email: z.string().nullable() }).nullable(),
    /** Whether the caller sees every conversation of the group. */
    seesAll: z.boolean(),
    data: z.array(SupportTicketSummary),
  }),
});

export const createSupportTicket = defineRoute({
  ...HOTEL,
  ...EVEN_SUSPENDED,
  operationId: 'createSupportTicket',
  method: 'post',
  path: '/support/tickets',
  summary: 'Ask the support team for help',
  description:
    'Every platform admin is emailed; a front-desk blocker also goes by WhatsApp to the group’s onboarding contact (else every admin with a phone).',
  status: 201,
  body: SupportTicketBody,
  response: SupportTicketDetail,
});

export const getSupportTicket = defineRoute({
  ...HOTEL,
  operationId: 'getSupportTicket',
  method: 'get',
  path: '/support/tickets/{ticketId}',
  summary: 'A support conversation (marks the team’s answers as read)',
  params: TicketParams,
  response: SupportTicketDetail,
});

export const replySupportTicket = defineRoute({
  ...HOTEL,
  ...EVEN_SUSPENDED,
  operationId: 'replySupportTicket',
  method: 'post',
  path: '/support/tickets/{ticketId}/messages',
  summary: 'Add to a support conversation (reopens a resolved one)',
  params: TicketParams,
  body: z.object({ message: Message }),
  response: SupportTicketDetail,
});

export const resolveSupportTicket = defineRoute({
  ...HOTEL,
  ...EVEN_SUSPENDED,
  operationId: 'resolveSupportTicket',
  method: 'post',
  path: '/support/tickets/{ticketId}/resolve',
  summary: 'Mark a support conversation as resolved',
  params: TicketParams,
  response: SupportTicketDetail,
});

// ── The platform team's side (S31) ──────────────────────────────────────────────────────

const PLATFORM = { tags: ['Platform'], platform: true as const };

export const listPlatformSupportTickets = defineRoute({
  ...PLATFORM,
  operationId: 'listPlatformSupportTickets',
  method: 'get',
  path: '/platform/support/tickets',
  summary: 'The support queue: blockers first, then the longest waiting',
  query: z.object({
    /** ACTIVE: open and answered. */
    status: z.enum(['ACTIVE', ...SUPPORT_STATUSES]).default('ACTIVE'),
  }),
  response: z.object({ data: z.array(PlatformSupportTicket) }),
});

export const getPlatformSupportTicket = defineRoute({
  ...PLATFORM,
  operationId: 'getPlatformSupportTicket',
  method: 'get',
  path: '/platform/support/tickets/{ticketId}',
  summary: 'A support conversation (marks the hotel’s messages as read)',
  params: TicketParams,
  response: PlatformSupportTicketDetail,
});

export const replyPlatformSupportTicket = defineRoute({
  ...PLATFORM,
  operationId: 'replyPlatformSupportTicket',
  method: 'post',
  path: '/platform/support/tickets/{ticketId}/messages',
  summary: 'Answer a support conversation (the asker is emailed)',
  params: TicketParams,
  body: z.object({ message: Message }),
  response: PlatformSupportTicketDetail,
});

export const assignPlatformSupportTicket = defineRoute({
  ...PLATFORM,
  operationId: 'assignPlatformSupportTicket',
  method: 'post',
  path: '/platform/support/tickets/{ticketId}/assign',
  summary: 'Give a support conversation to a platform admin, or to nobody',
  params: TicketParams,
  body: z.object({ adminUserId: Uuid.nullable() }),
  response: PlatformSupportTicketDetail,
});

export const resolvePlatformSupportTicket = defineRoute({
  ...PLATFORM,
  operationId: 'resolvePlatformSupportTicket',
  method: 'post',
  path: '/platform/support/tickets/{ticketId}/resolve',
  summary: 'Mark a support conversation as resolved',
  params: TicketParams,
  response: PlatformSupportTicketDetail,
});

export const PlatformAdminItem = z
  .object({ id: Uuid, name: z.string(), email: z.string(), phone: z.string().nullable() })
  .meta({ id: 'PlatformAdmin' });

export const listPlatformAdmins = defineRoute({
  ...PLATFORM,
  operationId: 'listPlatformAdmins',
  method: 'get',
  path: '/platform/admins',
  summary: 'The platform team: who can be a contact or take a conversation',
  response: z.object({ data: z.array(PlatformAdminItem) }),
});

export const setOnboardingContact = defineRoute({
  ...PLATFORM,
  operationId: 'setOnboardingContact',
  method: 'put',
  path: '/platform/tenants/{organisationId}/onboarding-contact',
  summary: 'Name the platform admin who looks after a hotel group, or nobody',
  params: z.object({ organisationId: Uuid }),
  body: z.object({ adminUserId: Uuid.nullable() }),
  response: z.object({ contact: z.object({ id: Uuid, name: z.string() }).nullable() }),
});

export const SUPPORT_ROUTES = {
  listSupportTickets,
  createSupportTicket,
  getSupportTicket,
  replySupportTicket,
  resolveSupportTicket,
  listPlatformSupportTickets,
  getPlatformSupportTicket,
  replyPlatformSupportTicket,
  assignPlatformSupportTicket,
  resolvePlatformSupportTicket,
  listPlatformAdmins,
  setOnboardingContact,
} as const;
