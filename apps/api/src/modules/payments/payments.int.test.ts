import { randomUUID } from 'node:crypto';
import type { Response } from 'superagent';
import { beforeEach, describe, expect, it } from 'vitest';
import { resetDb, testDb } from '../../../test/db.ts';
import { errorOf } from '../../../test/helpers.ts';
import { inHouse } from '../../../test/in-house.ts';
import { money } from './documents.ts';

// Manual payments and folio documents (PRD M4-08, the receipt/invoice/proforma story, M4
// rules 1, 4, 5 and the acceptance "a cashier without an open shift cannot record a cash
// payment (SHIFT_NOT_OPEN)"; tab 4 POST /payments example; open issue 19; T-062).

const db = testDb();
let now: Date;
const clock = () => new Date(now);

beforeEach(async () => {
  await resetDb(db);
  now = new Date('2026-11-10T09:00:00Z');
});

type Payment = {
  id: string;
  windowNumber: number;
  method: string;
  amountMinor: string;
  externalRef: string | null;
  businessDate: string;
  receivedBy: string | null;
  note: string | null;
};
type PFolio = {
  balanceMinor: string;
  paymentMethods: string[];
  windows: { number: number; balanceMinor: string; payments: Payment[] }[];
};
/** Collects a file response into a Buffer (supertest has no PDF parser). */
const binary = (res: Response, done: (err: Error | null, body: Buffer) => void) => {
  const chunks: Buffer[] = [];
  res.on('data', (c: Buffer) => chunks.push(c));
  res.on('end', () => done(null, Buffer.concat(chunks)));
};
type Captured = { paymentId: string; shiftId: string; balanceMinor: string };

/** The in-house hotel with cash, transfer and POS switched on, a ₦100,000 room charge
 * (₦123,250 with taxes) and the front desk's shift open with a ₦20,000 float. */
async function desk(options: { openShift?: boolean } = {}) {
  const h = await inHouse(db, clock);
  await db.property.update({
    where: { id: h.p1.id },
    data: { settings: { paymentMethods: ['CASH', 'BANK_TRANSFER', 'POS_TERMINAL'] } },
  });
  await h.ok(
    h.charge({ revenueCode: 'ROOM', description: 'Room 101', unitAmountMinor: '10000000' }),
  );
  let shiftId = '';
  if (options.openShift !== false) {
    const opened = await h.ok<{ shift: { id: string } }>(
      h.fd.send('/shifts', { floatMinor: '2000000' }),
    );
    shiftId = opened.shift.id;
  }
  const pay = (body: object, as = h.fd) => as.send('/payments', { folioId: h.folioId, ...body });
  const folio = async () => h.ok<PFolio>(h.fd.get(`/folios/${h.folioId}`));
  return { ...h, shiftId, pay, folio };
}

describe('money()', () => {
  it.each([
    [12325000n, 'NGN 123,250.00'],
    [483750n, 'NGN 4,837.50'],
    [-200000n, '-NGN 2,000.00'],
    [5n, 'NGN 0.05'],
  ])('%s → %s', (minor, text) => {
    expect(money(minor, 'NGN')).toBe(text);
  });
});

