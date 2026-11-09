import type { ThreadItem, ThreadMessage } from '@hotel/shared';
import { renderMessage, messageTemplateDef } from '@hotel/shared';
import type { z } from 'zod';
import type { Prisma } from '../../generated/prisma/client.ts';
import { recordAudit } from '../../core/audit.ts';
import type { Clock } from '../../core/clock.ts';
import type { Db } from '../../core/db.ts';
import { AppError } from '../../core/errors.ts';
import {
  MessageSendError,
  type InboundMessage,
  type MessageProvider,
} from '../../core/messaging.ts';
import type { TenantContext } from '../../core/tenancy.ts';
import type { TenantDb } from '../../core/tenant-db.ts';
import { queueMessage } from './delivery.ts';

// The two-way WhatsApp inbox (PRD M11-04, M11 rules; T-115). All hotels share the platform's
// WhatsApp number (ADR-016), so a guest's message goes to the hotel that was last in touch
// with that phone, or failing that the one where the phone last booked. A number no hotel
// knows is logged and dropped: nothing in the app could show it to anyone.

export interface InboxDeps {
  db: Db;
  tenantDb: TenantDb;
  clock: Clock;
  messages: MessageProvider;
}

type Tx = Prisma.TransactionClient;
type Item = z.input<typeof ThreadItem>;
type Msg = z.input<typeof ThreadMessage>;

export const WINDOW_MS = 24 * 3_600_000;
const STOP_WORDS = new Set(['STOP', 'UNSUBSCRIBE']);
const PREVIEW = 120;

const iso = (d: Date) => d.toISOString().replace(/\.\d{3}Z$/, 'Z');
const preview = (text: string) => text.replace(/\s+/g, ' ').slice(0, PREVIEW);

const THREAD_INCLUDE = {
  guest: { select: { id: true, firstName: true, lastName: true } },
  reservation: { select: { id: true, confirmationNo: true, status: true } },
} satisfies Prisma.MessageThreadInclude;
type Thread = Prisma.MessageThreadGetPayload<{ include: typeof THREAD_INCLUDE }>;

const windowOpen = (t: { lastInboundAt: Date | null }, now: Date) =>
  t.lastInboundAt !== null && now.getTime() - t.lastInboundAt.getTime() < WINDOW_MS;

function threadOf(t: Thread, now: Date): Item {
  return {
    id: t.id,
    phone: t.phone,
    guest: t.guest ? { id: t.guest.id, name: `${t.guest.firstName} ${t.guest.lastName}` } : null,
    reservation: t.reservation,
    lastMessageAt: iso(t.lastMessageAt),
    lastPreview: t.lastPreview,
    unreadCount: t.unreadCount,
    windowOpen: windowOpen(t, now),
  };
}

function messageOf(m: Prisma.MessageGetPayload<{ include: { sentBy: true } }>): Msg {
  return {
    id: m.id,
    direction: m.direction as Msg['direction'],
    kind: m.kind as Msg['kind'],
    body: m.body,
    status: m.status as Msg['status'],
    sentBy: m.sentBy?.name ?? null,
    createdAt: iso(m.createdAt),
  };
}

// ── Incoming ────────────────────────────────────────────────────────────────────────────

/** The hotel this phone belongs with: whoever was in touch last, else where it last booked. */
async function propertyFor(db: Db, phone: string): Promise<string | null> {
  const [thread, delivery] = await Promise.all([
    db.messageThread.findFirst({ where: { phone }, orderBy: { lastMessageAt: 'desc' } }),
    db.notificationDelivery.findFirst({
      where: { recipient: phone, channel: 'WHATSAPP', propertyId: { not: null } },
      orderBy: { createdAt: 'desc' },
    }),
  ]);
  if (thread && delivery) {
    return thread.lastMessageAt >= delivery.createdAt ? thread.propertyId : delivery.propertyId;
  }
  if (thread) return thread.propertyId;
  if (delivery) return delivery.propertyId;
  const booking = await db.reservation.findFirst({
    where: { booker: { phone, mergedIntoId: null } },
    orderBy: { createdAt: 'desc' },
  });
  return booking?.propertyId ?? null;
}

