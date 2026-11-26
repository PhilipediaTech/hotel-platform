import type {
  PlatformSupportTicket,
  PlatformSupportTicketDetail,
  SupportTicketDetail,
  SupportTicketSummary,
  SupportTicketBody,
} from '@hotel/shared';
import type { z } from 'zod';
import type { Prisma } from '../../generated/prisma/client.ts';
import { recordAudit } from '../../core/audit.ts';
import type { AuthContext } from '../../core/auth.ts';
import type { Clock } from '../../core/clock.ts';
import type { Config } from '../../core/config.ts';
import type { Db } from '../../core/db.ts';
import { AppError } from '../../core/errors.ts';
import { recordEvent, type EventHandler } from '../../core/outbox.ts';
import { isPlatformAdmin } from '../../core/platform-admin.ts';
import type { TenantContext } from '../../core/tenancy.ts';
import type { TenantDb } from '../../core/tenant-db.ts';
import { queueMessage } from '../notifications/delivery.ts';

// In-app support (Versions V2 "enhanced onboarding, support tooling"; T-170; Philip's choices
// 2026-11-26). A hotel's staff ask from Help; they see what they asked, and support.manage
// sees and answers the whole group's. The platform team answers from S31 across groups with
// the plain client, naming the organisation in every write. Alerts: every platform admin is
// emailed on each hotel message (support.message_posted, handled by the worker); a front-desk
// blocker also goes by WhatsApp to the group's onboarding contact, else every admin with a
// phone; the asker is emailed each answer.

export interface SupportDeps {
  db: Db;
  tenantDb: TenantDb;
  clock: Clock;
  config: Pick<Config, 'platformAdminEmails'>;
}

type Summary = z.input<typeof SupportTicketSummary>;
type Detail = z.input<typeof SupportTicketDetail>;
type PlatformItem = z.input<typeof PlatformSupportTicket>;
type PlatformDetail = z.input<typeof PlatformSupportTicketDetail>;
type CreateBody = z.output<typeof SupportTicketBody>;

const iso = (d: Date) => d.toISOString().replace(/\.\d{3}Z$/, 'Z');
const MANAGE = 'support.manage';
/** Longest message excerpt in an alert. */
const EXCERPT = 300;

const INCLUDE = {
  openedBy: { select: { id: true, name: true } },
  property: { select: { name: true } },
  assignedAdmin: { select: { id: true, name: true } },
  organisation: { select: { id: true, name: true } },
} as const;
const WITH_MESSAGES = {
  ...INCLUDE,
  messages: {
    orderBy: { createdAt: 'asc' },
    include: { author: { select: { id: true, name: true } } },
  },
} as const;

type Row = Prisma.SupportTicketGetPayload<{ include: typeof INCLUDE }>;
type FullRow = Prisma.SupportTicketGetPayload<{ include: typeof WITH_MESSAGES }>;

function summaryOf(t: Row, unread: boolean): Summary {
  return {
    id: t.id,
    subject: t.subject,
    urgency: t.urgency as Summary['urgency'],
    status: t.status as Summary['status'],
    page: t.page,
    propertyName: t.property?.name ?? null,
    openedBy: t.openedBy,
    createdAt: iso(t.createdAt),
    lastMessageAt: iso(t.lastMessageAt),
    firstResponseAt: t.firstResponseAt ? iso(t.firstResponseAt) : null,
    resolvedAt: t.resolvedAt ? iso(t.resolvedAt) : null,
    unread,
  };
}

const messagesOf = (t: FullRow) =>
  t.messages.map((m) => ({
    id: m.id,
    fromPlatform: m.fromPlatform,
    author: m.author,
    body: m.body,
    createdAt: iso(m.createdAt),
  }));

const hotelDetail = (t: FullRow): Detail => ({
  ...summaryOf(t, t.hotelUnread),
  messages: messagesOf(t),
});

const platformItem = (t: Row): PlatformItem => ({
  ...summaryOf(t, t.platformUnread),
  organisation: t.organisation,
  assignedAdmin: t.assignedAdmin,
});

const platformDetail = (t: FullRow): PlatformDetail => ({
  ...platformItem(t),
  messages: messagesOf(t),
});

// ── The hotel's side ────────────────────────────────────────────────────────────────────

/** A conversation the caller may see: their own, or any of the group's with support.manage. */
async function visibleTicket(deps: SupportDeps, tenant: TenantContext, ticketId: string) {
  const ticket = await deps.tenantDb.supportTicket.findUnique({ where: { id: ticketId } });
  if (!ticket || (ticket.openedById !== tenant.userId && !tenant.permissions.has(MANAGE))) {
    throw new AppError('NOT_FOUND', 'Support conversation not found');
  }
  return ticket;
}

