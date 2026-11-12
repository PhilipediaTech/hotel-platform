import { beforeEach, describe, expect, it } from 'vitest';
import { resetDb, testDb } from '../../../test/db.ts';
import { errorOf } from '../../../test/helpers.ts';
import { inHouse, type Posted } from '../../../test/in-house.ts';

// Travel-agent commissions (PRD M4-22 "As finance, I calculate and settle travel-agent
// commissions", ar.commission; tab 3 commissions DUE | PAID | OFFSET; T-127).

const db = testDb();
let now: Date;
const clock = () => new Date(now);

beforeEach(async () => {
  await resetDb(db);
  now = new Date('2026-11-10T09:00:00Z');
});

type Commission = {
  id: string;
  agent: { id: string; name: string };
  stay: { id: string; confirmationNo: string; guestName: string };
  checkedOutOn: string;
  baseMinor: string;
  rateBps: number;
  amountMinor: string;
  status: string;
  settledOn: string | null;
  reference: string | null;
};
type Calculated = { created: number; updated: number; data: Commission[] };

/** Ada Obi booked through Dangote Group, made a travel agent on 10% unless told otherwise. */
async function hotel(agent: { kind?: 'TRAVEL_AGENT' | 'COMPANY'; bps?: number | null } = {}) {
  const h = await inHouse(db, clock);
  await db.company.update({
    where: { id: h.company.id },
    data: {
      kind: agent.kind ?? 'TRAVEL_AGENT',
      commissionBps: agent.bps === undefined ? 1000 : agent.bps,
    },
  });
  // ₦100,000 room, plus ₦20,000 of drinks that earn no commission.
  const room = await h.ok<Posted>(
    h.charge({ revenueCode: 'ROOM', description: 'Room 101', unitAmountMinor: '10000000' }),
  );
  await h.ok(h.charge({ revenueCode: 'FNB', description: 'Bar', unitAmountMinor: '2000000' }));
  const roomLineId = room.lines.find((l) => l.kind === 'CHARGE')?.id ?? '';
  const fin = await h.as(h.finance.id);
  const checkOut = async (at = now) => {
    await db.stay.update({
      where: { id: h.stayId },
      data: { status: 'CHECKED_OUT', checkedOutAt: at },
    });
  };
  const calculate = (from = '2026-11-01', to = '2026-11-10', as = fin) =>
    as.send('/commissions/calculate', { from, to });
  const list = (query = '') =>
    h.ok<{ data: Commission[]; dueMinor: string }>(fin.get(`/commissions${query}`));
  return { ...h, fin, roomLineId, checkOut, calculate, list };
}

