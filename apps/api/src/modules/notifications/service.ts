import type { IncomingHttpHeaders } from 'node:http';
import {
  DEFAULT_MESSAGE_LANGUAGE,
  exampleVars,
  MESSAGE_LANGUAGES,
  MESSAGE_TEMPLATES,
  messageTemplateDef,
  unknownPlaceholders,
  type DeliveryStatus,
  type MessageChannel,
  type MessageDeliveryItem,
  type MessageLanguage,
  type MessageTemplateDef,
  type MessageTemplateItem,
  type SaveMessageTemplateBody,
  type SendTestMessageBody,
} from '@hotel/shared';
import type { z } from 'zod';
import { recordAudit } from '../../core/audit.ts';
import type { Clock } from '../../core/clock.ts';
import type { Db } from '../../core/db.ts';
import { AppError } from '../../core/errors.ts';
import type { MessageProvider } from '../../core/messaging.ts';
import type { TenantContext } from '../../core/tenancy.ts';
import type { TenantDb } from '../../core/tenant-db.ts';
import { applyStatuses, queueMessage } from './delivery.ts';
import { receiveInbound } from './inbox.ts';

// Message templates (PRD M11-05; tab 4 row "Messaging"; S29; T-024) and the WhatsApp
// webhook (tab 4 row "Webhooks").

export interface MessagingDeps {
  db: Db;
  tenantDb: TenantDb;
  clock: Clock;
  messages: MessageProvider;
}

type Item = z.infer<typeof MessageTemplateItem>;
type TemplateRow = Awaited<ReturnType<TenantDb['messageTemplate']['findMany']>>[number];

/** Test messages per property per hour (S29), so the screen cannot be used to spam. */
export const TEST_MESSAGES_PER_HOUR = 20;

const iso = (d: Date) => d.toISOString().replace(/\.\d{3}Z$/, 'Z');

function item(
  def: MessageTemplateDef,
  channel: 'EMAIL' | 'WHATSAPP',
  language: MessageLanguage,
  row: TemplateRow | undefined,
): Item {
  const base = {
    code: def.code,
    label: def.label,
    audience: def.audience,
    channel,
    language,
    variables: def.variables.map((x) => ({ ...x })),
  };
  if (channel === 'WHATSAPP') {
    const wa = def.whatsapp;
    if (!wa) throw new Error(`${def.code} has no WhatsApp template`);
    return {
      ...base,
      subject: null,
      body: wa.body,
      editable: false,
      customised: false,
      providerTemplateName: wa.name,
      category: wa.category,
    };
  }
  const email = def.email;
  if (!email) throw new Error(`${def.code} has no email template`);
  return {
    ...base,
    subject: row?.subject ?? email.subject,
    body: row?.body ?? email.body,
    editable: true,
    customised: row !== undefined,
    providerTemplateName: null,
    category: null,
  };
}

const isLanguage = (code: string): code is MessageLanguage =>
  MESSAGE_LANGUAGES.some((l) => l.code === code);

/** Every template: English always, other languages where the organisation wrote them. */
export async function listTemplates(deps: MessagingDeps, _tenant: TenantContext) {
  const rows = await deps.tenantDb.messageTemplate.findMany({ where: { channel: 'EMAIL' } });
  const templates: Item[] = [];
  for (const def of MESSAGE_TEMPLATES) {
    if (def.email) {
      const own = rows.filter((r) => r.code === def.code);
      const languages = new Set<MessageLanguage>([DEFAULT_MESSAGE_LANGUAGE]);
      for (const r of own) if (isLanguage(r.language)) languages.add(r.language);
      for (const l of MESSAGE_LANGUAGES) {
        if (languages.has(l.code)) {
          templates.push(
            item(
              def,
              'EMAIL',
              l.code,
              own.find((r) => r.language === l.code),
            ),
          );
        }
      }
    }
    if (def.whatsapp) templates.push(item(def, 'WHATSAPP', DEFAULT_MESSAGE_LANGUAGE, undefined));
  }
  return { languages: MESSAGE_LANGUAGES.map((l) => ({ ...l })), templates };
}