async function loadHotel(deps: SupportDeps, ticketId: string) {
  return deps.tenantDb.supportTicket.findUniqueOrThrow({
    where: { id: ticketId },
    include: WITH_MESSAGES,
  });
}

export async function listTickets(deps: SupportDeps, tenant: TenantContext) {
  const seesAll = tenant.permissions.has(MANAGE);
  const rows = await deps.tenantDb.supportTicket.findMany({
    where: seesAll ? {} : { openedById: tenant.userId },
    include: INCLUDE,
    orderBy: { lastMessageAt: 'desc' },
    take: 200,
  });
  const org = await deps.tenantDb.organisation.findUniqueOrThrow({
    where: { id: tenant.organisationId },
    include: { onboardingContact: { select: { name: true, email: true } } },
  });
  return {
    contact: org.onboardingContact
      ? { name: org.onboardingContact.name, email: org.onboardingContact.email }
      : null,
    seesAll,
    data: rows.map((t) => summaryOf(t, t.hotelUnread)),
  };
}

export async function createTicket(
  deps: SupportDeps,
  tenant: TenantContext,
  body: CreateBody,
): Promise<Detail> {
  const now = deps.clock();
  const id = await deps.tenantDb.$transaction(async (tx) => {
    const ticket = await tx.supportTicket.create({
      data: {
        propertyId: tenant.propertyId,
        openedById: tenant.userId,
        subject: body.subject,
        urgency: body.urgency,
        page: body.page,
        createdAt: now,
        lastMessageAt: now,
      } as unknown as Prisma.SupportTicketUncheckedCreateInput, // organisation from the client
    });
    const message = await tx.supportMessage.create({
      data: {
        ticketId: ticket.id,
        authorId: tenant.userId,
        fromPlatform: false,
        body: body.message,
        createdAt: now,
      } as unknown as Prisma.SupportMessageUncheckedCreateInput,
    });
    await recordAudit(tx, {
      action: 'support.ticket_opened',
      entityType: 'support_ticket',
      entityId: ticket.id,
      after: { subject: ticket.subject, urgency: ticket.urgency, page: ticket.page },
    });
    await recordEvent(tx, {
      type: 'support.message_posted',
      payload: { ticketId: ticket.id, messageId: message.id, first: true },
    });
    return ticket.id;
  });
  return hotelDetail(await loadHotel(deps, id));
}

export async function getTicket(
  deps: SupportDeps,
  tenant: TenantContext,
  ticketId: string,
): Promise<Detail> {
  const ticket = await visibleTicket(deps, tenant, ticketId);
  // Reads only for a platform admin in a support session, or a suspended group.
  if (ticket.hotelUnread && !tenant.support && !tenant.suspended) {
    await deps.tenantDb.supportTicket.update({
      where: { id: ticket.id },
      data: { hotelUnread: false },
    });
  }
  return hotelDetail(await loadHotel(deps, ticket.id));
}

export async function replyTicket(
  deps: SupportDeps,
  tenant: TenantContext,
  ticketId: string,
  text: string,
): Promise<Detail> {
  const ticket = await visibleTicket(deps, tenant, ticketId);
  const now = deps.clock();
  await deps.tenantDb.$transaction(async (tx) => {
    const message = await tx.supportMessage.create({
      data: {
        ticketId: ticket.id,
        authorId: tenant.userId,
        fromPlatform: false,
        body: text,
        createdAt: now,
      } as unknown as Prisma.SupportMessageUncheckedCreateInput,
    });
    // Back to the support team's queue, even when it was resolved.
    await tx.supportTicket.update({
      where: { id: ticket.id },
      data: {
        status: 'OPEN',
        resolvedAt: null,
        lastMessageAt: now,
        platformUnread: true,
        hotelUnread: false,
      },
    });
    await recordEvent(tx, {
      type: 'support.message_posted',
      payload: { ticketId: ticket.id, messageId: message.id, first: false },
    });
  });
  return hotelDetail(await loadHotel(deps, ticket.id));
}

export async function resolveTicket(
  deps: SupportDeps,
  tenant: TenantContext,
  ticketId: string,
): Promise<Detail> {
  const ticket = await visibleTicket(deps, tenant, ticketId);
  if (ticket.status !== 'RESOLVED') {
    await deps.tenantDb.$transaction(async (tx) => {
      await tx.supportTicket.update({
        where: { id: ticket.id },
        data: { status: 'RESOLVED', resolvedAt: deps.clock(), hotelUnread: false },
      });
      await recordAudit(tx, {
        action: 'support.ticket_resolved',
        entityType: 'support_ticket',
        entityId: ticket.id,
        after: { by: 'HOTEL' },
      });
    });
  }
  return hotelDetail(await loadHotel(deps, ticket.id));
}

// ── The platform team's side ────────────────────────────────────────────────────────────