/** The guest with this phone in the hotel's group, and their most relevant booking here. */
async function linkFor(db: Tx, organisationId: string, propertyId: string, phone: string) {
  const guest = await db.guest.findFirst({
    where: { organisationId, phone, mergedIntoId: null },
    orderBy: { updatedAt: 'desc' },
  });
  if (!guest) return { guestId: null, reservationId: null };
  const reservation =
    (await db.reservation.findFirst({
      where: { propertyId, bookerGuestId: guest.id, status: 'CHECKED_IN' },
      orderBy: { createdAt: 'desc' },
    })) ??
    (await db.reservation.findFirst({
      where: { propertyId, bookerGuestId: guest.id, status: { in: ['CONFIRMED', 'TENTATIVE'] } },
      orderBy: { createdAt: 'desc' },
    }));
  return { guestId: guest.id, reservationId: reservation?.id ?? null };
}

/** Records incoming messages. A repeat of one already held is ignored. Answers how many. */
export async function receiveInbound(
  deps: Pick<InboxDeps, 'db' | 'clock'>,
  inbound: readonly InboundMessage[],
): Promise<number> {
  let stored = 0;
  for (const m of inbound) {
    const propertyId = await propertyFor(deps.db, m.from);
    if (!propertyId) continue;
    const property = await deps.db.property.findUniqueOrThrow({ where: { id: propertyId } });
    const now = deps.clock();
    const added = await deps.db.$transaction(async (tx) => {
      const link = await linkFor(tx, property.organisationId, propertyId, m.from);
      const thread = await tx.messageThread.upsert({
        where: { propertyId_phone: { propertyId, phone: m.from } },
        create: {
          organisationId: property.organisationId,
          propertyId,
          phone: m.from,
          ...link,
          lastMessageAt: now,
          lastPreview: '',
        },
        // A booking made since the last message becomes the one this is about.
        update: link.guestId ? link : {},
      });
      const { count } = await tx.message.createMany({
        data: [
          {
            propertyId,
            threadId: thread.id,
            direction: 'IN',
            kind: m.kind,
            body: m.body,
            status: 'RECEIVED',
            providerRef: m.providerRef,
            createdAt: now,
          },
        ],
        skipDuplicates: true,
      });
      if (count === 0) return 0;
      await tx.messageThread.update({
        where: { id: thread.id },
        data: {
          lastInboundAt: now,
          lastMessageAt: now,
          lastPreview: preview(m.body),
          unreadCount: { increment: 1 },
        },
      });
      // M11 rule: guests can opt out of marketing messages.
      if (link.guestId && STOP_WORDS.has(m.body.trim().toUpperCase())) {
        await tx.guest.update({
          where: { id: link.guestId },
          data: { marketingConsent: false, consentAt: null },
        });
        await recordAudit(tx, {
          organisationId: property.organisationId,
          propertyId,
          actorType: 'SYSTEM',
          actorUserId: null,
          action: 'guest.marketing_opted_out',
          entityType: 'guest',
          entityId: link.guestId,
          after: { channel: 'WHATSAPP' },
        });
      }
      return 1;
    });
    stored += added;
  }
  return stored;
}

// ── The desk (M11-04) ───────────────────────────────────────────────────────────────────

export async function listThreads(deps: InboxDeps, query: { unread?: boolean | undefined }) {
  const now = deps.clock();
  const rows = await deps.tenantDb.messageThread.findMany({
    where: query.unread ? { unreadCount: { gt: 0 } } : {},
    include: THREAD_INCLUDE,
    orderBy: { lastMessageAt: 'desc' },
    take: 100,
  });
  return { data: rows.map((t) => threadOf(t, now)) };
}

