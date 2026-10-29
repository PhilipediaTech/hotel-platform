import { randomUUID } from 'node:crypto';
import type { Response } from 'superagent';
import { beforeEach, describe, expect, it } from 'vitest';
import { resetDb, testDb } from '../../../test/db.ts';
import { errorOf } from '../../../test/helpers.ts';
import { inHouse } from '../../../test/in-house.ts';

// Advance deposits (PRD M4-13 "a deposit taken before arrival sits in the advance-deposit
// ledger and moves to the folio at check-in"; M4 rules 1 and 4; tab 3
// `deposit_ledger_entries`; T-063).

const db = testDb();
let now: Date;
const clock = () => new Date(now);

beforeEach(async () => {
  await resetDb(db);
  now = new Date('2026-11-10T09:00:00Z');
});

const binary = (res: Response, done: (err: Error | null, body: Buffer) => void) => {
  const chunks: Buffer[] = [];
  res.on('data', (c: Buffer) => chunks.push(c));
  res.on('end', () => done(null, Buffer.concat(chunks)));
};

type Deposit = {
  heldMinor: string;
  receivedMinor: string;
  entries: {
    kind: string;
    amountMinor: string;
    method: string | null;
    externalRef: string | null;
  }[];
};
type Arrival = { reservationId: string; depositDueMinor: string; flags: string[] };

/** Ada Obi booked for two nights from today on a deposit guarantee (due: the first night,
 * ₦100,000), not checked in; cash and POS switched on; the front desk's shift open. */
async function booked() {
  const h = await inHouse(db, clock, { guarantee: 'DEPOSIT', checkIn: false });
  await db.property.update({
    where: { id: h.p1.id },
    data: { settings: { paymentMethods: ['CASH', 'POS_TERMINAL'] } },
  });
  const shift = await h.ok<{ shift: { id: string } }>(
    h.fd.send('/shifts', { floatMinor: '2000000' }),
  );
  const deposit = (body: object, as = h.fd) =>
    as.send('/payments', { reservationId: h.reservationId, ...body });
  const ledger = async () =>
    (await h.ok<{ deposit: Deposit }>(h.fd.get(`/reservations/${h.reservationId}`))).deposit;
  const arrival = async () =>
    (await h.ok<{ data: Arrival[] }>(h.fd.get('/front-desk/arrivals'))).data.find(
      (a) => a.reservationId === h.reservationId,
    );
  return { ...h, shiftId: shift.shift.id, deposit, ledger, arrival };
}