function knownDef(code: string): MessageTemplateDef {
  const def = messageTemplateDef(code);
  if (!def) throw new AppError('NOT_FOUND', 'No such message template');
  return def;
}

function checkEditable(def: MessageTemplateDef, channel: MessageChannel): void {
  if (channel === 'WHATSAPP') {
    throw new AppError(
      'VALIDATION_ERROR',
      'WhatsApp wording is approved by Meta, so it can’t be changed here',
      { field: 'channel' },
    );
  }
  if (channel === 'SMS') {
    throw new AppError('VALIDATION_ERROR', 'There is no SMS provider yet', { field: 'channel' });
  }
  if (!def.email) {
    throw new AppError('VALIDATION_ERROR', `${def.label} is not sent by email`, {
      field: 'channel',
    });
  }
}

export async function saveTemplate(
  deps: MessagingDeps,
  tenant: TenantContext,
  body: z.infer<typeof SaveMessageTemplateBody>,
): Promise<Item> {
  const def = knownDef(body.code);
  checkEditable(def, body.channel);
  if (!body.subject) {
    throw new AppError('VALIDATION_ERROR', 'An email needs a subject', { field: 'subject' });
  }
  const unknown = [
    ...new Set([...unknownPlaceholders(def, body.subject), ...unknownPlaceholders(def, body.body)]),
  ];
  if (unknown.length) {
    throw new AppError(
      'VALIDATION_ERROR',
      `Not a variable of this template: ${unknown.map((n) => `{{${n}}}`).join(', ')}`,
      { field: 'body', unknown },
    );
  }
  const subject = body.subject;
  return deps.tenantDb.$transaction(async (tx) => {
    const where = { code: def.code, channel: 'EMAIL', language: body.language };
    const before = await tx.messageTemplate.findFirst({ where });
    const row = before
      ? await tx.messageTemplate.update({
          where: { id: before.id },
          data: { subject, body: body.body },
        })
      : await tx.messageTemplate.create({
          data: {
            organisationId: tenant.organisationId,
            ...where,
            subject,
            body: body.body,
          },
        });
    await recordAudit(tx, {
      action: 'message_template.saved',
      entityType: 'message_template',
      entityId: row.id,
      propertyId: null,
      before: before ? { subject: before.subject, body: before.body } : null,
      after: {
        code: def.code,
        channel: 'EMAIL',
        language: body.language,
        subject,
        body: body.body,
      },
    });
    return item(def, 'EMAIL', body.language, row);
  });
}

export async function resetTemplate(
  deps: MessagingDeps,
  _tenant: TenantContext,
  params: { code: string; channel: MessageChannel; language: MessageLanguage },
): Promise<void> {
  const def = knownDef(params.code);
  checkEditable(def, params.channel);
  await deps.tenantDb.$transaction(async (tx) => {
    const row = await tx.messageTemplate.findFirst({
      where: { code: def.code, channel: 'EMAIL', language: params.language },
    });
    if (!row) return;
    await tx.messageTemplate.delete({ where: { id: row.id } });
    await recordAudit(tx, {
      action: 'message_template.reset',
      entityType: 'message_template',
      entityId: row.id,
      propertyId: null,
      before: { subject: row.subject, body: row.body },
      after: { code: def.code, channel: 'EMAIL', language: params.language },
    });
  });
}

