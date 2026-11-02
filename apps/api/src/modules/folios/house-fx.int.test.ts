import { beforeEach, describe, expect, it } from 'vitest';
import { resetDb, testDb } from '../../../test/db.ts';
import { errorOf } from '../../../test/helpers.ts';
import { inHouse, TODAY } from '../../../test/in-house.ts';

// House and paymaster accounts (PRD M4-20), folio transfers (tab 4 POST /folios/{id}/transfer;
// M1 rule 2 "folio transfer between guests" needs approval), exchange rates (M4-18) and
// foreign-currency payments (M4 rule 6; tab 4 POST /payments note on USD); T-065.

const db = testDb();
let now: Date;
const clock = () => new Date(now);

beforeEach(async () => {
  await resetDb(db);
  now = new Date('2026-11-10T09:00:00Z');
});

type Folio = {
  id: string;
  number: string;
  kind: string;
  name: string;
  balanceMinor: string;
  windows: {
    number: number;
    payerType: string;
    payerName: string;
    balanceMinor: string;
    lines: { kind: string; amountMinor: string; description: string }[];
    payments: {
      amountMinor: string;
      currency: string;
      baseAmountMinor: string;
      rate: string | null;
    }[];
  }[];
};

/** The in-house hotel (Ada Obi, ₦123,250 room charge), finance signed in, cash switched on
 * and the front desk's shift open. */
async function hotel() {
  const h = await inHouse(db, clock);
  await db.property.update({
    where: { id: h.p1.id },
    data: { settings: { paymentMethods: ['CASH', 'POS_TERMINAL'] } },
  });
  await h.ok(
    h.charge({ revenueCode: 'ROOM', description: 'Room 101', unitAmountMinor: '10000000' }),
  );
  await h.ok(h.fd.send('/shifts', { floatMinor: '0' }));
  const fin = await h.as(h.finance.id);
  const folioOf = (id: string, as = h.gm) => h.ok<Folio>(as.get(`/folios/${id}`));
  return { ...h, fin, folioOf };
}

describe('House and paymaster accounts (M4-20)', () => {
  it('opens them for holders of folio.house, who alone post to them', async () => {
    const h = await hotel();
    const house = await h.fin.send('/folios', { kind: 'HOUSE', name: 'Staff meals' });
    expect(house.status).toBe(201);
    expect(house.body).toMatchObject({
      number: 'F00002',
      kind: 'HOUSE',
      name: 'Staff meals',
      stay: null,
      windows: [{ number: 1, payerType: 'GUEST', payerName: 'Staff meals' }],
    });
    const houseId = (house.body as Folio).id;

    const paymaster = await h.ok<Folio>(
      h.fin.send('/folios', {
        kind: 'PAYMASTER',
        name: 'Dangote retreat',
        companyId: h.company.id,
      }),
    );
    expect(paymaster.windows[0]).toMatchObject({
      payerType: 'COMPANY',
      payerName: 'Dangote Group',
    });
    const auditor = await h.as((await h.person('night-auditor', h.p1.id)).id);
    expect((await auditor.send('/folios', { kind: 'HOUSE', name: 'X' })).status).toBe(403);
    const guestCompany = await h.fin.send('/folios', {
      kind: 'HOUSE',
      name: 'X',
      companyId: h.company.id,
    });
    expect(guestCompany.status).toBe(400);

    // The front desk posts to the house account (M4-20); the night auditor (no folio.house) can't.
    await h.ok(
      h.fd.send(`/folios/${houseId}/lines`, {
        revenueCode: 'FNB',
        description: 'Staff lunch',
        unitAmountMinor: '500000',
      }),
    );
    const refused = await auditor.send(`/folios/${houseId}/lines`, {
      revenueCode: 'FNB',
      description: 'Staff lunch',
      unitAmountMinor: '500000',
    });
    expect(refused.status).toBe(403);
    const pay = await auditor.send('/payments', {
      folioId: houseId,
      method: 'CASH',
      amountMinor: '100',
    });
    expect(pay.status).toBe(403);

    const list = await h.ok<{ data: { id: string; kind: string }[] }>(
      h.fin.get('/folios?kind=HOUSE'),
    );
    expect(list.data.map((f) => [f.id, f.kind])).toEqual([[houseId, 'HOUSE']]);
    const all = await h.ok<{ data: { kind: string }[] }>(h.fin.get('/folios'));
    expect(all.data.map((f) => f.kind).sort()).toEqual(['GUEST', 'HOUSE', 'PAYMASTER']);
  });
});

