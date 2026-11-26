import { createHmac } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import { BlockList, isIP } from 'node:net';
import type { Config } from './config.ts';

// Outgoing webhooks (T-166): one signed POST to a hotel's endpoint. The fetch sender refuses
// private and local addresses in production (an endpoint must not reach our own network) and
// follows no redirects; the fake records what was sent, for tests and local development.

export interface WebhookRequest {
  url: string;
  body: string;
  headers: Record<string, string>;
}

export interface WebhookResponse {
  status: number;
}

export interface WebhookSender {
  readonly name: 'FETCH' | 'FAKE';
  /** Answers the status; throws WebhookUnreachableError when nothing came back. */
  send(request: WebhookRequest): Promise<WebhookResponse>;
}

/** Nothing came back: refused, timed out, a blocked address. Safe to show `message`. */
export class WebhookUnreachableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WebhookUnreachableError';
  }
}

export const WEBHOOK_TIMEOUT_MS = 10_000;

/** `X-Webhook-Signature`: HMAC-SHA256 with the endpoint's secret of `<timestamp>.<body>`. */
export function webhookSignature(secret: string, timestamp: string, body: string): string {
  return `v1=${createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex')}`;
}

const PRIVATE = new BlockList();
for (const [net, bits] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['224.0.0.0', 3],
] as const) {
  PRIVATE.addSubnet(net, bits, 'ipv4');
}
for (const [net, bits] of [
  ['::', 127],
  ['fc00::', 7],
  ['fe80::', 10],
  ['ff00::', 8],
] as const) {
  PRIVATE.addSubnet(net, bits, 'ipv6');
}

/** An address of our own or a private network (IPv4-mapped IPv6 included). */
export function isPrivateAddress(address: string): boolean {
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address)?.[1];
  if (mapped) return PRIVATE.check(mapped, 'ipv4');
  const family = isIP(address);
  if (family === 4) return PRIVATE.check(address, 'ipv4');
  if (family === 6) return PRIVATE.check(address, 'ipv6');
  return false;
}

/**
 * Why a URL can't be an endpoint, or null. Production: https only, no user name or password,
 * no local or private host. Elsewhere http and local hosts are allowed (a test receiver).
 */
export function webhookUrlProblem(url: string, production: boolean): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return 'Enter a full URL, like https://example.com/hooks';
  }
  if (parsed.username || parsed.password) return 'Leave the user name and password out of the URL';
  if (!production) return ['https:', 'http:'].includes(parsed.protocol) ? null : 'Use https';
  if (parsed.protocol !== 'https:') return 'Use an https URL';
  const host = parsed.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.internal')) {
    return 'Use a public address, not a local one';
  }
  if (isPrivateAddress(host)) return 'Use a public address, not a private one';
  return null;
}

/** POSTs with fetch: no redirects, a time limit, and (production) public addresses only. */
export function createFetchWebhookSender(options: { blockPrivate: boolean }): WebhookSender {
  return {
    name: 'FETCH',
    async send({ url, body, headers }) {
      if (options.blockPrivate) {
        const host = new URL(url).hostname.replace(/^\[|\]$/g, '');
        let addresses: { address: string }[];
        try {
          addresses = isIP(host) ? [{ address: host }] : await lookup(host, { all: true });
        } catch {
          throw new WebhookUnreachableError('The host name could not be found');
        }
        if (addresses.length === 0 || addresses.some((a) => isPrivateAddress(a.address))) {
          throw new WebhookUnreachableError('The host is a private or local address');
        }
      }
      try {
        const res = await fetch(url, {
          method: 'POST',
          body,
          headers,
          redirect: 'manual',
          signal: AbortSignal.timeout(WEBHOOK_TIMEOUT_MS),
        });
        // The body isn't needed; let the connection go.
        await res.body?.cancel().catch(() => undefined);
        return { status: res.status };
      } catch (err) {
        const timedOut = err instanceof Error && err.name === 'TimeoutError';
        throw new WebhookUnreachableError(
          timedOut ? `No answer within ${WEBHOOK_TIMEOUT_MS / 1000} seconds` : 'Could not connect',
        );
      }
    },
  };
}

export interface FakeWebhookSender extends WebhookSender {
  readonly name: 'FAKE';
  sent: WebhookRequest[];
  /** What the next sends answer (then 200): a status, or 'unreachable'. */
  answers: (number | 'unreachable')[];
}

export function createFakeWebhookSender(): FakeWebhookSender {
  const fake: FakeWebhookSender = {
    name: 'FAKE',
    sent: [],
    answers: [],
    send(request) {
      fake.sent.push(request);
      const answer = fake.answers.shift() ?? 200;
      if (answer === 'unreachable') {
        return Promise.reject(new WebhookUnreachableError('Could not connect'));
      }
      return Promise.resolve({ status: answer });
    },
  };
  return fake;
}

/** The sender for this configuration: real requests, private addresses refused in production. */
export function createWebhookSender(config: Pick<Config, 'nodeEnv'>): WebhookSender {
  return createFetchWebhookSender({ blockPrivate: config.nodeEnv === 'production' });
}