describe('Taking payments (M4-08, M4 rule 4)', () => {
  it('records method, reference and shift, and lowers the balance', async () => {
    const h = await desk();
    const cash = await h.pay({ method: 'CASH', amountMinor: '5000000', note: 'Part payment' });
    expect(cash.status).toBe(201);
    expect(cash.body).toMatchObject({ shiftId: h.shiftId, balanceMinor: '7325000' });

    now = new Date('2026-11-10T09:05:00Z');
    // The tab 4 example: a POS payment with its slip number.
    const pos = await h.ok<Captured>(
      h.pay({
        windowNumber: 1,
        method: 'POS_TERMINAL',
        amountMinor: '7325000',
        currency: 'NGN',
        externalRef: 'MPT-77812',
      }),
    );
    expect(pos.balanceMinor).toBe('0');

    const folio = await h.folio();
    expect(folio.balanceMinor).toBe('0');
    expect(folio.paymentMethods).toEqual(['CASH', 'BANK_TRANSFER', 'POS_TERMINAL']);
    expect(folio.windows[0]).toMatchObject({
      balanceMinor: '0',
      payments: [
        {
          method: 'CASH',
          amountMinor: '5000000',
          externalRef: null,
          note: 'Part payment',
          businessDate: '2026-11-10',
        },
        { method: 'POS_TERMINAL', amountMinor: '7325000', externalRef: 'MPT-77812' },
      ],
    });
    const row = await db.payment.findUniqueOrThrow({ where: { id: pos.paymentId } });
    expect(row).toMatchObject({
      provider: 'MANUAL',
      shiftId: h.shiftId,
      receivedById: h.fdId,
      baseAmountMinor: 7325000n,
      currency: 'NGN',
    });
    expect(await db.auditEvent.count({ where: { action: 'payment.captured' } })).toBe(2);
    expect(await db.domainEvent.count({ where: { type: 'payment.captured' } })).toBe(2);

    // The front desk list shows the folio balance after payments.
    const inHouseList = await h.ok<{ data: { balanceMinor: string | null }[] }>(
      h.fd.get('/front-desk/in-house'),
    );
    expect(inHouseList.data[0]?.balanceMinor).toBe('0');
  });

  it('refuses a payment without an open shift (SHIFT_NOT_OPEN)', async () => {
    const h = await desk({ openShift: false });
    const res = await h.pay({ method: 'CASH', amountMinor: '100000' });
    expect(res.status).toBe(409);
    expect(errorOf(res).code).toBe('SHIFT_NOT_OPEN');
    // A counted shift waiting for sign-off is not open either.
    const shift = await h.ok<{ shift: { id: string } }>(h.fd.send('/shifts', { floatMinor: '0' }));
    await h.ok(
      h.fd.send(`/shifts/${shift.shift.id}/close`, {
        counts: [{ method: 'CASH', currency: 'NGN', countedMinor: '0' }],
      }),
    );
    expect(errorOf(await h.pay({ method: 'CASH', amountMinor: '100000' })).code).toBe(
      'SHIFT_NOT_OPEN',
    );
    expect(await db.payment.count()).toBe(0);
  });

  it('refuses a reference used twice for the same method (PAYMENT_DUPLICATE, open issue 19)', async () => {
    const h = await desk();
    await h.ok(h.pay({ method: 'POS_TERMINAL', amountMinor: '100000', externalRef: 'MPT-1' }));
    const again = await h.pay({
      method: 'POS_TERMINAL',
      amountMinor: '100000',
      externalRef: 'MPT-1',
    });
    expect(again.status).toBe(409);
    expect(errorOf(again).code).toBe('PAYMENT_DUPLICATE');
    // Another method's reference space is separate; cash needs no reference.
    await h.ok(h.pay({ method: 'BANK_TRANSFER', amountMinor: '100000', externalRef: 'MPT-1' }));
    await h.ok(h.pay({ method: 'CASH', amountMinor: '100000' }));
    await h.ok(h.pay({ method: 'CASH', amountMinor: '100000' }));
    expect(await db.payment.count()).toBe(4);
  });

  it('replays an Idempotency-Key instead of taking the payment twice', async () => {
    const h = await desk();
    const key = randomUUID();
    const send = () =>
      h.fd
        .post('/payments', { folioId: h.folioId, method: 'CASH', amountMinor: '100000' })
        .set('Idempotency-Key', key);
    const [a, b] = [await send(), await send()];
    expect(b.body).toEqual(a.body);
    expect(await db.payment.count()).toBe(1);
  });

  it('validates the method, reference, currency, window and folio', async () => {
    const h = await desk();
    const path = async (body: object) =>
      (errorOf(await h.pay(body)).details as { issues: { path: string }[] }).issues[0]?.path;
    expect(await path({ method: 'POS_TERMINAL', amountMinor: '100' })).toBe('body.externalRef');
    expect(await path({ method: 'VOUCHER', amountMinor: '100', externalRef: 'V1' })).toBe(
      'body.method',
    );
    expect(await path({ method: 'CASH', amountMinor: '100', currency: 'USD' })).toBe(
      'body.currency',
    );
    expect(await path({ method: 'CASH', amountMinor: '100', windowNumber: 2 })).toBe(
      'body.windowNumber',
    );
    expect(await path({ method: 'CASH', amountMinor: '0' })).toBe('body.amountMinor');
    // The GM has no open shift.
    expect(errorOf(await h.pay({ method: 'CASH', amountMinor: '100' }, h.gm)).code).toBe(
      'SHIFT_NOT_OPEN',
    );

    await db.folio.update({ where: { id: h.folioId }, data: { status: 'SETTLED' } });
    expect(errorOf(await h.pay({ method: 'CASH', amountMinor: '100' })).code).toBe(
      'STATE_TRANSITION_INVALID',
    );
  });

  it('keeps payments append-only and out of closed days', async () => {
    const h = await desk();
    const p = await h.ok<Captured>(h.pay({ method: 'CASH', amountMinor: '100000' }));
    await expect(
      db.payment.update({
        where: { id: p.paymentId },
        data: { amountMinor: 1n, baseAmountMinor: 1n },
      }),
    ).rejects.toThrow();
    await expect(db.payment.delete({ where: { id: p.paymentId } })).rejects.toThrow();
    await db.businessDay.updateMany({ data: { status: 'CLOSED', closedAt: now } });
    expect(errorOf(await h.pay({ method: 'CASH', amountMinor: '100' })).code).toBe(
      'BUSINESS_DAY_CLOSED',
    );
  });
});