describe('Transfers', () => {
  it('moves an amount between windows of a folio without approval', async () => {
    const h = await hotel();
    await h.ok(
      h.fd.post(`/folios/${h.folioId}/windows`, { payerType: 'COMPANY', companyId: h.company.id }),
    );
    const moved = await h.fd.send(`/folios/${h.folioId}/transfer`, {
      fromWindow: 1,
      toFolioId: h.folioId,
      toWindow: 2,
      amountMinor: '10000000',
      reason: 'Company pays the room',
    });
    expect(moved.status).toBe(201);
    expect(moved.body).toMatchObject({ balanceMinor: '12325000' });
    const folio = await h.folioOf(h.folioId);
    expect(folio.windows.map((w) => w.balanceMinor)).toEqual(['2325000', '10000000']);
    expect(folio.windows[0]?.lines.find((l) => l.kind === 'TRANSFER_OUT')).toMatchObject({
      kind: 'TRANSFER_OUT',
      amountMinor: '-10000000',
      description: 'Transferred to F00001, window 2',
    });
    expect(folio.windows[1]?.lines).toMatchObject([
      {
        kind: 'TRANSFER_IN',
        amountMinor: '10000000',
        description: 'Transferred from F00001, window 1',
      },
    ]);
    const audit = await db.auditEvent.findFirstOrThrow({ where: { action: 'folio.transferred' } });
    expect(audit.reason).toBe('Company pays the room');

    // Not more than the window owes; not to itself; the transfer code takes no charges.
    const tooMuch = await h.fd.send(`/folios/${h.folioId}/transfer`, {
      fromWindow: 1,
      toFolioId: h.folioId,
      toWindow: 2,
      amountMinor: '2325001',
      reason: 'x',
    });
    expect(errorOf(tooMuch).details).toMatchObject({ issues: [{ path: 'body.amountMinor' }] });
    const same = await h.fd.send(`/folios/${h.folioId}/transfer`, {
      fromWindow: 1,
      toFolioId: h.folioId,
      toWindow: 1,
      amountMinor: '1',
      reason: 'x',
    });
    expect(errorOf(same).details).toMatchObject({ issues: [{ path: 'body.toWindow' }] });
    const code = await h.charge({
      revenueCode: 'TRANSFER',
      description: 'x',
      unitAmountMinor: '1',
    });
    expect(errorOf(code).details).toMatchObject({ issues: [{ path: 'body.revenueCode' }] });
    await expect(
      db.folioLine.updateMany({ where: { kind: 'TRANSFER_IN' }, data: { reason: 'x' } }),
    ).rejects.toThrow();
  });

  it('to another folio: a manager approves the front desk’s transfer, or makes it directly', async () => {
    const h = await hotel();
    const paymaster = await h.ok<Folio>(
      h.fin.send('/folios', {
        kind: 'PAYMASTER',
        name: 'Dangote retreat',
        companyId: h.company.id,
      }),
    );
    // Without folio.house the paymaster account is out of reach.
    const auditor = await h.as((await h.person('night-auditor', h.p1.id)).id);
    await db.role.update({
      where: { id: h.role('night-auditor') },
      data: { permissions: { push: 'folio.route' } },
    });
    const asked = await auditor.send(`/folios/${h.folioId}/transfer`, {
      fromWindow: 1,
      toFolioId: paymaster.id,
      amountMinor: '12325000',
      reason: 'Retreat pays all',
    });
    expect(asked.status).toBe(403);

    const pending = await h.fd.send(`/folios/${h.folioId}/transfer`, {
      fromWindow: 1,
      toFolioId: paymaster.id,
      amountMinor: '12325000',
      reason: 'Retreat pays all',
    });
    expect(pending.status).toBe(202);
    expect(await db.folioLine.count({ where: { kind: 'TRANSFER_IN' } })).toBe(0);
    const requestId = (pending.body as { approvalRequestId: string }).approvalRequestId;
    await h.ok(h.gm.post(`/approvals/${requestId}/approve`, {}));
    expect((await h.folioOf(h.folioId)).balanceMinor).toBe('0');
    expect((await h.folioOf(paymaster.id)).balanceMinor).toBe('12325000');

    // A manager moves it back directly.
    const back = await h.gm.send(`/folios/${paymaster.id}/transfer`, {
      fromWindow: 1,
      toFolioId: h.folioId,
      amountMinor: '325000',
      reason: 'Guest pays the extras',
    });
    expect(back.status).toBe(201);
    expect((await h.folioOf(h.folioId)).balanceMinor).toBe('325000');

    // Never to or from a settled folio.
    await db.folio.update({ where: { id: paymaster.id }, data: { status: 'SETTLED' } });
    const closed = await h.gm.send(`/folios/${h.folioId}/transfer`, {
      fromWindow: 1,
      toFolioId: paymaster.id,
      amountMinor: '1',
      reason: 'x',
    });
    expect(errorOf(closed).code).toBe('STATE_TRANSITION_INVALID');
  });
});

