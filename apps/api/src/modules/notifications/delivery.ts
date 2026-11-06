import {
  DEFAULT_MESSAGE_LANGUAGE,
  messageTemplateDef,
  renderMessage,
  whatsappParams,
  type DeliveryStatus,
  type MessageTemplateDef,
  type SendingChannel,
} from '@hotel/shared';
import type { Logger } from 'pino';
import type { Prisma } from '../../generated/prisma/client.ts';
import type { ApprovalOtpChannel } from '../../core/approvals.ts';
import type { Clock } from '../../core/clock.ts';
import type { Db } from '../../core/db.ts';
import type { EmailProvider } from '../../core/email.ts';
import { MessageSendError, type MessageProvider, type StatusUpdate } from '../../core/messaging.ts';
import { recordEvent, type EventHandler, type OutboxClient } from '../../core/outbox.ts';

// Sending (T-024; tab 2 "Integrations", tab 3 `notification_deliveries`). A module that
// wants a message sent queues it in the transaction of its change: a delivery row and the
// `notification.queued` event. The worker's `notification-send` handler renders and sends
// it, with pg-boss retries for passing faults; the provider's status callbacks then move it
// on (delivered, read). One-time codes are the exception: they are sent at once and never
// stored (see `whatsappOtpChannel`).

/** Sends per message, the first included (pg-boss retries a handler 5 times). */
export const MAX_SEND_ATTEMPTS = 6;

export interface SendDeps {
  db: Db;
  messages: MessageProvider;
  email: EmailProvider;
  clock: Clock;
  logger: Logger;
}

/** A transaction (or client) that can write deliveries and outbox events. */
export interface QueueClient extends OutboxClient {
  notificationDelivery: {
    create(args: {
      data: Prisma.NotificationDeliveryUncheckedCreateInput;
      select: { id: true };
    }): PromiseLike<{ id: string }>;
  };
}

export interface QueueInput {
  organisationId: string;
  propertyId: string | null;
  channel: SendingChannel;
  templateCode: string;
  /** Phone in international format (WhatsApp) or email address. */
  recipient: string;
  /** Every variable of the template. */
  vars: Record<string, string>;
  language?: string;
  /** A test message from S29. */
  test?: boolean;
}

function definition(code: string, channel: SendingChannel): MessageTemplateDef {
  const def = messageTemplateDef(code);
  if (!def) throw new Error(`Unknown message template ${code}`);
  if (channel === 'EMAIL' ? !def.email : !def.whatsapp) {
    throw new Error(`${code} has no ${channel} template`);
  }
  if (def.whatsapp?.category === 'AUTHENTICATION') {
    throw new Error(`${code} carries a one-time code: send it at once, never queue it`);
  }
  return def;
}

/** Queues one message; returns its delivery ID. Call inside the change's transaction. */
export async function queueMessage(client: QueueClient, input: QueueInput): Promise<string> {
  const def = definition(input.templateCode, input.channel);
  const missing = def.variables.filter((x) => input.vars[x.name] === undefined);
  if (missing.length) {
    throw new Error(`${def.code}: missing ${missing.map((x) => x.name).join(', ')}`);
  }
  const row = await client.notificationDelivery.create({
    data: {
      propertyId: input.propertyId,
      channel: input.channel,
      templateCode: def.code,
      recipient: input.recipient,
      payload: {
        vars: input.vars,
        language: input.language ?? DEFAULT_MESSAGE_LANGUAGE,
        ...(input.test ? { test: true } : {}),
      },
    },
    select: { id: true },
  });
  await recordEvent(client, {
    type: 'notification.queued',
    organisationId: input.organisationId,
    propertyId: input.propertyId,
    payload: { deliveryId: row.id },
  });
  return row.id;
}

/** The organisation's email wording in that language, else in English, else the default. */
export async function emailWording(
  db: Pick<Db, 'messageTemplate'>,
  organisationId: string,
  def: MessageTemplateDef,
  language: string,
): Promise<{ subject: string; body: string }> {
  const fallback = def.email;
  if (!fallback) throw new Error(`${def.code} has no email template`);
  const rows = await db.messageTemplate.findMany({
    where: {
      organisationId,
      code: def.code,
      channel: 'EMAIL',
      language: { in: [language, DEFAULT_MESSAGE_LANGUAGE] },
    },
  });
  const row =
    rows.find((r) => r.language === language) ??
    rows.find((r) => r.language === DEFAULT_MESSAGE_LANGUAGE);
  return row ? { subject: row.subject ?? fallback.subject, body: row.body } : fallback;
}

