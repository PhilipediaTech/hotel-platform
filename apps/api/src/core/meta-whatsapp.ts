import { exampleVars, numberedBody, placeholdersOf, type MessageTemplateDef } from '@hotel/shared';
import {
  MessageSendError,
  parseMetaInbound,
  parseMetaStatuses,
  signatureMatches,
  type MessageProvider,
  type WhatsAppTemplateMessage,
} from './messaging.ts';

// Meta's WhatsApp Cloud API (ADR-016; Philip's choice, 2026-11-06): templates are sent
// from the platform's number with the WhatsApp Business account's system-user token.
// https://developers.facebook.com/docs/whatsapp/cloud-api

export interface MetaWhatsAppOptions {
  token: string;
  phoneNumberId: string;
  /** Needed only to submit and list templates. */
  businessAccountId?: string | null;
  /** Signs webhooks; without it every webhook is refused. */
  appSecret?: string | null;
  /** What Meta must send when it checks the webhook; without it the check is refused. */
  verifyToken?: string | null;
  /** Graph API version, e.g. v23.0. */
  graphVersion: string;
  fetch?: typeof fetch;
  /** Milliseconds before a request is abandoned (default 10 s). */
  timeoutMs?: number;
}

/** Meta error codes that are about rate or a passing fault: worth trying again. */
const TRANSIENT_CODES = new Set([1, 2, 4, 80007, 130429, 131000, 131016, 131056]);

interface GraphError {
  error?: { message?: string; code?: number; error_subcode?: number };
}

async function graphError(res: Response): Promise<MessageSendError> {
  let body: GraphError = {};
  try {
    body = (await res.json()) as GraphError;
  } catch {
    // Not JSON: the status is all we have.
  }
  const code = body.error?.code;
  const message = `Meta ${res.status}${code === undefined ? '' : ` (${code})`}: ${
    body.error?.message ?? res.statusText
  }`.slice(0, 500);
  const transient =
    res.status >= 500 || res.status === 429 || (code !== undefined && TRANSIENT_CODES.has(code));
  return new MessageSendError(message, !transient);
}

/** Meta wants the number without the plus. */
const digits = (phone: string) => phone.replace(/^\+/, '');

export function templateComponents(message: WhatsAppTemplateMessage): unknown[] {
  const text = (value: string) => ({ type: 'text', text: value });
  const body = { type: 'body', parameters: message.params.map(text) };
  if (message.category !== 'AUTHENTICATION') return message.params.length ? [body] : [];
  // A copy-code template repeats the code in its button (Meta's authentication templates).
  const code = message.params[0] ?? '';
  return [body, { type: 'button', sub_type: 'url', index: '0', parameters: [text(code)] }];
}

export function createMetaWhatsAppProvider(options: MetaWhatsAppOptions): MessageProvider {
  const doFetch = options.fetch ?? fetch;
  const base = `https://graph.facebook.com/${options.graphVersion}`;
  return {
    name: 'META',
    async sendTemplate(message) {
      let res: Response;
      try {
        res = await doFetch(`${base}/${options.phoneNumberId}/messages`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${options.token}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            messaging_product: 'whatsapp',
            recipient_type: 'individual',
            to: digits(message.to),
            type: 'template',
            template: {
              name: message.templateName,
              language: { code: message.language },
              components: templateComponents(message),
            },
          }),
          signal: AbortSignal.timeout(options.timeoutMs ?? 10_000),
        });
      } catch (err) {
        // Network failure or timeout: Meta may or may not have it; try again.
        throw new MessageSendError(`Meta unreachable: ${(err as Error).name}`, false);
      }
      if (!res.ok) throw await graphError(res);
      const body = (await res.json()) as { messages?: { id?: string }[] };
      const id = body.messages?.[0]?.id;
      if (!id) throw new MessageSendError('Meta answered without a message id', false);
      return { providerRef: id };
    },
    verifySignature(raw, headers) {
      return options.appSecret
        ? signatureMatches(options.appSecret, raw, headers['x-hub-signature-256'])
        : false;
    },
    verifyChallenge(query) {
      return options.verifyToken &&
        query['hub.mode'] === 'subscribe' &&
        query['hub.verify_token'] === options.verifyToken
        ? (query['hub.challenge'] ?? null)
        : null;
    },
    parseStatuses: parseMetaStatuses,
    parseInbound: parseMetaInbound,
    async sendText(message) {
      let res: Response;
      try {
        res = await doFetch(`${base}/${options.phoneNumberId}/messages`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${options.token}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            messaging_product: 'whatsapp',
            recipient_type: 'individual',
            to: digits(message.to),
            type: 'text',
            text: { body: message.body },
          }),
          signal: AbortSignal.timeout(options.timeoutMs ?? 10_000),
        });
      } catch (err) {
        throw new MessageSendError(`Meta unreachable: ${(err as Error).name}`, false);
      }
      if (!res.ok) throw await graphError(res);
      const body = (await res.json()) as { messages?: { id?: string }[] };
      const id = body.messages?.[0]?.id;
      if (!id) throw new MessageSendError('Meta answered without a message id', false);
      return { providerRef: id };
    },
  };
}

/** The template as Meta's "create message template" call wants it. */
export function templateSubmission(def: MessageTemplateDef, language = 'en'): unknown {
  const wa = def.whatsapp;
  if (!wa) throw new Error(`${def.code} has no WhatsApp template`);
  if (wa.category === 'AUTHENTICATION') {
    return {
      name: wa.name,
      language,
      category: 'AUTHENTICATION',
      components: [
        { type: 'BODY', add_security_recommendation: true },
        { type: 'BUTTONS', buttons: [{ type: 'OTP', otp_type: 'COPY_CODE', text: 'Copy code' }] },
      ],
    };
  }
  const examples = exampleVars(def);
  return {
    name: wa.name,
    language,
    category: wa.category,
    components: [
      {
        type: 'BODY',
        text: numberedBody(wa.body),
        example: { body_text: [placeholdersOf(wa.body).map((n) => examples[n] ?? n)] },
      },
    ],
  };
}

export interface MetaTemplateStatus {
  name: string;
  language: string;
  status: string;
  category: string;
}

/** Template management (the `whatsapp:templates` command): list and submit. */
export function createMetaTemplateAdmin(options: MetaWhatsAppOptions) {
  const doFetch = options.fetch ?? fetch;
  const base = `https://graph.facebook.com/${options.graphVersion}`;
  const account = options.businessAccountId;
  if (!account) throw new Error('WHATSAPP_BUSINESS_ACCOUNT_ID is needed to manage templates');
  const headers = {
    Authorization: `Bearer ${options.token}`,
    'Content-Type': 'application/json',
  };
  return {
    async list(): Promise<MetaTemplateStatus[]> {
      const res = await doFetch(
        `${base}/${account}/message_templates?fields=name,language,status,category&limit=200`,
        { headers, signal: AbortSignal.timeout(options.timeoutMs ?? 10_000) },
      );
      if (!res.ok) throw await graphError(res);
      const body = (await res.json()) as { data?: MetaTemplateStatus[] };
      return body.data ?? [];
    },
    async submit(def: MessageTemplateDef): Promise<{ status: string }> {
      const res = await doFetch(`${base}/${account}/message_templates`, {
        method: 'POST',
        headers,
        body: JSON.stringify(templateSubmission(def)),
        signal: AbortSignal.timeout(options.timeoutMs ?? 10_000),
      });
      if (!res.ok) throw await graphError(res);
      const body = (await res.json()) as { status?: string };
      return { status: body.status ?? 'PENDING' };
    },
  };
}
