import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import { FAKE_WEBHOOK_KEY } from '../../core/payments.ts';
import { PAYSTACK_SIGNATURE_HEADER, signPaystack } from '../../core/paystack-events.ts';
import { resetDb, testDb } from '../../../test/db.ts';
import { errorOf } from '../../../test/helpers.ts';
import { inHouse } from '../../../test/in-house.ts';
import { createDefaultApprovalPolicies } from '../approvals/defaults.ts';
import { processWebhookEvents } from '../payments/webhooks.ts';

// Cancelling an event (T-121b; Philip's rule of 2026-11-10: no cancelling within 24 hours of
// the event; within 24 hours of booking 30% of the deposit is kept, after that 50%).

const db = testDb();
let now: Date;
const clock = () => new Date(now);

beforeEach(async () => {
  await resetDb(db);
  now = new Date('2026-11-10T09:00:00Z');
});

type Cancellation = {
  allowed: boolean;
  reason: string | null;
  keepBps: number;
  depositPaidMinor: string;
  feeMinor: string;
  receivedMinor: string;
  rule: { noticeHours: number; earlyHours: number; earlyKeepBps: number; laterKeepBps: number };
};

// A fixed ₦400,000 deposit, whatever the hire comes to with tax; the rest is one instalment.
const DEPOSIT = 40000000n;

async function hotel() {
  const h = await inHouse(db, clock);
  await createDefaultApprovalPolicies(db, h.org.id, h.p1.id);
  const space = await h.ok<{ id: string; layouts: { id: string }[] }>(
    h.gm.post('/spaces', {
      code: 'HALL',
      name: 'Marina Hall',
      layouts: [{ name: 'Banquet', capacity: 120 }],
    }),
  );
  const enquiry = await h.ok<{ id: string }>(
    h.gm.post('/event-enquiries', { contactName: 'Adaeze Obi', eventType: 'Wedding' }),
  );
  const slot = {
    spaceId: space.id,
    layoutId: space.layouts[0]?.id,
    startsAt: '2026-12-05T10:00:00Z',
    endsAt: '2026-12-05T16:00:00Z',
    expectedGuests: 100,
    holdUntil: '2026-11-20T09:00:00Z',
  };
  const booking = await h.ok<{ id: string }>(
    h.gm.send('/event-bookings', { ...slot, enquiryId: enquiry.id, title: 'Adaeze wedding' }),
  );
  const at = `/event-bookings/${booking.id}`;
  let hookId = 7000;
  const transfer = async (account: string, amountMinor: bigint) => {
    const id = hookId++;
    const body = JSON.stringify({
      event: 'charge.success',
      data: {
        id,
        status: 'success',
        reference: `T${id}`,
        amount: Number(amountMinor),
        currency: 'NGN',
        paid_at: '2026-11-10T09:10:00.000Z',
        channel: 'dedicated_nuban',
        authorization: { receiver_bank_account_number: account, sender_name: 'ADAEZE OBI' },
      },
    });
    await request(h.app)
      .post('/api/v1/webhooks/payments/fake')
      .set('Content-Type', 'application/json')
      .set(PAYSTACK_SIGNATURE_HEADER, signPaystack(body, FAKE_WEBHOOK_KEY))
      .send(body)
      .expect(200);
    await processWebhookEvents({ db, clock, provider: h.payments });
  };
  /** Quoted, contracted and the deposit paid (in full unless `paid` is given). */
  const contracted = async (paid = DEPOSIT) => {
    const q = await h.ok<{ versions: { totalMinor: string }[] }>(
      h.gm.send(`${at}/quotes`, {
        lines: [{ kind: 'SPACE', description: 'Hall', quantity: 1, unitMinor: '100000000' }],
      }),
    );
    const total = BigInt(q.versions[0]?.totalMinor ?? 0);
    const v = await h.ok<{
      contract: { account: { accountNumber: string }; folio: { id: string } };
    }>(
      h.gm.send(`${at}/contract`, {
        clientName: 'Adaeze Obi',
        clientEmail: 'adaeze@example.com',
        clientPhone: '+2348011111111',
        terms: 'Terms',
        send: true,
        schedule: [
          { kind: 'DEPOSIT', dueDate: '2026-11-12', amountMinor: DEPOSIT.toString() },
          {
            kind: 'INSTALMENT',
            dueDate: '2026-11-28',
            amountMinor: (total - DEPOSIT).toString(),
          },
        ],
      }),
    );
    await transfer(v.contract.account.accountNumber, paid);
    return { account: v.contract.account.accountNumber, folioId: v.contract.folio.id };
  };
  const confirmed = async () => {
    const c = await contracted();
    await h.ok(h.gm.post(`${at}/contract/sign`, { signedByName: 'A', signedOn: '2026-11-10' }));
    await h.ok(h.gm.send(`${at}/confirm`, {}));
    return c;
  };
  const preview = async () => h.ok<Cancellation>((await h.as(h.gmId)).get(`${at}/cancellation`));
  const cancel = async (reason = 'Wedding postponed') =>
    (await h.as(h.gmId)).send(`${at}/cancel`, { reason });
  return {
    ...h,
    at,
    slot,
    bookingId: booking.id,
    enquiryId: enquiry.id,
    transfer,
    contracted,
    confirmed,
    preview,
    cancel,
  };
}

