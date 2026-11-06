import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import { FAKE_WEBHOOK_KEY } from '../../core/payments.ts';
import { PAYSTACK_SIGNATURE_HEADER, signPaystack } from '../../core/paystack-events.ts';
import { resetDb, testDb } from '../../../test/db.ts';
import { errorOf } from '../../../test/helpers.ts';
import { inHouse } from '../../../test/in-house.ts';
import { processWebhookEvents, unmatchedTransferAlerts } from './webhooks.ts';

// Payment webhooks, virtual accounts and the unmatched-transfer queue (PRD M4-08, M4 rules
// 4–7 and the AC "replaying the same webhook 5 times creates exactly one payment"; tab 4 POST
// /webhooks/payments/{provider}, POST /virtual-accounts, GET /unmatched-transfers, POST
// /unmatched-transfers/{id}/match; T-071).

const db = testDb();
let now: Date;
const clock = () => new Date(now);

beforeEach(async () => {
  await resetDb(db);
  now = new Date('2026-11-10T09:00:00Z');
});

type Account = { id: string; accountNumber: string; bankName: string; accountName: string };
type Transfer = {
  id: string;
  reference: string;
  amountMinor: string;
  senderName: string | null;
  overdue: boolean;
  matchedPaymentId: string | null;
};

/** A Paystack-shaped charge.success, as the provider (or the simulate script) sends it. */
function charge(args: { id: number; amountMinor: number; reference?: string; account?: string }) {
  return JSON.stringify({
    event: 'charge.success',
    data: {
      id: args.id,
      status: 'success',
      reference: args.reference ?? `T${args.id}`,
      amount: args.amountMinor,
      currency: 'NGN',
      paid_at: '2026-11-10T09:10:00.000Z',
      channel: args.account ? 'dedicated_nuban' : 'card',
      authorization: args.account
        ? { receiver_bank_account_number: args.account, sender_name: 'ADA OBI' }
        : {},
    },
  });
}

async function hotel(options: { checkIn?: boolean } = {}) {
  const h = await inHouse(db, clock, { guarantee: 'DEPOSIT', checkIn: options.checkIn ?? true });
  if (options.checkIn !== false) {
    await h.ok(
      h.charge({ revenueCode: 'ROOM', description: 'Room 101', unitAmountMinor: '10000000' }),
    );
  }
  const hook = (
    body: string,
    signature = signPaystack(body, FAKE_WEBHOOK_KEY),
    provider = 'fake',
  ) =>
    request(h.app)
      .post(`/api/v1/webhooks/payments/${provider}`)
      .set('Content-Type', 'application/json')
      .set(PAYSTACK_SIGNATURE_HEADER, signature)
      .send(body);
  const run = () => processWebhookEvents({ db, clock, provider: h.payments });
  const stay = await db.stay.findUniqueOrThrow({ where: { id: h.stayId } });
  const account = (body: object, as = h.fd) =>
    h.ok<Account>(
      as.send('/virtual-accounts', { email: 'ada@example.com', phone: '+2348011111111', ...body }),
    );
  return { ...h, hook, run, guestId: stay.guestId, account };
}