/** Platform staff: the configured emails whose MFA is on (core/platform-admin.ts). */
export async function platformAdmins(deps: Pick<SupportDeps, 'db' | 'config'>) {
  const emails = deps.config.platformAdminEmails;
  if (emails.length === 0) return [];
  const users = await deps.db.user.findMany({
    where: { email: { in: [...emails] }, status: 'ACTIVE' },
    orderBy: { name: 'asc' },
  });
  return users
    .filter((u) => isPlatformAdmin(deps.config, u))
    .map((u) => ({ id: u.id, name: u.name, email: u.email ?? '', phone: u.phone }));
}

async function admin(deps: SupportDeps, userId: string) {
  const found = (await platformAdmins(deps)).find((a) => a.id === userId);
  if (!found) {
    throw new AppError('VALIDATION_ERROR', 'Choose a member of the platform team', {
      issues: [{ path: 'body.adminUserId', code: 'custom', message: 'Not a platform admin' }],
    });
  }
  return found;
}

async function loadPlatform(db: Db | Prisma.TransactionClient, ticketId: string) {
  const ticket = await db.supportTicket.findUnique({
    where: { id: ticketId },
    include: WITH_MESSAGES,
  });
  if (!ticket) throw new AppError('NOT_FOUND', 'Support conversation not found');
  return ticket;
}

/** Audited in the hotel group's log, as the platform team's other changes are. */
function audit(
  tx: Prisma.TransactionClient,
  auth: AuthContext,
  ticket: { id: string; organisationId: string; propertyId: string | null },
  action: string,
  after: Record<string, unknown>,
) {
  return recordAudit(tx, {
    organisationId: ticket.organisationId,
    propertyId: ticket.propertyId,
    actorUserId: auth.user.id,
    actorType: 'SUPPORT',
    action,
    entityType: 'support_ticket',
    entityId: ticket.id,
    after,
  });
}

const RANK: Record<string, number> = { BLOCKER: 0, NORMAL: 1 };

export async function listQueue(deps: SupportDeps, status: string) {
  const rows = await deps.db.supportTicket.findMany({
    where: status === 'ACTIVE' ? { status: { in: ['OPEN', 'ANSWERED'] } } : { status },
    include: INCLUDE,
    orderBy: { lastMessageAt: status === 'RESOLVED' ? 'desc' : 'asc' },
    take: 200,
  });
  // Waiting on the team first, blockers before the rest, then the longest waiting.
  const waiting = (t: Row) => (t.status === 'OPEN' ? 0 : 1);
  const sorted =
    status === 'RESOLVED'
      ? rows
      : [...rows].sort(
          (a, b) =>
            waiting(a) - waiting(b) ||
            (RANK[a.urgency] ?? 1) - (RANK[b.urgency] ?? 1) ||
            a.lastMessageAt.getTime() - b.lastMessageAt.getTime(),
        );
  return { data: sorted.map(platformItem) };
}

export async function getQueueTicket(deps: SupportDeps, ticketId: string) {
  const ticket = await loadPlatform(deps.db, ticketId);
  if (ticket.platformUnread) {
    await deps.db.supportTicket.update({
      where: { id: ticket.id },
      data: { platformUnread: false },
    });
  }
  return platformDetail(await loadPlatform(deps.db, ticket.id));
}

export async function answerTicket(
  deps: SupportDeps,
  auth: AuthContext,
  ticketId: string,
  text: string,
): Promise<PlatformDetail> {
  const now = deps.clock();
  await deps.db.$transaction(async (tx) => {
    const ticket = await loadPlatform(tx, ticketId);
    await tx.supportMessage.create({
      data: {
        organisationId: ticket.organisationId,
        ticketId: ticket.id,
        authorId: auth.user.id,
        fromPlatform: true,
        body: text,
        createdAt: now,
      },
    });
    await tx.supportTicket.update({
      where: { id: ticket.id },
      data: {
        status: 'ANSWERED',
        resolvedAt: null,
        lastMessageAt: now,
        firstResponseAt: ticket.firstResponseAt ?? now,
        // Whoever answers first takes it, unless someone already has.
        assignedAdminId: ticket.assignedAdminId ?? auth.user.id,
        hotelUnread: true,
        platformUnread: false,
      },
    });
    await audit(tx, auth, ticket, 'support.ticket_answered', {
      firstResponse: ticket.firstResponseAt === null,
    });
    const asker = await tx.user.findUniqueOrThrow({ where: { id: ticket.openedById } });
    if (asker.email) {
      await queueMessage(tx, {
        organisationId: ticket.organisationId,
        propertyId: ticket.propertyId,
        channel: 'EMAIL',
        templateCode: 'SUPPORT_REPLY',
        recipient: asker.email,
        vars: {
          subject: ticket.subject,
          admin_name: auth.user.name,
          message: excerpt(text),
        },
      });
    }
  });
  return platformDetail(await loadPlatform(deps.db, ticketId));
}