const feeLines = (folioId: string) => db.folioLine.findMany({ where: { folioId, kind: 'CHARGE' } });

describe('cancelling an event (T-121b)', () => {
  it('within 24 hours of booking keeps 30% of the deposit and gives the space back', async () => {
    const h = await hotel();
    const { folioId } = await h.confirmed();
    now = new Date('2026-11-10T20:00:00Z');
    expect(await h.preview()).toMatchObject({
      allowed: true,
      keepBps: 3000,
      depositPaidMinor: DEPOSIT.toString(),
      feeMinor: '12000000',
    });
    const done = await h.ok<{ status: string }>(h.cancel());
    expect(done.status).toBe('CANCELLED');
    const [fee] = await feeLines(folioId);
    expect(fee).toMatchObject({
      description: 'Cancellation: 30% of the deposit',
      amountMinor: 12000000n,
    });
    expect(await db.eventContract.count({ where: { status: 'VOID' } })).toBe(1);
    const enquiry = await db.eventEnquiry.findUniqueOrThrow({ where: { id: h.enquiryId } });
    expect(enquiry).toMatchObject({ status: 'LOST', lostReason: 'Cancelled: Wedding postponed' });
    // The space is free again.
    const gm = await h.as(h.gmId);
    await h.ok(gm.send('/event-bookings', { ...h.slot, title: 'Another event' }));
  });

  it('after 24 hours of booking keeps 50%', async () => {
    const h = await hotel();
    await h.confirmed();
    now = new Date('2026-11-12T09:00:00Z');
    expect(await h.preview()).toMatchObject({ keepBps: 5000, feeMinor: '20000000' });
    await h.ok(h.cancel());
    const row = await db.eventBooking.findUniqueOrThrow({ where: { id: h.bookingId } });
    expect(row.cancellationFeeMinor).toBe(20000000n);
  });

  it('cannot be cancelled within 24 hours of the event', async () => {
    const h = await hotel();
    await h.confirmed();
    now = new Date('2026-12-04T11:00:00Z');
    expect(await h.preview()).toMatchObject({ allowed: false, reason: 'TOO_CLOSE' });
    const refused = await h.cancel();
    expect(refused.status).toBe(409);
    expect(errorOf(refused).details?.['reason']).toBe('TOO_CLOSE');
  });

  it('the share is of the deposit actually paid', async () => {
    const h = await hotel();
    await h.contracted(10000000n);
    now = new Date('2026-11-12T09:00:00Z');
    // A paid hold counts as booked when its contract was issued.
    expect(await h.preview()).toMatchObject({
      allowed: true,
      keepBps: 5000,
      depositPaidMinor: '10000000',
      feeMinor: '5000000',
    });
    await h.ok(h.cancel());
  });

  it('an unpaid hold is released, not cancelled', async () => {
    const h = await hotel();
    expect(await h.preview()).toMatchObject({ allowed: false, reason: 'NOTHING_TO_CANCEL' });
    expect((await h.cancel()).status).toBe(409);
  });

  it('the rest is refunded from the bill, then the cancelled event is closed', async () => {
    const h = await hotel();
    const { folioId, account } = await h.confirmed();
    await h.ok(h.cancel());
    const gm = await h.as(h.gmId);
    const view = await h.ok<{ blockers: string[]; folio: { balanceMinor: string } }>(
      gm.get(`${h.at}/close-out`),
    );
    expect(view.blockers).toEqual(['CREDIT_TO_RETURN']);
    expect((await gm.send(`${h.at}/close`, {})).status).toBe(409);

    await h.ok(gm.send('/shifts', { floatMinor: '0' }));
    const payment = await db.payment.findFirstOrThrow({ where: { folioId } });
    await h.ok(
      gm.send(`/payments/${payment.id}/refund`, {
        amountMinor: (-BigInt(view.folio.balanceMinor)).toString(),
        method: 'BANK_TRANSFER',
        externalRef: 'REF-C1',
        reason: 'Cancellation refund',
      }),
    );
    const closed = await h.ok<{ status: string }>(gm.send(`${h.at}/close`, {}));
    expect(closed.status).toBe('CANCELLED');
    const row = await db.eventBooking.findUniqueOrThrow({ where: { id: h.bookingId } });
    expect(row.closedAt).not.toBeNull();
    expect((await db.folio.findUniqueOrThrow({ where: { id: folioId } })).status).toBe('SETTLED');
    expect((await gm.send(`${h.at}/close`, {})).status).toBe(409);
    // Money sent after cancelling waits to be matched.
    await h.transfer(account, 1000000n);
    expect(await db.unmatchedTransfer.count()).toBe(1);
  });

  it('the contract states the rule, and cancelling needs event.confirm', async () => {
    const h = await hotel();
    await h.confirmed();
    expect(h.email.sent.at(-1)?.text).toContain('30% of the deposit paid is kept');
    const fd = await h.as(h.fdId);
    expect((await fd.send(`${h.at}/cancel`, { reason: 'X' })).status).toBe(403);
    expect((await (await h.as(h.gmId)).send(`${h.at}/cancel`, { reason: '' })).status).toBe(400);
  });
});