describe('calculating (M4-22)', () => {
  it('earns the agent’s rate on room revenue net of tax, once per stay', async () => {
    const h = await hotel();
    await h.checkOut();
    const first = await h.ok<Calculated>(h.calculate());
    expect(first.created).toBe(1);
    expect(first.data[0]).toMatchObject({
      agent: { id: h.company.id, name: 'Dangote Group' },
      stay: { id: h.stayId, guestName: 'Ada Obi' },
      checkedOutOn: '2026-11-10',
      baseMinor: '10000000',
      rateBps: 1000,
      amountMinor: '1000000',
      status: 'DUE',
      settledOn: null,
    });
    const again = await h.ok<Calculated>(h.calculate());
    expect(again).toMatchObject({ created: 0, updated: 0, data: [] });
    expect(await db.commission.count()).toBe(1);
    expect(await h.list()).toMatchObject({ dueMinor: '1000000' });
  });

  it('counts discounts and reversals on the room, and brings a due commission up to date', async () => {
    const h = await hotel();
    await h.ok(
      h.gm.send(`/folios/${h.folioId}/discounts`, {
        lineId: h.roomLineId,
        percent: 10,
        reason: 'Agent rate',
      }),
    );
    await h.checkOut();
    const first = await h.ok<Calculated>(h.calculate());
    expect(first.data[0]).toMatchObject({ baseMinor: '9000000', amountMinor: '900000' });

    // A late reversal of the room: the due commission follows it.
    await h.ok(h.gm.send(`/folio-lines/${h.roomLineId}/reverse`, { reason: 'Billed in error' }));
    const after = await h.ok<Calculated>(h.calculate());
    expect(after).toMatchObject({ created: 0, updated: 1 });
    expect(after.data[0]).toMatchObject({ baseMinor: '0', amountMinor: '0', status: 'DUE' });
  });

  it('skips stays not checked out, outside the period, not through an agent, or with no rate', async () => {
    const h = await hotel();
    // Still in house.
    expect((await h.ok<Calculated>(h.calculate())).created).toBe(0);
    // Checked out before the period (late on 31 October, Lagos time).
    await h.checkOut(new Date('2026-10-31T22:30:00Z'));
    expect((await h.ok<Calculated>(h.calculate())).created).toBe(0);
    // 23:30 UTC on 31 October is 1 November in Lagos: in the period.
    await h.checkOut(new Date('2026-10-31T23:30:00Z'));
    const lagos = await h.ok<Calculated>(h.calculate());
    expect(lagos.data[0]?.checkedOutOn).toBe('2026-11-01');

    for (const agent of [{ kind: 'COMPANY' as const }, { bps: null }, { bps: 0 }]) {
      await resetDb(db);
      const other = await hotel(agent);
      await other.checkOut();
      expect((await other.ok<Calculated>(other.calculate())).created).toBe(0);
    }
  });

  it('uses the reservation’s travel agent when the booking has one', async () => {
    const h = await hotel({ kind: 'COMPANY', bps: null });
    const agent = await db.company.create({
      data: { organisationId: h.org.id, kind: 'TRAVEL_AGENT', name: 'Wakanow', commissionBps: 800 },
    });
    const stay = await db.stay.findUniqueOrThrow({ where: { id: h.stayId } });
    await db.reservation.update({
      where: { id: stay.reservationId },
      data: { travelAgentId: agent.id },
    });
    await h.checkOut();
    const result = await h.ok<Calculated>(h.calculate());
    expect(result.data[0]).toMatchObject({
      agent: { name: 'Wakanow' },
      rateBps: 800,
      amountMinor: '800000',
    });
  });

  it('keeps the rate it was worked out at when the agent’s rate changes', async () => {
    const h = await hotel();
    await h.checkOut();
    await h.ok(h.calculate());
    await db.company.update({ where: { id: h.company.id }, data: { commissionBps: 2000 } });
    await h.ok(h.gm.send(`/folio-lines/${h.roomLineId}/reverse`, { reason: 'Billed in error' }));
    await h.ok(
      h.charge({ revenueCode: 'ROOM', description: 'Room 101', unitAmountMinor: '5000000' }),
    );
    const result = await h.ok<Calculated>(h.calculate());
    expect(result.data[0]).toMatchObject({ rateBps: 1000, amountMinor: '500000' });
  });

  it('refuses a period ending in the future, and staff without ar.commission', async () => {
    const h = await hotel();
    expect((await h.calculate('2026-11-01', '2026-11-11')).status).toBe(400);
    expect((await h.calculate('2026-11-05', '2026-11-01')).status).toBe(400);
    expect((await h.fd.get('/commissions')).status).toBe(403);
    expect((await h.calculate('2026-11-01', '2026-11-10', h.fd)).status).toBe(403);
  });
});

