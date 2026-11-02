import { beforeEach, describe, expect, it } from 'vitest';
import { catchUpBusinessDay } from '../../../test/business-day.ts';
import { resetDb, testDb } from '../../../test/db.ts';
import { errorOf } from '../../../test/helpers.ts';
import { inHouse, TODAY } from '../../../test/in-house.ts';

// Refunds (PRD M4 "as finance, I refund a payment (original method where possible) with
// reason and approval"; M1 rule 2 "any refund" needs approval; M4 rules 1, 4, 6; tab 4 POST
// /payments/{id}/refund; T-072).

const db = testDb();
let now: Date;
const clock = () => new Date(now);

beforeEach(async () => {
  await resetDb(db);
  now = new Date('2026-11-10T09:00:00Z');
});

type Captured = { paymentId: string; balanceMinor: string };
type Refunded = { refundId: string; baseAmountMinor: string; balanceMinor: string };
type Pending = { approvalRequestId: string; status: string };

/** Ada Obi in house with a ₦123,250 room charge, cash and POS switched on; the front desk's
 * and finance's shifts open; the GM's not. */
async function hotel(options: { checkIn?: boolean } = {}) {
  const h = await inHouse(db, clock, { guarantee: 'DEPOSIT', checkIn: options.checkIn ?? true });
  await db.property.update({
    where: { id: h.p1.id },
    data: { settings: { paymentMethods: ['CASH', 'POS_TERMINAL'] } },
  });
  if (options.checkIn !== false) {
    await h.ok(
      h.charge({ revenueCode: 'ROOM', description: 'Room 101', unitAmountMinor: '10000000' }),
    );
  }
  const fin = await h.as(h.finance.id);
  await h.ok(h.fd.send('/shifts', { floatMinor: '0' }));
  await h.ok(fin.send('/shifts', { floatMinor: '0' }));
  const pay = (body: object) =>
    h.ok<Captured>(h.fd.send('/payments', { folioId: h.folioId, method: 'CASH', ...body }));
  const refund = (paymentId: string, body: object, as = fin) =>
    as.send(`/payments/${paymentId}/refund`, body);
  return { ...h, fin, pay, refund };
}

