import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import { PaymentProviderError } from '../../core/payments.ts';
import { resetDb, testDb } from '../../../test/db.ts';
import { errorOf } from '../../../test/helpers.ts';
import { inHouse } from '../../../test/in-house.ts';
import { checkOpenIntents } from './intents.ts';

// Payment links (PRD M4-07 online card, M4-08 "I send a payment link … by WhatsApp or email";
// M4 rules 4–5; tab 4 POST /payment-intents ●; ADR-021; T-070).

const db = testDb();
let now: Date;
const clock = () => new Date(now);

beforeEach(async () => {
  await resetDb(db);
  now = new Date('2026-11-10T09:00:00Z');
});

type Intent = {
  id: string;
  folioId: string | null;
  windowNumber: number | null;
  reservationId: string | null;
  provider: string;
  reference: string;
  amountMinor: string;
  currency: string;
  status: string;
  checkoutUrl: string;
  sentTo: string | null;
  requestedBy: string | null;
  paymentId: string | null;
  paidAt: string | null;
  expiresAt: string;
};

/** Ada Obi in house with a ₦123,250 room charge; a booking for next week (Bola). */
async function hotel() {
  const h = await inHouse(db, clock);
  await h.ok(
    h.charge({ revenueCode: 'ROOM', description: 'Room 101', unitAmountMinor: '10000000' }),
  );
  const link = (body: object, as = h.fd) => as.send('/payment-intents', body);
  const check = (id: string, as = h.fd) => as.send(`/payment-intents/${id}/check`);
  const balance = async () => (await h.folio()).balanceMinor;
  return { ...h, link, check, balance };
}

