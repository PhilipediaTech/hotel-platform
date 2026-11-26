import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  createFetchWebhookSender,
  isPrivateAddress,
  WebhookUnreachableError,
  webhookSignature,
  webhookUrlProblem,
} from './webhook-sender.ts';

// Outgoing webhooks (T-166): what may be an endpoint, and the signature receivers check.

describe('webhook URLs', () => {
  it('knows private and local addresses', () => {
    for (const a of ['127.0.0.1', '10.1.2.3', '172.20.0.1', '192.168.1.1', '169.254.169.254']) {
      expect(isPrivateAddress(a), a).toBe(true);
    }
    for (const a of ['::1', 'fd00::1', 'fe80::1', '::ffff:10.0.0.1']) {
      expect(isPrivateAddress(a), a).toBe(true);
    }
    for (const a of ['8.8.8.8', '41.58.0.1', '2001:4860:4860::8888']) {
      expect(isPrivateAddress(a), a).toBe(false);
    }
  });

  it('allows only public https endpoints in production', () => {
    expect(webhookUrlProblem('https://hooks.example.com/x', true)).toBeNull();
    expect(webhookUrlProblem('http://hooks.example.com/x', true)).toMatch(/https/);
    expect(webhookUrlProblem('https://localhost:8080/x', true)).toMatch(/local/);
    expect(webhookUrlProblem('https://127.0.0.1/x', true)).toMatch(/private/);
    expect(webhookUrlProblem('https://[::1]/x', true)).toMatch(/private/);
    expect(webhookUrlProblem('https://10.0.0.5/x', true)).toMatch(/private/);
    expect(webhookUrlProblem('https://a:b@hooks.example.com/x', true)).toMatch(/password/);
    expect(webhookUrlProblem('not a url', true)).toMatch(/full URL/);
    // Development and tests may send to a local receiver.
    expect(webhookUrlProblem('http://localhost:4000/hooks', false)).toBeNull();
  });

  it('refuses at send time a host that resolves to a private address', async () => {
    const sender = createFetchWebhookSender({ blockPrivate: true });
    await expect(
      sender.send({ url: 'https://127.0.0.1/x', body: '{}', headers: {} }),
    ).rejects.toBeInstanceOf(WebhookUnreachableError);
  });
});

describe('webhook signature', () => {
  it('is the HMAC-SHA256 of "<timestamp>.<body>" with the secret, hex, v1=', () => {
    const expected = createHmac('sha256', 'whsec_x').update('1700000000.{"a":1}').digest('hex');
    expect(webhookSignature('whsec_x', '1700000000', '{"a":1}')).toBe(`v1=${expected}`);
  });
});