export async function sendTest(
  deps: MessagingDeps,
  tenant: TenantContext,
  body: z.infer<typeof SendTestMessageBody>,
): Promise<{ deliveryId: string; status: DeliveryStatus }> {
  const def = knownDef(body.code);
  const wa = def.whatsapp;
  if (body.channel === 'WHATSAPP' ? !wa : !def.email) {
    throw new AppError('VALIDATION_ERROR', `${def.label} is not sent by this channel`, {
      field: 'channel',
    });
  }
  if (body.channel === 'WHATSAPP' && wa?.category === 'AUTHENTICATION') {
    throw new AppError(
      'VALIDATION_ERROR',
      'Approval codes are sent only with a real approval request',
      { field: 'code' },
    );
  }
  const since = new Date(deps.clock().getTime() - 60 * 60 * 1000);
  const recent = await deps.tenantDb.notificationDelivery.count({
    where: { createdAt: { gte: since }, payload: { path: ['test'], equals: true } },
  });
  if (recent >= TEST_MESSAGES_PER_HOUR) {
    throw new AppError('RATE_LIMITED', 'Too many test messages this hour: try again later');
  }
  const vars = { ...exampleVars(def) };
  const deliveryId = await deps.tenantDb.$transaction(async (tx) => {
    const id = await queueMessage(tx, {
      organisationId: tenant.organisationId,
      propertyId: tenant.propertyId,
      channel: body.channel,
      templateCode: def.code,
      recipient: body.to,
      vars,
      language: body.language,
      test: true,
    });
    await recordAudit(tx, {
      action: 'message.test_sent',
      entityType: 'notification_delivery',
      entityId: id,
      after: { code: def.code, channel: body.channel, language: body.language, to: body.to },
    });
    return id;
  });
  return { deliveryId, status: 'QUEUED' };
}

const encodeCursor = (offset: number) => Buffer.from(String(offset)).toString('base64url');
function decodeCursor(cursor: string | undefined): number {
  if (!cursor) return 0;
  const n = Number(Buffer.from(cursor, 'base64url').toString());
  return Number.isInteger(n) && n >= 0 ? n : 0;
}

export async function listDeliveries(
  deps: MessagingDeps,
  _tenant: TenantContext,
  query: { limit: number; cursor?: string | undefined },
): Promise<{ data: z.infer<typeof MessageDeliveryItem>[]; nextCursor: string | null }> {
  const offset = decodeCursor(query.cursor);
  const rows = await deps.tenantDb.notificationDelivery.findMany({
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    skip: offset,
    take: query.limit + 1,
  });
  const more = rows.length > query.limit;
  return {
    data: rows.slice(0, query.limit).map((d) => ({
      id: d.id,
      channel: d.channel as MessageChannel,
      templateCode: d.templateCode,
      recipient: d.recipient,
      status: d.status as DeliveryStatus,
      attempts: d.attempts,
      lastError: d.lastError,
      test: (d.payload as { test?: unknown } | null)?.test === true,
      createdAt: iso(d.createdAt),
      sentAt: d.sentAt ? iso(d.sentAt) : null,
    })),
    nextCursor: more ? encodeCursor(offset + query.limit) : null,
  };
}

/** The configured provider's name in webhook paths (`meta`, or `fake` locally). */
function checkProvider(deps: MessagingDeps, provider: string): void {
  if (provider !== deps.messages.name.toLowerCase()) {
    throw new AppError('NOT_FOUND', 'No such WhatsApp provider');
  }
}

export function verifyWebhook(
  deps: MessagingDeps,
  provider: string,
  query: Record<string, string | undefined>,
): string {
  checkProvider(deps, provider);
  const challenge = deps.messages.verifyChallenge(query);
  if (challenge === null) throw new AppError('FORBIDDEN', 'The verify token does not match');
  return challenge;
}

export async function receiveWebhook(
  deps: MessagingDeps,
  provider: string,
  raw: Buffer | undefined,
  headers: IncomingHttpHeaders,
  body: unknown,
): Promise<{ received: true }> {
  checkProvider(deps, provider);
  if (!raw || !deps.messages.verifySignature(raw, headers)) {
    throw new AppError('UNAUTHENTICATED', 'The webhook signature does not match');
  }
  await applyStatuses(deps.db, deps.messages.parseStatuses(body));
  await receiveInbound(deps, deps.messages.parseInbound(body));
  return { received: true };
}