describe('payment webhooks', () => {
  it('records a paid link once, however often the webhook is replayed (M4 AC)', async () => {
    const h = await hotel();
    const intent = await h.ok<{ id: string; reference: string }>(
      h.fd.send('/payment-intents', {
        folioId: h.folioId,
        amountMinor: '12325000',
        email: 'ada@example.com',
      }),
    );
    const body = charge({ id: 1001, amountMinor: 12_325_000, reference: intent.reference });
    for (let i = 0; i < 5; i += 1) {
      const res = await h.hook(body);
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ received: true });
    }
    expect(await db.webhookEvent.count()).toBe(1);
    expect(await h.run()).toBe(1);
    expect(await h.run()).toBe(0);
    const payments = await db.payment.findMany();
    expect(payments).toHaveLength(1);
    expect(payments[0]).toMatchObject({ method: 'CARD_ONLINE', externalRef: intent.reference });
    expect((await h.folio()).balanceMinor).toBe('0');
    const stored = await db.webhookEvent.findFirstOrThrow();
    expect(stored).toMatchObject({
      provider: 'FAKE',
      eventId: 'charge.success:1001',
      signatureOk: true,
      error: null,
    });
    expect(stored.processedAt).not.toBeNull();
    // Stored as it arrived, for good.
    await expect(
      db.webhookEvent.update({ where: { id: stored.id }, data: { payload: {} } }),
    ).rejects.toThrow();
  });

  it('refuses a bad signature (401, nothing stored) and an unknown provider; ignores other events', async () => {
    const h = await hotel();
    const body = charge({ id: 1, amountMinor: 100 });
    const forged = await h.hook(body, signPaystack(body, 'not-the-key'));
    expect(forged.status).toBe(401);
    expect(errorOf(forged).code).toBe('UNAUTHENTICATED');
    expect((await h.hook(body, 'abc')).status).toBe(401);
    expect((await h.hook(body, signPaystack(body, FAKE_WEBHOOK_KEY), 'paystack')).status).toBe(404);
    expect(await db.webhookEvent.count()).toBe(0);

    const other = JSON.stringify({ event: 'transfer.success', data: { id: 7, status: 'success' } });
    expect((await h.hook(other)).status).toBe(200);
    // Not ours: a charge on the provider account with no link or account behind it.
    expect((await h.hook(charge({ id: 8, amountMinor: 500 }))).status).toBe(200);
    expect(await h.run()).toBe(2);
    expect(await db.payment.count()).toBe(0);
    expect(await db.unmatchedTransfer.count()).toBe(0);
  });

  it('issues one virtual account per folio and records transfers to it', async () => {
    const h = await hotel();
    const account = await h.account({ ownerType: 'FOLIO', ownerId: h.folioId, send: true });
    expect(account).toMatchObject({ bankName: 'Fake Bank', accountName: 'HOTEL/OBI ADA' });
    expect(account.accountNumber).toMatch(/^99\d{8}$/);
    expect(h.email.lastTo('ada@example.com')?.text).toContain(
      `Account number: ${account.accountNumber}`,
    );
    // Asking again answers the same account.
    expect((await h.account({ ownerType: 'FOLIO', ownerId: h.folioId })).id).toBe(account.id);
    const listed = await h.ok<{ data: Account[] }>(
      h.fd.get(`/virtual-accounts?ownerType=FOLIO&ownerId=${h.folioId}`),
    );
    expect(listed.data.map((a) => a.id)).toEqual([account.id]);

    await h.hook(charge({ id: 2001, amountMinor: 5_000_000, account: account.accountNumber }));
    await h.run();
    const payment = await db.payment.findFirstOrThrow({ include: { shift: true } });
    expect(payment).toMatchObject({
      folioId: h.folioId,
      method: 'VIRTUAL_ACCOUNT',
      provider: 'FAKE',
      externalRef: 'T2001',
      amountMinor: 5_000_000n,
      receivedById: null,
      note: `Transfer from ADA OBI to ${account.accountNumber}`,
    });
    expect(payment.shift.userId).toBeNull();
    expect((await h.folio()).balanceMinor).toBe('7325000');
  });

  it('pays a guest account into their next booking, then into their folio once in house', async () => {
    const h = await hotel({ checkIn: false });
    const account = await h.account({ ownerType: 'GUEST', ownerId: h.guestId });
    expect(account.accountName).toBe('HOTEL/OBI ADA');
    await h.hook(charge({ id: 3001, amountMinor: 2_000_000, account: account.accountNumber }));
    await h.run();
    const entries = await db.depositLedgerEntry.findMany();
    expect(entries.map((e) => [e.kind, e.amountMinor])).toEqual([['RECEIVED', 2_000_000n]]);

    const folioId = await h.checkIn();
    await h.hook(charge({ id: 3002, amountMinor: 1_000_000, account: account.accountNumber }));
    await h.run();
    const paid = await db.payment.findFirstOrThrow({ where: { externalRef: 'T3002' } });
    expect(paid.folioId).toBe(folioId);
  });

  it('queues what no owner can take, alerts after 24 hours, and lets finance match it once', async () => {
    const h = await hotel();
    const account = await h.account({ ownerType: 'FOLIO', ownerId: h.folioId });
    await db.folio.update({ where: { id: h.folioId }, data: { status: 'SETTLED' } });
    await h.hook(charge({ id: 4001, amountMinor: 3_000_000, account: account.accountNumber }));
    await h.run();
    expect(await db.payment.count()).toBe(0);
    const fin = await h.as(h.finance.id);
    let list = await h.ok<{ data: Transfer[] }>(fin.get('/unmatched-transfers?matched=false'));
    expect(list.data).toEqual([
      expect.objectContaining({
        reference: 'T4001',
        amountMinor: '3000000',
        senderName: 'ADA OBI',
        overdue: false,
        matchedPaymentId: null,
      }),
    ]);
    const transfer = list.data[0] as Transfer;

    // 24 hours on: one alert, however often the job runs.
    now = new Date('2026-11-11T09:10:01Z');
    expect(await unmatchedTransferAlerts(db, clock)).toBe(1);
    expect(await unmatchedTransferAlerts(db, clock)).toBe(0);
    expect(await db.leakageAlert.findFirstOrThrow()).toMatchObject({
      ruleCode: 'UNMATCHED_TRANSFER',
      severity: 'HIGH',
      entityId: transfer.id,
    });

    // Finance matches it to the booking of another guest's folio… here, the reopened folio.
    await db.folio.update({ where: { id: h.folioId }, data: { status: 'OPEN' } });
    const fin2 = await h.as(h.finance.id);
    const match = (as = fin2) =>
      as.send(`/unmatched-transfers/${transfer.id}/match`, {
        folioId: h.folioId,
        note: 'Ada paid late',
      });
    expect((await match(await h.as(h.fdId))).status).toBe(200);
    const again = await match();
    expect(errorOf(again).code).toBe('STATE_TRANSITION_INVALID');
    const payment = await db.payment.findFirstOrThrow();
    expect(payment).toMatchObject({
      folioId: h.folioId,
      method: 'VIRTUAL_ACCOUNT',
      externalRef: 'T4001',
      receivedById: h.fdId,
      note: 'Ada paid late',
    });
    list = await h.ok<{ data: Transfer[] }>(fin2.get('/unmatched-transfers'));
    expect(list.data[0]?.matchedPaymentId).toBe(payment.id);
    // A second delivery of the same transfer records nothing new.
    await h.hook(charge({ id: 4001, amountMinor: 3_000_000, account: account.accountNumber }));
    await h.run();
    expect(await db.payment.count()).toBe(1);
  });

  it('tries again later while night audit posts', async () => {
    const h = await hotel();
    const account = await h.account({ ownerType: 'FOLIO', ownerId: h.folioId });
    await h.hook(charge({ id: 5001, amountMinor: 1_000_000, account: account.accountNumber }));
    await db.businessDay.updateMany({ data: { status: 'AUDITING' } });
    expect(await h.run()).toBe(0);
    const waiting = await db.webhookEvent.findFirstOrThrow();
    expect(waiting.processedAt).toBeNull();
    expect(waiting.error).toMatch(/^AUDIT_IN_PROGRESS/);
    await db.businessDay.updateMany({ data: { status: 'OPEN' } });
    expect(await h.run()).toBe(1);
    expect(await db.payment.count()).toBe(1);
  });
});