describe('Payments on the shift (M4-10, M4-11)', () => {
  it('counts payments on the cashier’s view and in the expected amounts at close', async () => {
    const h = await desk();
    await h.ok(h.pay({ method: 'CASH', amountMinor: '5000000' }));
    await h.ok(h.pay({ method: 'POS_TERMINAL', amountMinor: '483750', externalRef: 'MPT-77812' }));
    const current = await h.ok<{ shift: { paymentCounts: { method: string; count: number }[] } }>(
      h.fd.get('/shifts/current'),
    );
    expect(current.shift.paymentCounts).toEqual([
      { method: 'CASH', count: 1 },
      { method: 'POS_TERMINAL', count: 1 },
    ]);
    // Still blind: no amounts expected on the cashier's view.
    expect(JSON.stringify(current)).not.toContain('expected');

    const closed = await h.ok<{
      status: string;
      lines: { method: string; expectedMinor: string; varianceMinor: string }[];
    }>(
      h.fd.send(`/shifts/${h.shiftId}/close`, {
        counts: [
          { method: 'CASH', currency: 'NGN', countedMinor: '7000000' },
          { method: 'POS_TERMINAL', currency: 'NGN', countedMinor: '483750' },
        ],
      }),
    );
    expect(closed.status).toBe('CLOSED');
    expect(closed.lines).toEqual([
      expect.objectContaining({ method: 'CASH', expectedMinor: '7000000', varianceMinor: '0' }),
      expect.objectContaining({
        method: 'POS_TERMINAL',
        expectedMinor: '483750',
        varianceMinor: '0',
      }),
    ]);
    // After the close, the next payment needs a new shift.
    expect(errorOf(await h.pay({ method: 'CASH', amountMinor: '100' })).code).toBe(
      'SHIFT_NOT_OPEN',
    );
  });
});

describe('Receipts, invoices and proformas (PDF)', () => {
  it('prints the invoice of the folio or one window, and a receipt per payment', async () => {
    const h = await desk();
    const p = await h.ok<Captured>(h.pay({ method: 'CASH', amountMinor: '5000000' }));

    const invoice = await h.fd.get(`/folios/${h.folioId}/invoice.pdf`).buffer(true).parse(binary);
    expect(invoice.status).toBe(200);
    expect(invoice.headers['content-type']).toBe('application/pdf');
    expect(invoice.headers['content-disposition']).toBe('inline; filename="invoice-F00001.pdf"');
    expect(invoice.headers['cache-control']).toBe('no-store');
    expect((invoice.body as Buffer).subarray(0, 5).toString()).toBe('%PDF-');
    const issued = await db.auditEvent.findFirstOrThrow({
      where: { action: 'folio.invoice_issued' },
    });
    expect(issued.after).toMatchObject({ number: 'F00001', balanceMinor: '7325000' });

    expect((await h.fd.get(`/folios/${h.folioId}/invoice.pdf?window=1`)).status).toBe(200);
    expect((await h.fd.get(`/folios/${h.folioId}/invoice.pdf?window=3`)).status).toBe(400);

    const receipt = await h.fd
      .get(`/folios/${h.folioId}/receipt.pdf?paymentId=${p.paymentId}`)
      .buffer(true)
      .parse(binary);
    expect(receipt.status).toBe(200);
    expect(receipt.headers['content-disposition']).toBe(
      `inline; filename="receipt-${p.paymentId.slice(0, 8).toUpperCase()}.pdf"`,
    );
    expect(await db.auditEvent.count({ where: { action: 'payment.receipt_issued' } })).toBe(1);
    expect(
      (await h.fd.get(`/folios/${h.folioId}/receipt.pdf?paymentId=${randomUUID()}`)).status,
    ).toBe(404);
  });

  it('prints a proforma from the booking’s quotes, and needs folio.invoice', async () => {
    const h = await desk();
    const res = await h.fd
      .get(`/reservations/${h.reservationId}/proforma.pdf`)
      .buffer(true)
      .parse(binary);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('application/pdf');
    const issued = await db.auditEvent.findFirstOrThrow({
      where: { action: 'reservation.proforma_issued' },
    });
    // Two nights at ₦100,000 with the Lagos taxes: 2 × ₦123,250.
    expect(issued.after).toMatchObject({ totalMinor: '24650000' });

    const reservations = await h.person('reservations', h.p1.id);
    const agent = await h.as(reservations.id);
    expect((await agent.get(`/reservations/${h.reservationId}/proforma.pdf`)).status).toBe(403);
  });
});