interface Payload {
  vars: Record<string, string>;
  language: string;
}

function payloadOf(json: Prisma.JsonValue): Payload {
  const p = (json ?? {}) as Partial<Payload>;
  return { vars: p.vars ?? {}, language: p.language ?? DEFAULT_MESSAGE_LANGUAGE };
}

/** Renders and hands one message to its provider; returns the provider's reference. */
async function deliver(
  deps: SendDeps,
  organisationId: string,
  d: { channel: string; templateCode: string; recipient: string; payload: Prisma.JsonValue },
): Promise<string | null> {
  const { vars, language } = payloadOf(d.payload);
  let def: MessageTemplateDef;
  try {
    def = definition(d.templateCode, d.channel as SendingChannel);
  } catch (err) {
    throw new MessageSendError((err as Error).message, true);
  }
  if (d.channel === 'EMAIL') {
    const wording = await emailWording(deps.db, organisationId, def, language);
    let subject: string;
    let text: string;
    try {
      subject = renderMessage(wording.subject, vars);
      text = renderMessage(wording.body, vars);
    } catch (err) {
      throw new MessageSendError((err as Error).message, true);
    }
    await deps.email.send({
      to: d.recipient,
      subject,
      text,
      tag: def.code.toLowerCase().replaceAll('_', '-'),
    });
    return null;
  }
  const wa = def.whatsapp;
  if (!wa) throw new MessageSendError(`${def.code} has no WhatsApp template`, true);
  let params: string[];
  try {
    params = whatsappParams(def, vars);
  } catch (err) {
    throw new MessageSendError((err as Error).message, true);
  }
  // WhatsApp templates exist in English only in V1 (the platform's wording).
  const sent = await deps.messages.sendTemplate({
    to: d.recipient,
    templateName: wa.name,
    language: DEFAULT_MESSAGE_LANGUAGE,
    category: wa.category,
    params,
  });
  return sent.providerRef;
}

/**
 * Sends a queued delivery. A repeat of the job, or a second run at the same time, sends
 * nothing more: each attempt is claimed with a guarded update. A passing fault throws (the
 * job runs again); a permanent one, or the last attempt, marks it FAILED.
 */
export async function sendDelivery(
  deps: SendDeps,
  deliveryId: string,
  organisationId: string,
): Promise<DeliveryStatus | null> {
  const db = deps.db;
  const d = await db.notificationDelivery.findUnique({ where: { id: deliveryId } });
  if (d?.status !== 'QUEUED') return d ? (d.status as DeliveryStatus) : null;
  if (d.attempts >= MAX_SEND_ATTEMPTS) {
    await db.notificationDelivery.updateMany({
      where: { id: d.id, status: 'QUEUED' },
      data: { status: 'FAILED' },
    });
    return 'FAILED';
  }
  const claimed = await db.notificationDelivery.updateMany({
    where: { id: d.id, status: 'QUEUED', attempts: d.attempts },
    data: { attempts: { increment: 1 } },
  });
  if (claimed.count === 0) return null;
  const attempt = d.attempts + 1;
  try {
    const providerRef = await deliver(deps, organisationId, d);
    await db.notificationDelivery.updateMany({
      where: { id: d.id, status: 'QUEUED' },
      data: { status: 'SENT', providerRef, sentAt: deps.clock(), lastError: null },
    });
    return 'SENT';
  } catch (err) {
    const known = err instanceof MessageSendError;
    const final = (known && err.permanent) || attempt >= MAX_SEND_ATTEMPTS;
    const lastError = known ? err.message : 'Unexpected error while sending';
    await db.notificationDelivery.updateMany({
      where: { id: d.id, status: 'QUEUED' },
      data: { lastError, ...(final ? { status: 'FAILED' } : {}) },
    });
    if (!final) throw err;
    deps.logger.warn(
      { deliveryId: d.id, templateCode: d.templateCode, lastError },
      'Message not sent',
    );
    return 'FAILED';
  }
}

/** The worker's sender: one queue, every queued message. */
export function notificationSendHandler(deps: SendDeps): EventHandler {
  return {
    name: 'notification-send',
    events: ['notification.queued'],
    async handle(event) {
      const id = event.payload['deliveryId'];
      if (typeof id === 'string') await sendDelivery(deps, id, event.organisationId);
    },
  };
}

const RANK: Record<string, number> = { QUEUED: 0, SENT: 1, DELIVERED: 2, READ: 3 };