describe('settling (M4-22)', () => {
  it('marks commissions paid, and they never change again', async () => {
    const h = await hotel();
    await h.checkOut();
    const [c] = (await h.ok<Calculated>(h.calculate())).data;
    const paid = await h.ok<{ data: Commission[] }>(
      h.fin.send('/commissions/settle', {
        commissionIds: [c?.id],
        as: 'PAID',
        settledOn: '2026-11-10',
        reference: 'GTB-OUT-1',
      }),
    );
    expect(paid.data[0]).toMatchObject({
      status: 'PAID',
      settledOn: '2026-11-10',
      reference: 'GTB-OUT-1',
    });
    await h.ok(h.gm.send(`/folio-lines/${h.roomLineId}/reverse`, { reason: 'Billed in error' }));
    expect((await h.ok<Calculated>(h.calculate())).updated).toBe(0);
    expect((await h.list('?status=PAID')).data[0]?.amountMinor).toBe('1000000');
    expect((await h.list('?status=DUE')).data).toEqual([]);

    const again = await h.fin.send('/commissions/settle', {
      commissionIds: [c?.id],
      as: 'PAID',
      settledOn: '2026-11-10',
    });
    expect(again.status).toBe(409);
    expect(errorOf(again).code).toBe('STATE_TRANSITION_INVALID');
  });

  it('sets commissions off against what the agent owes on the city ledger, oldest first', async () => {
    const h = await hotel();
    const account = await h.ok<{ id: string }>(
      h.gm.post('/ar-accounts', { companyId: h.company.id, creditLimitMinor: '50000000' }),
    );
    // The agent owes the whole folio on account.
    await h.ok(h.gm.send(`/ar-accounts/${account.id}/transfers`, { folioId: h.folioId }));
    await h.checkOut();
    const [c] = (await h.ok<Calculated>(h.calculate())).data;
    const off = await h.ok<{ data: Commission[] }>(
      h.fin.send('/commissions/settle', {
        commissionIds: [c?.id],
        as: 'OFFSET',
        settledOn: '2026-11-10',
      }),
    );
    expect(off.data[0]).toMatchObject({ status: 'OFFSET' });
    const detail = await h.ok<{
      payments: { method: string; amountMinor: string; unallocatedMinor: string }[];
      invoices: { openMinor: string; amountMinor: string }[];
    }>(h.gm.get(`/ar-accounts/${account.id}`));
    expect(detail.payments[0]).toMatchObject({
      method: 'COMMISSION_OFFSET',
      amountMinor: '1000000',
      unallocatedMinor: '0',
    });
    const invoice = detail.invoices[0];
    expect(BigInt(invoice?.amountMinor ?? '0') - BigInt(invoice?.openMinor ?? '0')).toBe(1000000n);
    const row = await db.commission.findFirstOrThrow();
    expect(row.arPaymentId).not.toBeNull();
  });

  it('refuses an offset with no account, and one agent’s commissions mixed with another’s', async () => {
    const h = await hotel();
    await h.checkOut();
    const [c] = (await h.ok<Calculated>(h.calculate())).data;
    const noAccount = await h.fin.send('/commissions/settle', {
      commissionIds: [c?.id],
      as: 'OFFSET',
      settledOn: '2026-11-10',
    });
    expect(errorOf(noAccount).message).toContain('no city-ledger account');

    const other = await db.company.create({
      data: { organisationId: h.org.id, kind: 'TRAVEL_AGENT', name: 'Wakanow' },
    });
    const s = await db.stay.findUniqueOrThrow({ where: { id: h.stayId } });
    // A second stay on the same booking, booked for the other agent's guest.
    const { id: _quoteId, ...quote } = await db.quote.findUniqueOrThrow({
      where: { id: s.quoteId },
    });
    const copy = await db.quote.create({
      data: quote as unknown as Parameters<typeof db.quote.create>[0]['data'],
    });
    const second = await db.stay.create({
      data: {
        propertyId: s.propertyId,
        reservationId: s.reservationId,
        guestId: s.guestId,
        roomTypeId: s.roomTypeId,
        ratePlanId: s.ratePlanId,
        quoteId: copy.id,
        arrival: s.arrival,
        departure: s.departure,
        status: 'CHECKED_OUT',
      },
    });
    const twin = await db.commission.create({
      data: {
        propertyId: h.p1.id,
        travelAgentId: other.id,
        stayId: second.id,
        checkedOutOn: new Date('2026-11-10'),
        baseMinor: 100n,
        rateBps: 1000,
        amountMinor: 10n,
      },
    });
    const mixed = await h.fin.send('/commissions/settle', {
      commissionIds: [c?.id, twin.id],
      as: 'PAID',
      settledOn: '2026-11-10',
    });
    expect(errorOf(mixed).message).toContain('one agent');
    expect(
      (
        await h.fin.send('/commissions/settle', {
          commissionIds: [c?.id],
          as: 'PAID',
          settledOn: '2026-11-11',
        })
      ).status,
    ).toBe(400);
  });
});