describe('Refunds with approval', () => {
  it('waits for a manager, then pays out on the refunder’s shift as a negative payment', async () => {
    const h = await hotel();
    // The guest overpays by ₦20,000.
    const paid = await h.pay({ amountMinor: '14325000' });
    expect(paid.balanceMinor).toBe('-2000000');

    now = new Date('2026-11-10T09:10:00Z');
    const asked = await h.refund(paid.paymentId, { amountMinor: '2000000', reason: 'Overpaid' });
    expect(asked.status).toBe(202);
    expect((asked.body as Pending).status).toBe('PENDING');
    expect(await db.payment.count({ where: { refundsPaymentId: { not: null } } })).toBe(0);

    await h.ok(h.gm.post(`/approvals/${(asked.body as Pending).approvalRequestId}/approve`, {}));
    const refundRow = await db.payment.findFirstOrThrow({
      where: { refundsPaymentId: paid.paymentId },
    });
    const finShift = await db.cashierShift.findFirstOrThrow({ where: { userId: h.finance.id } });
    expect(refundRow).toMatchObject({
      amountMinor: -2000000n,
      baseAmountMinor: -2000000n,
      method: 'CASH',
      shiftId: finShift.id,
      receivedById: h.finance.id,
      note: 'Overpaid',
    });
    expect(refundRow.approvalRequestId).not.toBeNull();

    const folio = await h.ok<{
      balanceMinor: string;
      windows: {
        payments: {
          id: string;
          amountMinor: string;
          refundsPaymentId: string | null;
          refundableMinor: string;
        }[];
      }[];
    }>(h.fd.get(`/folios/${h.folioId}`));
    expect(folio.balanceMinor).toBe('0');
    expect(folio.windows[0]?.payments).toEqual([
      expect.objectContaining({
        id: paid.paymentId,
        refundableMinor: '12325000',
        refundsPaymentId: null,
      }),
      expect.objectContaining({
        amountMinor: '-2000000',
        refundsPaymentId: paid.paymentId,
        refundableMinor: '0',
      }),
    ]);
    const audit = await db.auditEvent.findFirstOrThrow({ where: { action: 'payment.refunded' } });
    expect(audit.reason).toBe('Overpaid');

    // The refund leaves the finance cashier's drawer.
    const list = await h.ok<{
      data: { id: string; lines: { method: string; expectedMinor: string }[] }[];
    }>(h.gm.get('/shifts?status=OPEN'));
    expect(list.data.find((x) => x.id === finShift.id)?.lines).toEqual([
      expect.objectContaining({ method: 'CASH', expectedMinor: '-2000000' }),
    ]);
  });

  it('a manager refunds directly; never more than is left, never a refund, and needs a shift', async () => {
    const h = await hotel();
    const paid = await h.pay({
      method: 'POS_TERMINAL',
      amountMinor: '5000000',
      externalRef: 'MPT-1',
    });
    // The GM has no open shift yet.
    const noShift = await h.refund(paid.paymentId, { amountMinor: '100', reason: 'x' }, h.gm);
    expect(errorOf(noShift).code).toBe('SHIFT_NOT_OPEN');
    await h.ok(h.gm.send('/shifts', { floatMinor: '0' }));

    // Back in cash when the POS can't reverse it.
    const first = await h.refund(
      paid.paymentId,
      { amountMinor: '3000000', method: 'CASH', reason: 'Card machine down' },
      h.gm,
    );
    expect(first.status).toBe(201);
    expect(first.body).toMatchObject({ baseAmountMinor: '-3000000', balanceMinor: '10325000' });
    // Another method that isn't cash needs its own reference.
    const noRef = await h.refund(
      paid.paymentId,
      { amountMinor: '100', method: 'CASH', reason: 'x' },
      h.gm,
    );
    expect(noRef.status).toBe(201);

    const tooMuch = await h.refund(paid.paymentId, { amountMinor: '2000000', reason: 'x' }, h.gm);
    expect(errorOf(tooMuch).details).toMatchObject({ issues: [{ path: 'body.amountMinor' }] });
    const refundId = (first.body as Refunded).refundId;
    const ofRefund = await h.refund(refundId, { amountMinor: '1', reason: 'x' }, h.gm);
    expect(errorOf(ofRefund)).toMatchObject({
      code: 'STATE_TRANSITION_INVALID',
      details: { reason: 'IS_REFUND' },
    });
    expect((await h.refund(paid.paymentId, { amountMinor: '1', reason: 'x' }, h.fd)).status).toBe(
      403,
    );
    await expect(
      db.payment.update({ where: { id: refundId }, data: { note: 'x' } }),
    ).rejects.toThrow();

    // Once the folio is settled nothing comes off it.
    await db.folio.update({ where: { id: h.folioId }, data: { status: 'SETTLED' } });
    const settled = await h.refund(paid.paymentId, { amountMinor: '1', reason: 'x' }, h.gm);
    expect(errorOf(settled).code).toBe('STATE_TRANSITION_INVALID');
  });

  it('refunds a deposit out of the booking’s ledger, but not once it is on the bill', async () => {
    const h = await hotel({ checkIn: false });
    const dep = await h.ok<Captured>(
      h.fd.send('/payments', {
        reservationId: h.reservationId,
        method: 'CASH',
        amountMinor: '5000000',
      }),
    );
    await h.ok(h.gm.send('/shifts', { floatMinor: '0' }));
    const back = await h.refund(
      dep.paymentId,
      { amountMinor: '2000000', reason: 'Guest cut the stay' },
      h.gm,
    );
    expect(back.status).toBe(201);
    expect(back.body).toMatchObject({ balanceMinor: '3000000' });
    const ledger = await h.ok<{
      deposit: {
        heldMinor: string;
        entries: { kind: string; amountMinor: string; refundableMinor: string }[];
      };
    }>(h.fd.get(`/reservations/${h.reservationId}`));
    expect(ledger.deposit).toMatchObject({
      heldMinor: '3000000',
      entries: [
        { kind: 'RECEIVED', amountMinor: '5000000', refundableMinor: '3000000' },
        { kind: 'REFUNDED', amountMinor: '-2000000', refundableMinor: '0' },
      ],
    });

    await h.checkIn(); // the ₦30,000 left moves to the folio
    const late = await h.refund(dep.paymentId, { amountMinor: '100', reason: 'x' }, h.gm);
    expect(errorOf(late)).toMatchObject({ details: { reason: 'DEPOSIT_APPLIED' } });
  });

  it('pays dollars back at today’s rate; the difference goes to the FX code (M4 rule 6)', async () => {
    const h = await hotel();
    await h.ok(
      h.fin.put(`/exchange-rates/${TODAY}`, { rates: [{ currency: 'USD', rate: '1580.5' }] }),
    );
    const paid = await h.pay({ amountMinor: '5000', currency: 'USD' }); // ₦79,025.00
    await h.ok(
      h.fin.put('/exchange-rates/2026-11-11', { rates: [{ currency: 'USD', rate: '1600' }] }),
    );

    now = new Date('2026-11-11T09:00:00Z');
    await catchUpBusinessDay(db, h.p1.id, now);
    const gmUser = await db.membership.findFirstOrThrow({ where: { roleId: h.role('gm') } });
    const gm = await h.as(gmUser.userId);
    await h.ok(gm.send('/shifts', { floatMinor: '0' }));
    const back = await h.ok<Refunded>(
      gm.send(`/payments/${paid.paymentId}/refund`, {
        amountMinor: '5000',
        reason: 'Paid by company',
      }),
    );
    // US$50 now costs ₦80,000; the folio sees ₦79,025 come off its payments and ₦975 of loss.
    expect(back.baseAmountMinor).toBe('-8000000');
    const fx = await db.folioLine.findFirstOrThrow({ where: { sourceType: 'FX' } });
    expect(fx).toMatchObject({ amountMinor: -97500n, kind: 'CHARGE', sourceId: back.refundId });
    expect(back.balanceMinor).toBe('12325000');

    // The exchange line is the system's: not reversed by hand.
    const reverse = await gm.send(`/folio-lines/${fx.id}/reverse`, { reason: 'x' });
    expect(errorOf(reverse).code).toBe('STATE_TRANSITION_INVALID');
  });
});