describe('Exchange rates (M4-18) and USD payments (M4 rule 6)', () => {
  it('finance sets the day’s rates; they carry forward and lock', async () => {
    const h = await hotel();
    const set = await h.fin.put(`/exchange-rates/${TODAY}`, {
      rates: [
        { currency: 'USD', rate: '1580.5' },
        { currency: 'GBP', rate: '2010' },
      ],
    });
    expect(set.status).toBe(200);
    expect(set.body).toMatchObject({
      date: TODAY,
      baseCurrency: 'NGN',
      rates: [
        { currency: 'GBP', rate: '2010', setFor: TODAY },
        { currency: 'USD', rate: '1580.5', setFor: TODAY, lockedAt: null },
      ],
    });
    // Tomorrow has no rate of its own: today's carries forward.
    const tomorrow = await h.ok<{ rates: { currency: string; setFor: string }[] }>(
      h.fd.get('/exchange-rates/2026-11-11'),
    );
    expect(tomorrow.rates.find((r) => r.currency === 'USD')?.setFor).toBe(TODAY);

    expect(
      (await h.fd.put(`/exchange-rates/${TODAY}`, { rates: [{ currency: 'USD', rate: '1' }] }))
        .status,
    ).toBe(403);
    const past = await h.fin.put('/exchange-rates/2026-11-09', {
      rates: [{ currency: 'USD', rate: '1' }],
    });
    expect(errorOf(past).code).toBe('STATE_TRANSITION_INVALID');
    const base = await h.fin.put(`/exchange-rates/${TODAY}`, {
      rates: [{ currency: 'NGN', rate: '1' }],
    });
    expect(errorOf(base).details).toMatchObject({ issues: [{ path: 'body.rates.0.currency' }] });
    expect(
      (await h.fin.put(`/exchange-rates/${TODAY}`, { rates: [{ currency: 'USD', rate: '0' }] }))
        .status,
    ).toBe(400);

    // Night audit locks the day (T-073): a locked rate never changes.
    await db.exchangeRate.updateMany({ where: { currency: 'USD' }, data: { lockedAt: now } });
    const locked = await h.fin.put(`/exchange-rates/${TODAY}`, {
      rates: [{ currency: 'USD', rate: '1600' }],
    });
    expect(errorOf(locked).code).toBe('STATE_TRANSITION_INVALID');
  });

  it('takes USD at the day’s rate: amount, rate and base value on the folio and the shift', async () => {
    const h = await hotel();
    const noRate = await h.fd.send('/payments', {
      folioId: h.folioId,
      method: 'CASH',
      amountMinor: '5000',
      currency: 'USD',
    });
    expect(errorOf(noRate).details).toMatchObject({ issues: [{ path: 'body.currency' }] });

    await h.ok(
      h.fin.put(`/exchange-rates/${TODAY}`, { rates: [{ currency: 'USD', rate: '1580.5' }] }),
    );
    const paid = await h.fd.send('/payments', {
      folioId: h.folioId,
      method: 'CASH',
      amountMinor: '5000',
      currency: 'USD',
    });
    expect(paid.status).toBe(201);
    // US$50.00 × 1,580.5 = ₦79,025.00, off the ₦123,250.00 bill.
    expect(paid.body).toMatchObject({ baseAmountMinor: '7902500', balanceMinor: '4422500' });
    const folio = await h.folioOf(h.folioId);
    expect(folio.windows[0]?.payments).toMatchObject([
      { amountMinor: '5000', currency: 'USD', baseAmountMinor: '7902500', rate: '1580.5' },
    ]);
    const row = await db.payment.findFirstOrThrow();
    expect(row).toMatchObject({ rateMicros: 1580500000n, baseAmountMinor: 7902500n });

    // The cashier counts the dollars as dollars.
    const current = await h.ok<{ shift: { id: string; paymentCounts: unknown[] } }>(
      h.fd.get('/shifts/current'),
    );
    expect(current.shift.paymentCounts).toEqual([{ method: 'CASH', currency: 'USD', count: 1 }]);
    const closed = await h.ok<{
      lines: { method: string; currency: string; expectedMinor: string }[];
    }>(
      h.fd.send(`/shifts/${current.shift.id}/close`, {
        counts: [
          { method: 'CASH', currency: 'NGN', countedMinor: '0' },
          { method: 'CASH', currency: 'USD', countedMinor: '5000' },
        ],
      }),
    );
    expect(closed.lines).toEqual([
      expect.objectContaining({ method: 'CASH', currency: 'NGN', expectedMinor: '0' }),
      expect.objectContaining({ method: 'CASH', currency: 'USD', expectedMinor: '5000' }),
    ]);
  });
});