describe('the hotel’s own cancellation rule (T-121c)', () => {
  const OWN = { noticeHours: 72, earlyHours: 12, earlyKeepBps: 2000, laterKeepBps: 8000 };

  it('starts as the standard rule and can be changed by space.manage only', async () => {
    const h = await hotel();
    expect(await h.ok(h.gm.get('/event-settings'))).toEqual({
      cancellation: { noticeHours: 24, earlyHours: 24, earlyKeepBps: 3000, laterKeepBps: 5000 },
      isDefault: true,
    });
    expect(await h.ok(h.gm.put('/event-settings', { cancellation: OWN }))).toEqual({
      cancellation: OWN,
      isDefault: false,
    });
    expect((await h.fd.put('/event-settings', { cancellation: OWN })).status).toBe(403);
    const tooMuch = { cancellation: { ...OWN, laterKeepBps: 10001 } };
    expect((await h.gm.put('/event-settings', tooMuch)).status).toBe(400);
    expect(await db.auditEvent.count({ where: { action: 'event_settings.updated' } })).toBe(1);
  });

  it('a contract is printed with, and cancelled under, the rule in force when it was issued', async () => {
    const h = await hotel();
    await h.ok(h.gm.put('/event-settings', { cancellation: OWN }));
    await h.confirmed();
    expect(h.email.sent.at(-1)?.text).toContain('within 12 hours of booking: 20%');
    // A later change to the hotel's rule leaves this contract alone.
    await h.ok(
      h.gm.put('/event-settings', {
        cancellation: { noticeHours: 1, earlyHours: 1, earlyKeepBps: 0, laterKeepBps: 0 },
      }),
    );
    now = new Date('2026-11-12T09:00:00Z');
    expect(await h.preview()).toMatchObject({
      keepBps: 8000,
      feeMinor: '32000000',
      rule: OWN,
    });
    // 72 hours' notice: on 3 December it can no longer be cancelled.
    now = new Date('2026-12-03T11:00:00Z');
    expect(await h.preview()).toMatchObject({ allowed: false, reason: 'TOO_CLOSE' });
    expect(errorOf(await h.cancel()).message).toContain('Within 72 hours');
  });

  it('a booking confirmed without a contract follows the hotel’s current rule', async () => {
    const h = await hotel();
    await h.ok(h.gm.send(`${h.at}/confirm`, { override: true, reason: 'Regular client' }));
    await h.ok(h.gm.put('/event-settings', { cancellation: OWN }));
    const view = await h.preview();
    expect(view.rule).toEqual(OWN);
    expect(view.feeMinor).toBe('0');
  });
});