describe('Taking a deposit before arrival (M4-13)', () => {
  it('holds it in the booking’s ledger until the deposit due is covered', async () => {
    const h = await booked();
    expect(await h.arrival()).toMatchObject({ depositDueMinor: '10000000' });
    expect((await h.arrival())?.flags).toContain('DEPOSIT_DUE');

    const cash = await h.deposit({ method: 'CASH', amountMinor: '4000000', note: 'Half now' });
    expect(cash.status).toBe(201);
    expect(cash.body).toMatchObject({ shiftId: h.shiftId, balanceMinor: '4000000' });
    expect((await h.arrival())?.flags).toContain('DEPOSIT_DUE');

    now = new Date('2026-11-10T09:05:00Z');
    const pos = await h.ok<{ paymentId: string; balanceMinor: string }>(
      h.deposit({ method: 'POS_TERMINAL', amountMinor: '6000000', externalRef: 'MPT-5001' }),
    );
    expect(pos.balanceMinor).toBe('10000000');
    const arrival = await h.arrival();
    expect(arrival?.flags).not.toContain('DEPOSIT_DUE');
    expect(arrival?.depositDueMinor).toBe('0');

    expect(await h.ledger()).toMatchObject({
      heldMinor: '10000000',
      receivedMinor: '10000000',
      entries: [
        { kind: 'RECEIVED', amountMinor: '4000000', method: 'CASH', externalRef: null },
        {
          kind: 'RECEIVED',
          amountMinor: '6000000',
          method: 'POS_TERMINAL',
          externalRef: 'MPT-5001',
        },
      ],
    });
    const payment = await db.payment.findUniqueOrThrow({ where: { id: pos.paymentId } });
    expect(payment).toMatchObject({
      folioId: null,
      windowId: null,
      reservationId: h.reservationId,
    });
    expect(await db.auditEvent.count({ where: { action: 'deposit.received' } })).toBe(2);

    // Deposits are taken on the shift like any payment.
    const open = await h.ok<{
      data: { id: string; lines: { method: string; expectedMinor: string }[] }[];
    }>(h.gm.get('/shifts?status=OPEN'));
    expect(open.data[0]?.lines).toEqual([
      expect.objectContaining({ method: 'CASH', expectedMinor: '6000000' }),
      expect.objectContaining({ method: 'POS_TERMINAL', expectedMinor: '6000000' }),
    ]);
  });

  it('moves the whole deposit to the folio at check-in', async () => {
    const h = await booked();
    await h.ok(h.deposit({ method: 'CASH', amountMinor: '10000000' }));
    const folioId = await h.checkIn();

    const folio = await h.ok<{
      balanceMinor: string;
      revenueCodes: { code: string }[];
      windows: {
        lines: {
          id: string;
          kind: string;
          amountMinor: string;
          revenueCode: string;
          description: string;
        }[];
      }[];
    }>(h.fd.get(`/folios/${folioId}`));
    expect(folio.balanceMinor).toBe('-10000000');
    expect(folio.windows[0]?.lines).toMatchObject([
      {
        kind: 'DEPOSIT_APPLY',
        amountMinor: '-10000000',
        revenueCode: 'DEPOSIT',
        description: 'Advance deposit applied',
      },
    ]);
    expect(await h.ledger()).toMatchObject({
      heldMinor: '0',
      receivedMinor: '10000000',
      entries: [{ kind: 'RECEIVED' }, { kind: 'APPLIED', amountMinor: '-10000000' }],
    });
    const line = await db.folioLine.findFirstOrThrow({ where: { kind: 'DEPOSIT_APPLY' } });
    const applied = await db.depositLedgerEntry.findFirstOrThrow({ where: { kind: 'APPLIED' } });
    expect(line).toMatchObject({ sourceType: 'DEPOSIT', sourceId: applied.id });

    // The room charge then leaves what is still to pay.
    const charged = await h.ok<{ balanceMinor: string }>(
      h.charge({ revenueCode: 'ROOM', description: 'Room 101', unitAmountMinor: '10000000' }),
    );
    expect(charged.balanceMinor).toBe('2325000');

    // The deposit code takes no charges and the applied deposit is not reversed by hand.
    expect(folio.revenueCodes.map((c) => c.code)).not.toContain('DEPOSIT');
    const posted = await h.charge({
      revenueCode: 'DEPOSIT',
      description: 'X',
      unitAmountMinor: '100',
    });
    expect(errorOf(posted).details).toMatchObject({ issues: [{ path: 'body.revenueCode' }] });
    const reversed = await h.gm.send(`/folio-lines/${line.id}/reverse`, { reason: 'Try' });
    expect(errorOf(reversed).code).toBe('STATE_TRANSITION_INVALID');

    // The booking is in: further money goes on the folio.
    const late = await h.deposit({ method: 'CASH', amountMinor: '100' });
    expect(errorOf(late)).toMatchObject({ code: 'STATE_TRANSITION_INVALID' });
  });

  it('checks in without a deposit as before', async () => {
    const h = await booked();
    const folioId = await h.checkIn();
    expect(await db.folioLine.count({ where: { folioId } })).toBe(0);
    expect(await db.depositLedgerEntry.count()).toBe(0);
  });

  it('refuses deposits without a shift, on the wrong target, and on cancelled bookings', async () => {
    const h = await booked();
    // The GM has no open shift.
    expect(errorOf(await h.deposit({ method: 'CASH', amountMinor: '100' }, h.gm)).code).toBe(
      'SHIFT_NOT_OPEN',
    );
    const both = await h.fd.send('/payments', {
      reservationId: h.reservationId,
      folioId: randomUUID(),
      method: 'CASH',
      amountMinor: '100',
    });
    expect(errorOf(both).details).toMatchObject({ issues: [{ path: 'body.folioId' }] });
    const neither = await h.fd.send('/payments', { method: 'CASH', amountMinor: '100' });
    expect(neither.status).toBe(400);
    const unknown = await h.fd.send('/payments', {
      reservationId: randomUUID(),
      method: 'CASH',
      amountMinor: '100',
    });
    expect(unknown.status).toBe(404);

    await db.reservation.update({
      where: { id: h.reservationId },
      data: { status: 'CANCELLED', cancelledAt: now, cancelReason: 'Test' },
    });
    expect(errorOf(await h.deposit({ method: 'CASH', amountMinor: '100' })).code).toBe(
      'STATE_TRANSITION_INVALID',
    );
    expect(await db.payment.count()).toBe(0);
  });

  it('keeps the ledger append-only, signed and out of closed days', async () => {
    const h = await booked();
    await h.ok(h.deposit({ method: 'CASH', amountMinor: '100000' }));
    const entry = await db.depositLedgerEntry.findFirstOrThrow();
    await expect(
      db.depositLedgerEntry.update({ where: { id: entry.id }, data: { amountMinor: 1n } }),
    ).rejects.toThrow();
    await expect(db.depositLedgerEntry.delete({ where: { id: entry.id } })).rejects.toThrow();
    await expect(
      db.depositLedgerEntry.create({
        data: {
          propertyId: h.p1.id,
          reservationId: h.reservationId,
          kind: 'APPLIED',
          amountMinor: 100n,
          businessDate: new Date('2026-11-10'),
        },
      }),
    ).rejects.toThrow();
    await db.businessDay.updateMany({ data: { status: 'CLOSED', closedAt: now } });
    expect(errorOf(await h.deposit({ method: 'CASH', amountMinor: '100' })).code).toBe(
      'BUSINESS_DAY_CLOSED',
    );
  });

  it('prints a deposit receipt, and the proforma shows what is left to pay', async () => {
    const h = await booked();
    const paid = await h.ok<{ paymentId: string }>(
      h.deposit({ method: 'CASH', amountMinor: '10000000' }),
    );
    const receipt = await h.fd
      .get(`/reservations/${h.reservationId}/receipt.pdf?paymentId=${paid.paymentId}`)
      .buffer(true)
      .parse(binary);
    expect(receipt.status).toBe(200);
    expect(receipt.headers['content-type']).toBe('application/pdf');
    expect((receipt.body as Buffer).subarray(0, 5).toString()).toBe('%PDF-');
    expect(
      (await h.fd.get(`/reservations/${h.reservationId}/receipt.pdf?paymentId=${randomUUID()}`))
        .status,
    ).toBe(404);

    await h.ok(
      h.fd.get(`/reservations/${h.reservationId}/proforma.pdf`).buffer(true).parse(binary),
    );
    const proforma = await db.auditEvent.findFirstOrThrow({
      where: { action: 'reservation.proforma_issued' },
    });
    expect(proforma.after).toMatchObject({ totalMinor: '24650000', depositHeldMinor: '10000000' });

    // After check-in and the room charge, the invoice counts the deposit against it.
    const folioId = await h.checkIn();
    await h.ok(
      h.charge({ revenueCode: 'ROOM', description: 'Room 101', unitAmountMinor: '10000000' }),
    );
    await h.ok(h.fd.get(`/folios/${folioId}/invoice.pdf`).buffer(true).parse(binary));
    const invoice = await db.auditEvent.findFirstOrThrow({
      where: { action: 'folio.invoice_issued' },
    });
    expect(invoice.after).toMatchObject({ balanceMinor: '2325000' });
  });
});