describe('payment links', () => {
  it('emails a link for the folio; once paid it becomes one online payment on the system shift', async () => {
    const h = await hotel();
    const res = await h.link({
      folioId: h.folioId,
      amountMinor: '12325000',
      email: 'ada@example.com',
      send: true,
    });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    const intent = res.body as Intent;
    expect(intent).toMatchObject({
      folioId: h.folioId,
      windowNumber: 1,
      reservationId: null,
      provider: 'FAKE',
      amountMinor: '12325000',
      currency: 'NGN',
      status: 'CREATED',
      sentTo: 'ada@example.com',
      paymentId: null,
      expiresAt: '2026-11-13T09:00:00Z',
    });
    expect(intent.reference).toMatch(/^HP-/);
    expect(intent.checkoutUrl).toBe(
      `http://app.test.localhost/api/v1/dev/fake-pay/${intent.reference}`,
    );
    const mail = h.email.lastTo('ada@example.com');
    expect(mail?.subject).toMatch(/^Payment request from Property .+: NGN 123,250\.00$/);
    expect(mail?.text).toContain(intent.checkoutUrl);

    // Not paid yet: nothing changes.
    expect((await h.ok<Intent>(h.check(intent.id))).status).toBe('CREATED');
    expect(await h.balance()).toBe('12325000');

    // The guest pays on the (fake) checkout page.
    const page = await request(h.app).get(new URL(intent.checkoutUrl).pathname);
    expect(page.status).toBe(200);
    expect(page.text).toContain('Paid NGN 123250.00');
    now = new Date('2026-11-10T09:30:00Z');
    const paid = await h.ok<Intent>(h.check(intent.id));
    expect(paid.status).toBe('SUCCEEDED');
    // When the provider says it was paid (the fake page uses the real clock).
    expect(paid.paidAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(await h.balance()).toBe('0');

    // Recorded once, whatever asks again (desk or job).
    await h.ok(h.check(intent.id));
    expect(await checkOpenIntents({ db, clock, provider: h.payments })).toBe(0);
    const payments = await db.payment.findMany({ include: { shift: true } });
    expect(payments).toHaveLength(1);
    expect(payments[0]).toMatchObject({
      id: paid.paymentId,
      method: 'CARD_ONLINE',
      provider: 'FAKE',
      externalRef: intent.reference,
      amountMinor: 12_325_000n,
      receivedById: null,
      note: 'Paid online (card)',
    });
    expect(payments[0]?.shift).toMatchObject({ userId: null, status: 'OPEN' });
    expect(
      await db.auditEvent.count({ where: { action: 'payment.captured', actorType: 'SYSTEM' } }),
    ).toBe(1);

    const list = await h.ok<{ data: Intent[] }>(h.fd.get(`/payment-intents?folioId=${h.folioId}`));
    expect(list.data.map((i) => [i.id, i.status, i.requestedBy])).toEqual([
      [intent.id, 'SUCCEEDED', expect.any(String)],
    ]);
  });

  it('takes a deposit for a booking, or pays the folio when the guest has checked in since', async () => {
    const h = await inHouse(db, clock, { guarantee: 'DEPOSIT', checkIn: false });
    const ask = async () =>
      h.ok<Intent>(
        h.fd.send('/payment-intents', {
          reservationId: h.reservationId,
          amountMinor: '5000000',
          email: 'ada@example.com',
        }),
      );
    // Paid before arrival: the deposit ledger holds it.
    const first = await ask();
    expect(first).toMatchObject({ reservationId: h.reservationId, folioId: null, sentTo: null });
    h.payments.complete(first.reference);
    expect(await checkOpenIntents({ db, clock, provider: h.payments })).toBe(1);
    const entries = await db.depositLedgerEntry.findMany();
    expect(entries.map((e) => [e.kind, e.amountMinor])).toEqual([['RECEIVED', 5_000_000n]]);

    // A second link, paid after check-in: it lands on the folio.
    const second = await ask();
    await h.checkIn();
    h.payments.complete(second.reference);
    await h.ok(h.fd.send(`/payment-intents/${second.id}/check`));
    const payment = await db.payment.findFirstOrThrow({ where: { externalRef: second.reference } });
    expect(payment).toMatchObject({ folioId: h.folioId, reservationId: null });
    expect(await db.depositLedgerEntry.count({ where: { kind: 'RECEIVED' } })).toBe(1);
  });

  it('expires unpaid after 72 hours, still records a late payment, and records failures', async () => {
    const h = await hotel();
    const body = { folioId: h.folioId, amountMinor: '100000', email: 'ada@example.com' };
    const late = await h.ok<Intent>(h.link(body));
    const failed = await h.ok<Intent>(h.link(body));

    now = new Date('2026-11-13T09:00:01Z');
    const fd = await h.as(h.fdId);
    expect((await h.ok<Intent>(h.check(late.id, fd))).status).toBe('EXPIRED');
    h.payments.complete(failed.reference, 'FAILED');
    expect((await h.ok<Intent>(h.check(failed.id, fd))).status).toBe('FAILED');

    // The guest pays the expired link anyway: the money is recorded.
    h.payments.complete(late.reference);
    expect(await checkOpenIntents({ db, clock, provider: h.payments })).toBe(1);
    expect((await db.paymentIntent.findUniqueOrThrow({ where: { id: late.id } })).status).toBe(
      'SUCCEEDED',
    );
  });

  it('refuses closed folios, unknown windows, past bookings and staff without payment.request', async () => {
    const h = await hotel();
    const body = { folioId: h.folioId, amountMinor: '100000', email: 'ada@example.com' };
    expect(errorOf(await h.link({ ...body, windowNumber: 3 })).details).toMatchObject({
      issues: [{ path: 'body.windowNumber' }],
    });
    expect((await h.link({ ...body, email: 'not-an-email' })).status).toBe(400);
    expect((await h.link({ ...body, amountMinor: '0' })).status).toBe(400);
    expect(
      errorOf(await h.link({ ...body, reservationId: h.reservationId })).details,
    ).toMatchObject({ issues: [{ path: 'body.folioId' }] });
    expect(
      errorOf(await h.link({ reservationId: h.reservationId, amountMinor: '1', email: 'a@b.co' }))
        .code,
    ).toBe('STATE_TRANSITION_INVALID');
    const fin = await h.as(h.finance.id);
    expect((await h.link(body, fin)).status).toBe(403);

    await db.folio.update({ where: { id: h.folioId }, data: { status: 'SETTLED' } });
    expect(errorOf(await h.link(body)).code).toBe('STATE_TRANSITION_INVALID');
    expect(await db.paymentIntent.count()).toBe(0);
  });

  it('answers 502 when the provider is down, and waits while night audit posts', async () => {
    const h = await hotel();
    const body = { folioId: h.folioId, amountMinor: '100000', email: 'ada@example.com' };
    const create = h.payments.createCheckout.bind(h.payments);
    h.payments.createCheckout = () => Promise.reject(new PaymentProviderError('down', 503));
    const down = await h.link(body);
    expect(down.status).toBe(502);
    expect(errorOf(down)).toMatchObject({
      code: 'PAYMENT_PROVIDER_UNAVAILABLE',
      message: 'The payment provider could not be reached; try again in a minute',
    });
    expect(await db.paymentIntent.count()).toBe(0);
    h.payments.createCheckout = create;

    const intent = await h.ok<Intent>(h.link(body));
    h.payments.complete(intent.reference);
    await db.businessDay.updateMany({ data: { status: 'AUDITING' } });
    expect(errorOf(await h.check(intent.id)).code).toBe('AUDIT_IN_PROGRESS');
    expect(await checkOpenIntents({ db, clock, provider: h.payments })).toBe(0);
    await db.businessDay.updateMany({ data: { status: 'OPEN' } });
    expect((await h.ok<Intent>(h.check(intent.id))).status).toBe('SUCCEEDED');
  });
});