async function loadThread(db: TenantDb, threadId: string): Promise<Thread> {
  const t = await db.messageThread.findFirst({
    where: { id: threadId },
    include: THREAD_INCLUDE,
  });
  if (!t) throw new AppError('NOT_FOUND', 'Conversation not found');
  return t;
}

export async function getThread(deps: InboxDeps, threadId: string) {
  const t = await loadThread(deps.tenantDb, threadId);
  const messages = await deps.tenantDb.message.findMany({
    where: { threadId },
    include: { sentBy: true },
    orderBy: { createdAt: 'desc' },
    take: 200,
  });
  return { ...threadOf(t, deps.clock()), messages: messages.reverse().map(messageOf) };
}

export async function markRead(deps: InboxDeps, threadId: string) {
  await loadThread(deps.tenantDb, threadId);
  await deps.tenantDb.messageThread.update({ where: { id: threadId }, data: { unreadCount: 0 } });
  return { unreadCount: 0 as const };
}

export async function sendText(
  deps: InboxDeps,
  tenant: TenantContext,
  threadId: string,
  body: string,
): Promise<Msg> {
  const thread = await loadThread(deps.tenantDb, threadId);
  const now = deps.clock();
  // M11 rule: only approved templates outside the 24-hour window.
  if (!windowOpen(thread, now)) {
    throw new AppError(
      'STATE_TRANSITION_INVALID',
      'The guest last wrote more than 24 hours ago. Send the follow-up message instead.',
      { reason: 'WINDOW_CLOSED' },
    );
  }
  let status: Msg['status'] = 'SENT';
  let providerRef: string | null = null;
  let error: string | null = null;
  try {
    ({ providerRef } = await deps.messages.sendText({ to: thread.phone, body }));
  } catch (err) {
    if (!(err instanceof MessageSendError)) throw err;
    status = 'FAILED';
    error = err.message.slice(0, 500);
  }
  return deps.tenantDb.$transaction(async (tx) => {
    const row = await tx.message.create({
      data: {
        threadId,
        direction: 'OUT',
        kind: 'TEXT',
        body,
        status,
        providerRef,
        error,
        sentById: tenant.userId,
        createdAt: now,
      } as Prisma.MessageUncheckedCreateInput,
      include: { sentBy: true },
    });
    await tx.messageThread.update({
      where: { id: threadId },
      data: { lastMessageAt: now, lastPreview: preview(body) },
    });
    await recordAudit(tx, {
      action: 'message.sent',
      entityType: 'message_thread',
      entityId: threadId,
      after: { messageId: row.id, status },
    });
    return messageOf(row);
  });
}

/** The approved template that invites a reply, for when the window has closed. */
export async function sendFollowUp(
  deps: InboxDeps,
  tenant: TenantContext,
  threadId: string,
): Promise<Msg> {
  const thread = await loadThread(deps.tenantDb, threadId);
  const property = await deps.tenantDb.property.findUniqueOrThrow({
    where: { id: tenant.propertyId },
  });
  const vars = {
    guest_name: thread.guest ? thread.guest.firstName : 'there',
    property_name: property.name,
  };
  const def = messageTemplateDef('GUEST_FOLLOW_UP');
  const body = renderMessage(def?.whatsapp?.body ?? '', vars);
  const now = deps.clock();
  return deps.tenantDb.$transaction(async (tx) => {
    await queueMessage(tx, {
      organisationId: tenant.organisationId,
      propertyId: tenant.propertyId,
      channel: 'WHATSAPP',
      templateCode: 'GUEST_FOLLOW_UP',
      recipient: thread.phone,
      vars,
    });
    const row = await tx.message.create({
      data: {
        threadId,
        direction: 'OUT',
        kind: 'TEMPLATE',
        body,
        status: 'QUEUED',
        sentById: tenant.userId,
        createdAt: now,
      } as Prisma.MessageUncheckedCreateInput,
      include: { sentBy: true },
    });
    await tx.messageThread.update({
      where: { id: threadId },
      data: { lastMessageAt: now, lastPreview: preview(body) },
    });
    return messageOf(row);
  });
}