/**
 * Applies provider statuses. A message only moves forward (sent → delivered → read), so a
 * late or repeated callback changes nothing; failed is recorded unless it was already
 * delivered or read. Returns how many deliveries changed.
 */
export async function applyStatuses(
  db: Pick<Db, 'notificationDelivery'>,
  updates: readonly StatusUpdate[],
): Promise<number> {
  let changed = 0;
  for (const u of updates) {
    if (u.status === 'FAILED') {
      const r = await db.notificationDelivery.updateMany({
        where: { providerRef: u.providerRef, status: { in: ['QUEUED', 'SENT'] } },
        data: { status: 'FAILED', lastError: u.error ?? 'Failed (no reason given)' },
      });
      changed += r.count;
      continue;
    }
    const rank = RANK[u.status] ?? 0;
    const earlier = Object.keys(RANK).filter((s) => (RANK[s] ?? 0) < rank);
    const r = await db.notificationDelivery.updateMany({
      where: { providerRef: u.providerRef, status: { in: earlier } },
      data: { status: u.status },
    });
    changed += r.count;
  }
  return changed;
}

/**
 * Who receives an approval request's code: active members holding one of the policy's
 * approver roles at the property (or organisation-wide), with a phone, not the requester.
 */
export async function approverPhones(
  db: Db,
  approvalRequestId: string,
): Promise<{ userId: string; phone: string }[]> {
  const request = await db.approvalRequest.findUnique({ where: { id: approvalRequestId } });
  if (!request) return [];
  const policy = await db.approvalPolicy.findFirst({
    where: { propertyId: request.propertyId, action: request.action },
  });
  if (!policy || policy.approverRoleIds.length === 0) return [];
  const members = await db.membership.findMany({
    where: {
      organisationId: request.organisationId,
      active: true,
      roleId: { in: policy.approverRoleIds },
      OR: [{ propertyId: request.propertyId }, { propertyId: null }],
      user: { status: 'ACTIVE', phone: { not: null }, id: { not: request.requestedById } },
    },
    select: { user: { select: { id: true, phone: true } } },
  });
  const seen = new Map<string, string>();
  for (const m of members) if (m.user.phone) seen.set(m.user.id, m.user.phone);
  return [...seen].map(([userId, phone]) => ({ userId, phone }));
}

/**
 * The approval code's WhatsApp channel (replaces T-022's logging stub). The code goes to
 * every approver at once, from the outbox handler: a delivery row is kept per approver, but
 * the code itself is never stored. If no send got through and the fault may pass, it
 * throws, the handler runs again and issues a fresh code.
 */
export function whatsappOtpChannel(deps: Omit<SendDeps, 'email'>): ApprovalOtpChannel {
  const def = messageTemplateDef('APPROVAL_OTP');
  const wa = def?.whatsapp;
  if (!wa) throw new Error('APPROVAL_OTP has no WhatsApp template');
  return {
    async send({ approvalRequestId, propertyId, code }) {
      const recipients = await approverPhones(deps.db, approvalRequestId);
      if (recipients.length === 0) {
        deps.logger.warn({ approvalRequestId }, 'No approver has a phone for the approval code');
        return;
      }
      let sent = 0;
      let retryable: Error | null = null;
      for (const r of recipients) {
        const row = await deps.db.notificationDelivery.create({
          data: {
            propertyId,
            channel: 'WHATSAPP',
            templateCode: 'APPROVAL_OTP',
            recipient: r.phone,
            payload: { approvalRequestId, userId: r.userId },
            attempts: 1,
          },
          select: { id: true },
        });
        try {
          const { providerRef } = await deps.messages.sendTemplate({
            to: r.phone,
            templateName: wa.name,
            language: DEFAULT_MESSAGE_LANGUAGE,
            category: wa.category,
            params: [code],
          });
          await deps.db.notificationDelivery.update({
            where: { id: row.id },
            data: { status: 'SENT', providerRef, sentAt: deps.clock() },
          });
          sent += 1;
        } catch (err) {
          const known = err instanceof MessageSendError;
          await deps.db.notificationDelivery.update({
            where: { id: row.id },
            data: {
              status: 'FAILED',
              lastError: known ? err.message : 'Unexpected error while sending',
            },
          });
          if (!known || !err.permanent)
            retryable = err instanceof Error ? err : new Error(String(err));
        }
      }
      if (sent === 0 && retryable) throw retryable;
    },
  };
}
