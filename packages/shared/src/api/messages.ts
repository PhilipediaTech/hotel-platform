import { z } from 'zod';
import {
  DELIVERY_STATUSES,
  MESSAGE_CHANNELS,
  MESSAGE_LANGUAGE_CODES,
  MESSAGE_TEMPLATE_CODES,
  SENDING_CHANNELS,
} from '../messages.ts';
import { Phone } from './auth.ts';
import { defineRoute } from './contract.ts';
import { Instant, page, PageQuery, Uuid } from './primitives.ts';

// Messaging (tab 4 row "Messaging": GET/POST /message-templates; PRD M11-05; S29; T-024) and
// the WhatsApp webhook (tab 4 row "Webhooks"). Template edits need template.manage.

const Channel = z.enum(MESSAGE_CHANNELS);
const Language = z.enum(MESSAGE_LANGUAGE_CODES);
const Code = z.enum(MESSAGE_TEMPLATE_CODES);

export const MessageTemplateItem = z
  .object({
    code: Code,
    label: z.string(),
    audience: z.enum(['GUEST', 'STAFF']),
    channel: Channel,
    language: Language,
    subject: z.string().nullable(),
    body: z.string(),
    /** Email wording can be changed; WhatsApp wording is Meta-approved (the platform's). */
    editable: z.boolean(),
    /** The organisation changed this wording (false = the default). */
    customised: z.boolean(),
    /** The WhatsApp template's name and Meta category. */
    providerTemplateName: z.string().nullable(),
    category: z.enum(['AUTHENTICATION', 'UTILITY', 'MARKETING']).nullable(),
    variables: z.array(z.object({ name: z.string(), label: z.string(), example: z.string() })),
  })
  .meta({ id: 'MessageTemplate' });

export const listMessageTemplates = defineRoute({
  operationId: 'listMessageTemplates',
  method: 'get',
  path: '/message-templates',
  summary: 'Message templates: each code, channel and language with its wording',
  description:
    'Every template in English, plus each other language the organisation has written. ' +
    'Defaults come from the platform; `customised` marks the organisation’s own wording.',
  tags: ['Messaging'],
  propertyScoped: true,
  permission: 'template.manage',
  response: z.object({
    languages: z.array(z.object({ code: Language, label: z.string() })),
    templates: z.array(MessageTemplateItem),
  }),
});

const Subject = z.string().trim().min(1).max(200);
const Body = z.string().trim().min(1).max(4000);

export const SaveMessageTemplateBody = z.object({
  code: Code,
  channel: Channel,
  language: Language,
  subject: Subject.nullable().default(null),
  body: Body,
});

export const saveMessageTemplate = defineRoute({
  operationId: 'saveMessageTemplate',
  method: 'post',
  path: '/message-templates',
  summary: 'Save the organisation’s wording of a template in one language (M11-05)',
  description:
    'Email only in V1: WhatsApp wording must be approved by Meta, so it stays the ' +
    'platform’s. The text may use only the template’s variables; emails need a subject.',
  tags: ['Messaging'],
  propertyScoped: true,
  permission: 'template.manage',
  body: SaveMessageTemplateBody,
  response: MessageTemplateItem,
});

export const resetMessageTemplate = defineRoute({
  operationId: 'resetMessageTemplate',
  method: 'delete',
  path: '/message-templates/{code}/{channel}/{language}',
  summary: 'Go back to the default wording',
  tags: ['Messaging'],
  propertyScoped: true,
  permission: 'template.manage',
  params: z.object({ code: Code, channel: Channel, language: Language }),
  status: 204,
  response: z.void(),
});

export const SendTestMessageBody = z
  .object({
    code: Code,
    channel: z.enum(SENDING_CHANNELS),
    language: Language.default('en'),
    /** A phone in international format (WhatsApp) or an email address. */
    to: z.string().trim().min(3).max(254),
  })
  .superRefine((b, ctx) => {
    const ok =
      b.channel === 'WHATSAPP' ? Phone.safeParse(b.to).success : z.email().safeParse(b.to).success;
    if (!ok) {
      ctx.addIssue({
        code: 'custom',
        path: ['to'],
        message:
          b.channel === 'WHATSAPP'
            ? 'Use international format, e.g. +2348012345678'
            : 'Enter an email address',
      });
    }
  });

export const sendTestMessage = defineRoute({
  operationId: 'sendTestMessage',
  method: 'post',
  path: '/message-templates/test',
  summary: 'Send a template with its sample values, to check it arrives',
  description:
    'Added beyond tab 4 for S29. Queued like any message; the worker sends it. ' +
    'At most 20 test messages per property per hour.',
  tags: ['Messaging'],
  propertyScoped: true,
  permission: 'template.manage',
  idempotent: true,
  status: 201,
  body: SendTestMessageBody,
  response: z.object({ deliveryId: Uuid, status: z.enum(DELIVERY_STATUSES) }),
  errors: ['RATE_LIMITED'],
});

export const MessageDeliveryItem = z
  .object({
    id: Uuid,
    channel: Channel,
    templateCode: z.string(),
    recipient: z.string(),
    status: z.enum(DELIVERY_STATUSES),
    attempts: z.number().int(),
    lastError: z.string().nullable(),
    test: z.boolean(),
    createdAt: Instant,
    sentAt: Instant.nullable(),
  })
  .meta({ id: 'MessageDelivery' });

export const listMessageDeliveries = defineRoute({
  operationId: 'listMessageDeliveries',
  method: 'get',
  path: '/message-deliveries',
  summary: 'Messages this property sent, newest first',
  description: 'Added beyond tab 4 for S29. One-time codes are never stored or shown.',
  tags: ['Messaging'],
  propertyScoped: true,
  permission: 'template.manage',
  query: PageQuery,
  response: page(MessageDeliveryItem),
});

const Provider = z.object({ provider: z.string().regex(/^[a-z]+$/) });

export const whatsappWebhookVerify = defineRoute({
  operationId: 'whatsappWebhookVerify',
  method: 'get',
  path: '/webhooks/whatsapp/{provider}',
  summary: 'WhatsApp webhook check (Meta)',
  description:
    'Meta calls this when the webhook is set up: with the configured verify token it answers ' +
    '`hub.challenge` as plain text, otherwise 403.',
  tags: ['Webhooks'],
  auth: 'none',
  params: Provider,
  query: z.object({
    'hub.mode': z.string().max(50).optional(),
    'hub.verify_token': z.string().max(200).optional(),
    'hub.challenge': z.string().max(200).optional(),
  }),
  produces: 'text/plain',
  response: z.string(),
});

export const whatsappWebhook = defineRoute({
  operationId: 'whatsappWebhook',
  method: 'post',
  path: '/webhooks/whatsapp/{provider}',
  summary: 'WhatsApp delivery statuses and incoming guest messages',
  description:
    'Signed by the provider (Meta: `x-hub-signature-256`, HMAC-SHA256 of the raw body with ' +
    'the app secret). A bad signature answers 401 and changes nothing. Statuses only move a ' +
    'message forward (sent → delivered → read); failed records the provider’s error. ' +
    'Incoming guest messages go to the two-way inbox (T-115).',
  tags: ['Webhooks'],
  auth: 'none',
  params: Provider,
  body: z.record(z.string(), z.unknown()),
  response: z.object({ received: z.literal(true) }),
});

export const MESSAGE_ROUTES = {
  listMessageTemplates,
  saveMessageTemplate,
  resetMessageTemplate,
  sendTestMessage,
  listMessageDeliveries,
  whatsappWebhookVerify,
  whatsappWebhook,
} as const;
