import { describe, expect, it, vi } from 'vitest';
import { PaymentProviderError } from './payments.ts';
import { chargeStatusOf, createPaystackProvider } from './paystack.ts';
import { PAYSTACK_SIGNATURE_HEADER, parsePaystackEvent, signPaystack } from './paystack-events.ts';

// Paystack adapter (ADR-021; T-070): the requests it sends and how it reads the answers.

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

function provider(answer: (url: string, init: RequestInit) => Response | Promise<Response>) {
  const fetch = vi.fn((url: string | URL | Request, init?: RequestInit) =>
    Promise.resolve(answer(url instanceof Request ? url.url : url.toString(), init ?? {})),
  );
  return { p: createPaystackProvider({ secretKey: 'sk_test_abc', fetch }), fetch };
}

const request = {
  reference: 'HP-abc',
  amountMinor: 12_325_000n,
  currency: 'NGN',
  email: 'ada@example.com',
  callbackUrl: null,
  metadata: { hotel: 'Obi Hotel', for: 'your bill F00001' },
};

describe('Paystack', () => {
  it('opens a checkout with the amount in kobo under our reference', async () => {
    const { p, fetch } = provider(() =>
      json(200, {
        status: true,
        data: {
          authorization_url: 'https://checkout.paystack.com/0peioxfhpn',
          access_code: '0peioxfhpn',
          reference: 'HP-abc',
        },
      }),
    );
    expect(await p.createCheckout(request)).toEqual({
      reference: 'HP-abc',
      checkoutUrl: 'https://checkout.paystack.com/0peioxfhpn',
    });
    const [url, init] = fetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.paystack.co/transaction/initialize');
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>)['Authorization']).toBe('Bearer sk_test_abc');
    expect(JSON.parse(init.body as string)).toEqual({
      email: 'ada@example.com',
      amount: '12325000',
      currency: 'NGN',
      reference: 'HP-abc',
      metadata: { hotel: 'Obi Hotel', for: 'your bill F00001' },
    });
  });

  it('reads a charge back by reference', async () => {
    const { p, fetch } = provider(() =>
      json(200, {
        status: true,
        data: {
          reference: 'HP-abc',
          status: 'success',
          amount: 12325000,
          currency: 'NGN',
          paid_at: '2026-11-10T09:20:00.000Z',
          channel: 'card',
        },
      }),
    );
    expect(await p.verify('HP-abc')).toEqual({
      reference: 'HP-abc',
      status: 'SUCCEEDED',
      amountMinor: 12_325_000n,
      currency: 'NGN',
      paidAt: new Date('2026-11-10T09:20:00.000Z'),
      channel: 'card',
    });
    expect(fetch.mock.calls[0]?.[0]).toBe('https://api.paystack.co/transaction/verify/HP-abc');
  });

  it.each([
    ['success', 'SUCCEEDED'],
    ['failed', 'FAILED'],
    ['reversed', 'FAILED'],
    ['abandoned', 'PENDING'],
    ['ongoing', 'PENDING'],
    ['pending', 'PENDING'],
  ])('%s → %s', (status, ours) => {
    expect(chargeStatusOf(status)).toBe(ours);
  });

  it('fails without passing on what Paystack said', async () => {
    const refused = provider(() =>
      json(401, { status: false, message: 'Invalid key sk_test_abc' }),
    );
    const err = await refused.p.createCheckout(request).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PaymentProviderError);
    expect((err as Error).message).toBe('Paystack refused the request (401)');
    const unreachable = provider(() => Promise.reject(new Error('ECONNRESET')));
    await expect(unreachable.p.verify('HP-abc')).rejects.toThrow('Paystack could not be reached');
    const odd = provider(() => json(200, { status: true, data: { reference: 'HP-other' } }));
    await expect(odd.p.verify('HP-abc')).rejects.toThrow(PaymentProviderError);
  });
});

describe('Paystack webhooks and dedicated accounts (T-071)', () => {
  const event = {
    event: 'charge.success',
    data: {
      id: 302961,
      status: 'success',
      reference: 'T302961',
      amount: 5000000,
      currency: 'NGN',
      paid_at: '2026-11-10T09:10:00.000Z',
      channel: 'dedicated_nuban',
      authorization: { receiver_bank_account_number: '9930000001', sender_name: 'ADA OBI' },
    },
  };

  it('reads a signed event, and nothing from a forged one', () => {
    const { p } = provider(() => json(200, {}));
    const raw = Buffer.from(JSON.stringify(event));
    const headers = { [PAYSTACK_SIGNATURE_HEADER]: signPaystack(raw, 'sk_test_abc') };
    expect(p.readWebhook(raw, headers)).toEqual({
      signatureOk: true,
      payload: event,
      event: {
        id: 'charge.success:302961',
        type: 'CHARGE_SUCCEEDED',
        reference: 'T302961',
        amountMinor: 5_000_000n,
        currency: 'NGN',
        paidAt: new Date('2026-11-10T09:10:00.000Z'),
        channel: 'dedicated_nuban',
        accountNumber: '9930000001',
        senderName: 'ADA OBI',
      },
    });
    const forged = { [PAYSTACK_SIGNATURE_HEADER]: signPaystack(raw, 'sk_test_other') };
    expect(p.readWebhook(raw, forged)).toEqual({ signatureOk: false });
    expect(p.readWebhook(raw, {})).toEqual({ signatureOk: false });
    // The account number may come in the metadata instead.
    expect(
      parsePaystackEvent({
        ...event,
        data: { ...event.data, authorization: {}, metadata: { receiver_account_number: '991' } },
      }),
    ).toMatchObject({ accountNumber: '991', senderName: null });
    expect(parsePaystackEvent({ event: 'charge.failed', data: { id: 1 } })).toEqual({
      id: 'charge.failed:1',
      type: 'OTHER',
      reference: null,
    });
  });

  it('creates a customer, then a dedicated account at the test bank with a test key', async () => {
    const { p, fetch } = provider((url) =>
      url.endsWith('/customer')
        ? json(200, { status: true, data: { customer_code: 'CUS_xyz' } })
        : json(200, {
            status: true,
            data: {
              account_number: '9930000001',
              account_name: 'HOTEL/OBI ADA',
              bank: { name: 'Test Bank' },
            },
          }),
    );
    expect(
      await p.createVirtualAccount({
        email: 'ada@example.com',
        firstName: 'Ada',
        lastName: 'Obi',
        phone: '+2348011111111',
      }),
    ).toEqual({ accountNumber: '9930000001', bankName: 'Test Bank', accountName: 'HOTEL/OBI ADA' });
    const [customerCall, accountCall] = fetch.mock.calls as unknown as [
      [string, RequestInit],
      [string, RequestInit],
    ];
    expect(customerCall[0]).toBe('https://api.paystack.co/customer');
    expect(JSON.parse(customerCall[1].body as string)).toEqual({
      email: 'ada@example.com',
      first_name: 'Ada',
      last_name: 'Obi',
      phone: '+2348011111111',
    });
    expect(accountCall[0]).toBe('https://api.paystack.co/dedicated_account');
    expect(JSON.parse(accountCall[1].body as string)).toEqual({
      customer: 'CUS_xyz',
      preferred_bank: 'test-bank',
    });
  });
});