export async function assignTicket(
  deps: SupportDeps,
  auth: AuthContext,
  ticketId: string,
  adminUserId: string | null,
): Promise<PlatformDetail> {
  if (adminUserId) await admin(deps, adminUserId);
  await deps.db.$transaction(async (tx) => {
    const ticket = await loadPlatform(tx, ticketId);
    await tx.supportTicket.update({
      where: { id: ticket.id },
      data: { assignedAdminId: adminUserId },
    });
    await audit(tx, auth, ticket, 'support.ticket_assigned', { adminUserId });
  });
  return platformDetail(await loadPlatform(deps.db, ticketId));
}

export async function closeTicket(
  deps: SupportDeps,
  auth: AuthContext,
  ticketId: string,
): Promise<PlatformDetail> {
  await deps.db.$transaction(async (tx) => {
    const ticket = await loadPlatform(tx, ticketId);
    if (ticket.status === 'RESOLVED') return;
    await tx.supportTicket.update({
      where: { id: ticket.id },
      data: { status: 'RESOLVED', resolvedAt: deps.clock(), platformUnread: false },
    });
    await audit(tx, auth, ticket, 'support.ticket_resolved', { by: 'PLATFORM' });
  });
  return platformDetail(await loadPlatform(deps.db, ticketId));
}

export async function setContact(
  deps: SupportDeps,
  auth: AuthContext,
  organisationId: string,
  adminUserId: string | null,
) {
  const contact = adminUserId ? await admin(deps, adminUserId) : null;
  return deps.db.$transaction(async (tx) => {
    const org = await tx.organisation.findUnique({ where: { id: organisationId } });
    if (!org) throw new AppError('NOT_FOUND', 'Hotel group not found');
    await tx.organisation.update({
      where: { id: org.id },
      data: { onboardingContactId: contact?.id ?? null },
    });
    await recordAudit(tx, {
      organisationId: org.id,
      propertyId: null,
      actorUserId: auth.user.id,
      actorType: 'SUPPORT',
      action: 'platform.onboarding_contact_set',
      entityType: 'organisation',
      entityId: org.id,
      before: { onboardingContactId: org.onboardingContactId },
      after: { onboardingContactId: contact?.id ?? null },
    });
    return { contact: contact ? { id: contact.id, name: contact.name } : null };
  });
}

// ── Alerts to the platform team (worker) ────────────────────────────────────────────────

function excerpt(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > EXCERPT ? `${flat.slice(0, EXCERPT - 1)}…` : flat;
}

/**
 * Each hotel message: an email to every platform admin; a conversation opened as a front-desk
 * blocker also by WhatsApp to the group's onboarding contact (else every admin with a phone).
 * Queued once per message and recipient, so a repeated event sends nothing more.
 */
export function supportAlertHandler(deps: Pick<SupportDeps, 'db' | 'config'>): EventHandler {
  return {
    name: 'support-alert',
    events: ['support.message_posted'],
    async handle(event) {
      const messageId = event.payload['messageId'];
      if (typeof messageId !== 'string') return;
      const message = await deps.db.supportMessage.findUnique({
        where: { id: messageId },
        include: {
          author: { select: { name: true } },
          ticket: { include: { organisation: true } },
        },
      });
      if (!message || message.fromPlatform) return;
      const { ticket } = message;
      const admins = await platformAdmins(deps);
      const vars = {
        hotel_name: ticket.organisation.name,
        urgency: ticket.urgency === 'BLOCKER' ? 'Front-desk blocker' : 'Normal',
        subject: ticket.subject,
        from_name: message.author.name,
        message: excerpt(message.body),
      };
      const common = {
        organisationId: ticket.organisationId,
        // Not the hotel's message: kept out of its delivery list (no property).
        propertyId: null,
        templateCode: 'SUPPORT_REQUEST',
        vars,
        ref: `support_message:${message.id}`,
      };
      const contact = admins.find((a) => a.id === ticket.organisation.onboardingContactId);
      const phones =
        contact?.phone !== undefined && contact.phone !== null
          ? [contact.phone]
          : admins.flatMap((a) => (a.phone ? [a.phone] : []));
      await deps.db.$transaction(async (tx) => {
        for (const a of admins) {
          await queueMessage(tx, { ...common, channel: 'EMAIL', recipient: a.email });
        }
        if (event.payload['first'] === true && ticket.urgency === 'BLOCKER') {
          for (const phone of phones) {
            await queueMessage(tx, { ...common, channel: 'WHATSAPP', recipient: phone });
          }
        }
      });
    },
  };
}
