import { messageTemplateDef } from '@hotel/shared';
import { describe, expect, it } from 'vitest';
import { MessageSendError, parseMetaStatuses, signBody } from './messaging.ts';
import { createMetaWhatsAppProvider, templateSubmission } from './meta-whatsapp.ts';

// Meta Cloud API adapter (T-024, ADR-016). No network: fetch is replaced.

type Call = { url: string; init: RequestInit };

function provider(answer: () => Response | Promise<Response>, extra = {}) {
  const calls: Call[] = [];
  const p = createMetaWhatsAppProvider({
    token: 'EAAtest-token-0123456789',
    phoneNumberId: '1234567890',
    appSecret: 'app-secret-0123456789',
    verifyToken: 'verify-token-0123456789',
    graphVersion: 'v23.0',
    fetch: ((url: string, init: RequestInit) => {
      calls.push({ url, init });
      return Promise.resolve(answer());
    }) as typeof fetch,
    ...extra,
  });
  return { p, calls };
}

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

describe('sending a template', () => {
  it('posts the template with its numbered parameters and returns Meta’s message ID', async () => {
    const { p, calls } = provider(() => json(200, { messages: [{ id: 'wamid.ABC' }] }));
    const sent = await p.sendTemplate({
      to: '+2348031234567',
      templateName: 'booking_confirmed',
      language: 'en',
      category: 'UTILITY',
      params: ['Ada', 'Obi Lagos'],
    });
    expect(sent).toEqual({ providerRef: 'wamid.ABC' });
    expect(calls[0]?.url).toBe('https://graph.facebook.com/v23.0/1234567890/messages');
    expect(calls[0]?.init.headers).toMatchObject({
      Authorization: 'Bearer EAAtest-token-0123456789',
    });
    expect(JSON.parse(calls[0]?.init.body as string)).toEqual({
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: '2348031234567',
      type: 'template',
      template: {
        name: 'booking_confirmed',
        language: { code: 'en' },
        components: [
          {
            type: 'body',
            parameters: [
              { type: 'text', text: 'Ada' },
              { type: 'text', text: 'Obi Lagos' },
            ],
          },
        ],
      },
    });
  });

  it('repeats a one-time code in the copy-code button (authentication templates)', async () => {
    const { p, calls } = provider(() => json(200, { messages: [{ id: 'wamid.OTP' }] }));
    await p.sendTemplate({
      to: '+2348031234567',
      templateName: 'approval_code',
      language: 'en',
      category: 'AUTHENTICATION',
      params: ['482913'],
    });
    const body = JSON.parse(calls[0]?.init.body as string) as { template: { components: unknown } };
    expect(body.template.components).toEqual([
      { type: 'body', parameters: [{ type: 'text', text: '482913' }] },
      {
        type: 'button',
        sub_type: 'url',
        index: '0',
        parameters: [{ type: 'text', text: '482913' }],
      },
    ]);
  });

  it.each([
    [400, 131030, true, 'not an allowed recipient'],
    [400, 132001, true, 'template does not exist'],
    [401, 190, true, 'token expired'],
    [429, 130429, false, 'throughput'],
    [400, 131056, false, 'pair rate limit'],
    [500, 1, false, 'unknown'],
  ])('HTTP %i, Meta code %i: permanent %s (%s)', async (status, code, permanent, message) => {
    const { p } = provider(() => json(status, { error: { code, message } }));
    const err = await p
      .sendTemplate({
        to: '+1',
        templateName: 'x',
        language: 'en',
        category: 'UTILITY',
        params: [],
      })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(MessageSendError);
    expect(err).toMatchObject({ permanent, message: `Meta ${status} (${code}): ${message}` });
  });

  it('a network failure may pass: not permanent; the token never appears in errors', async () => {
    const { p } = provider(() => Promise.reject(new TypeError('fetch failed')));
    const err = (await p
      .sendTemplate({
        to: '+1',
        templateName: 'x',
        language: 'en',
        category: 'UTILITY',
        params: [],
      })
      .catch((e: unknown) => e)) as MessageSendError;
    expect(err.permanent).toBe(false);
    expect(err.message).not.toContain('EAAtest');
  });
});

