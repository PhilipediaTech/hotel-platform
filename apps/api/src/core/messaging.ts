import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import type { IncomingHttpHeaders } from 'node:http';
import type { Logger } from 'pino';
import type { WhatsAppCategory } from '@hotel/shared';

// MessageProvider interface (spec tab 2, "Integrations"; ADR-016: WhatsApp only through the
// official Business Platform). Meta's Cloud API in staging and production; the fake is used
// in tests and local development.

export interface WhatsAppTemplateMessage {
  /** International format, e.g. +2348012345678. */
  to: string;
  /** The approved template's name in the WhatsApp Business account. */
  templateName: string;
  language: string;
  category: WhatsAppCategory;
  /** Body parameters in {{1}}, {{2}} order (for AUTHENTICATION: the code). */
  params: readonly string[];
}

/** A delivery status reported by the provider. */
export interface StatusUpdate {
  providerRef: string;
  status: 'SENT' | 'DELIVERED' | 'READ' | 'FAILED';
  error: string | null;
}

/** A send that failed. `permanent`: retrying the same message cannot help. */
export class MessageSendError extends Error {
  readonly permanent: boolean;
  constructor(message: string, permanent: boolean) {
    super(message);
    this.name = 'MessageSendError';
    this.permanent = permanent;
  }
}

export interface MessageProvider {
  readonly name: 'FAKE' | 'META';
  sendTemplate(message: WhatsAppTemplateMessage): Promise<{ providerRef: string }>;
  /** Whether a webhook body really comes from the provider (signature over the raw bytes). */
  verifySignature(raw: Buffer, headers: IncomingHttpHeaders): boolean;
  /** The challenge to echo when the provider checks the webhook, or null (wrong token). */
  verifyChallenge(query: Record<string, string | undefined>): string | null;
  /** Delivery statuses in a verified webhook body; other content is ignored. */
  parseStatuses(body: unknown): StatusUpdate[];
}

/** HMAC-SHA256 of the raw body, as Meta sends it: `sha256=<hex>`. */
export function signBody(secret: string, raw: Buffer | string): string {
  return `sha256=${createHmac('sha256', secret).update(raw).digest('hex')}`;
}

export function signatureMatches(secret: string, raw: Buffer, header: unknown): boolean {
  if (typeof header !== 'string') return false;
  const expected = Buffer.from(signBody(secret, raw));
  const given = Buffer.from(header);
  return given.length === expected.length && timingSafeEqual(given, expected);
}

const STATUS: Record<string, StatusUpdate['status']> = {
  sent: 'SENT',
  delivered: 'DELIVERED',
  read: 'READ',
  failed: 'FAILED',
};

const isObject = (x: unknown): x is Record<string, unknown> =>
  typeof x === 'object' && x !== null && !Array.isArray(x);
const list = (x: unknown): unknown[] => (Array.isArray(x) ? x : []);

/**
 * Statuses in Meta's webhook shape: entry[].changes[].value.statuses[] with `id` (the
 * message id), `status` and, when failed, `errors[]`. The fake uses the same shape.
 */
export function parseMetaStatuses(body: unknown): StatusUpdate[] {
  if (!isObject(body)) return [];
  const out: StatusUpdate[] = [];
  for (const entry of list(body['entry'])) {
    if (!isObject(entry)) continue;
    for (const change of list(entry['changes'])) {
      if (!isObject(change) || !isObject(change['value'])) continue;
      for (const s of list(change['value']['statuses'])) {
        if (!isObject(s) || typeof s['id'] !== 'string' || typeof s['status'] !== 'string') {
          continue;
        }
        const status = STATUS[s['status']];
        if (!status) continue;
        const first = list(s['errors'])[0];
        const error = isObject(first)
          ? [first['code'], first['title'] ?? first['message']]
              .filter((p) => typeof p === 'string' || typeof p === 'number')
              .join(': ')
              .slice(0, 500)
          : null;
        out.push({ providerRef: s['id'], status, error: status === 'FAILED' ? error : null });
      }
    }
  }
  return out;
}

export interface FakeMessageProvider extends MessageProvider {
  readonly sent: (WhatsAppTemplateMessage & { providerRef: string })[];
  /** Makes the next sends fail (permanent or not), for tests. */
  failNext(count: number, permanent?: boolean): void;
}

/** Secret the fake's webhooks are signed with (local development and tests). */
export const FAKE_WHATSAPP_SECRET = 'fake-whatsapp-app-secret';
export const FAKE_WHATSAPP_VERIFY_TOKEN = 'fake-whatsapp-verify-token';

/**
 * Keeps messages in memory. With a logger (local development) it also logs each message,
 * so one-time codes can be read from the terminal; production refuses the fake.
 */
export function createFakeMessageProvider(logger?: Logger): FakeMessageProvider {
  const sent: FakeMessageProvider['sent'] = [];
  let failures: { count: number; permanent: boolean } = { count: 0, permanent: false };
  return {
    name: 'FAKE',
    sent,
    failNext(count, permanent = false) {
      failures = { count, permanent };
    },
    sendTemplate(message) {
      if (failures.count > 0) {
        failures.count -= 1;
        return Promise.reject(new MessageSendError('Fake send failure', failures.permanent));
      }
      const providerRef = `fake.${randomUUID()}`;
      sent.push({ ...message, providerRef });
      logger?.info(
        { whatsapp: { ...message, providerRef } },
        `WhatsApp (not sent, fake provider): ${message.templateName}`,
      );
      return Promise.resolve({ providerRef });
    },
    verifySignature(raw, headers) {
      return signatureMatches(FAKE_WHATSAPP_SECRET, raw, headers['x-hub-signature-256']);
    },
    verifyChallenge(query) {
      return query['hub.mode'] === 'subscribe' &&
        query['hub.verify_token'] === FAKE_WHATSAPP_VERIFY_TOKEN
        ? (query['hub.challenge'] ?? null)
        : null;
    },
    parseStatuses: parseMetaStatuses,
  };
}