describe('webhook checks', () => {
  it('accepts only Meta’s signature over the exact bytes', () => {
    const { p } = provider(() => json(200, {}));
    const raw = Buffer.from('{"entry":[]}');
    expect(
      p.verifySignature(raw, { 'x-hub-signature-256': signBody('app-secret-0123456789', raw) }),
    ).toBe(true);
    expect(p.verifySignature(raw, { 'x-hub-signature-256': signBody('other', raw) })).toBe(false);
    expect(
      p.verifySignature(Buffer.from('{"entry": []}'), {
        'x-hub-signature-256': signBody('app-secret-0123456789', raw),
      }),
    ).toBe(false);
    expect(p.verifySignature(raw, {})).toBe(false);
  });

  it('refuses every webhook without an app secret, and the check without a verify token', () => {
    const { p } = provider(() => json(200, {}), { appSecret: null, verifyToken: null });
    const raw = Buffer.from('{}');
    expect(p.verifySignature(raw, { 'x-hub-signature-256': signBody('', raw) })).toBe(false);
    expect(
      p.verifyChallenge({ 'hub.mode': 'subscribe', 'hub.verify_token': '', 'hub.challenge': '1' }),
    ).toBeNull();
  });

  it('echoes the challenge for the right verify token only', () => {
    const { p } = provider(() => json(200, {}));
    const q = { 'hub.mode': 'subscribe', 'hub.challenge': '42' };
    expect(p.verifyChallenge({ ...q, 'hub.verify_token': 'verify-token-0123456789' })).toBe('42');
    expect(p.verifyChallenge({ ...q, 'hub.verify_token': 'nope' })).toBeNull();
  });

  it('reads delivery statuses and ignores incoming messages', () => {
    expect(
      parseMetaStatuses({
        entry: [
          {
            changes: [
              {
                value: {
                  messages: [{ id: 'wamid.IN', text: { body: 'hello' } }],
                  statuses: [
                    { id: 'wamid.1', status: 'delivered' },
                    { id: 'wamid.2', status: 'read' },
                    {
                      id: 'wamid.3',
                      status: 'failed',
                      errors: [{ code: 131026, title: 'Undeliverable' }],
                    },
                    { id: 'wamid.4', status: 'deleted' },
                  ],
                },
              },
            ],
          },
        ],
      }),
    ).toEqual([
      { providerRef: 'wamid.1', status: 'DELIVERED', error: null },
      { providerRef: 'wamid.2', status: 'READ', error: null },
      { providerRef: 'wamid.3', status: 'FAILED', error: '131026: Undeliverable' },
    ]);
    expect(parseMetaStatuses('nonsense')).toEqual([]);
  });
});

describe('template submission', () => {
  it('numbers the placeholders and gives Meta an example of each', () => {
    const def = messageTemplateDef('PAYMENT_REQUEST');
    if (!def) throw new Error('missing');
    expect(templateSubmission(def)).toEqual({
      name: 'payment_request',
      language: 'en',
      category: 'UTILITY',
      components: [
        {
          type: 'BODY',
          text:
            'Hello {{1}}, {{2}} has sent you a payment request of {{3}} for {{4}}. Pay securely ' +
            'here: {{5}} Thank you.',
          example: {
            body_text: [
              [
                'Ada Okafor',
                'Demo Lagos Hotel',
                '₦45,000.00',
                'booking LAG-10234',
                'https://pay.example.com/abc123',
              ],
            ],
          },
        },
      ],
    });
  });

  it('submits the approval code as a copy-code authentication template', () => {
    const def = messageTemplateDef('APPROVAL_OTP');
    if (!def) throw new Error('missing');
    expect(templateSubmission(def)).toMatchObject({
      name: 'approval_code',
      category: 'AUTHENTICATION',
      components: [
        { type: 'BODY', add_security_recommendation: true },
        { type: 'BUTTONS', buttons: [{ type: 'OTP', otp_type: 'COPY_CODE' }] },
      ],
    });
  });
});
