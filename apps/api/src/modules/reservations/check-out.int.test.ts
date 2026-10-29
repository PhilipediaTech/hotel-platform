import { randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import { resetDb, testDb } from '../../../test/db.ts';
import { errorOf } from '../../../test/helpers.ts';
import { inHouse } from '../../../test/in-house.ts';

// Check-out (PRD M3 story "I check a guest out after the folio balance is zero…", M3 rules 3
// and 4, M3 acceptance "check-out with a balance and no AR transfer fails with
// FOLIO_BALANCE_OUTSTANDING", housekeeping rule 2; tab 4 POST /stays/{id}/check-out; S12; T-064).

const db = testDb();
let now: Date;
const clock = () => new Date(now);

beforeEach(async () => {
  await resetDb(db);
  now = new Date('2026-11-10T09:00:00Z');
});

type Preview = {
  status: string;
  departure: string;
  businessDate: string;
  folio: {
    number: string;
    balanceMinor: string;
    windows: { number: number; balanceMinor: string }[];
  } | null;
  warnings: { code: string; count: number }[];
  blockers: string[];
  version: number;
};

/** Ada Obi in room 101 until 2026-11-12, a ₦100,000 room charge (₦123,250 with taxes), two
 * key cards, the front desk's shift open with cash and POS switched on; the clock on the
 * departure morning. */
async function leaving(morning = '2026-11-12T08:00:00Z') {
  const h = await inHouse(db, clock);
  await db.property.update({
    where: { id: h.p1.id },
    data: { settings: { paymentMethods: ['CASH', 'POS_TERMINAL'] } },
  });
  await h.ok(
    h.charge({ revenueCode: 'ROOM', description: 'Room 101', unitAmountMinor: '10000000' }),
  );
  await h.ok(h.fd.send(`/stays/${h.stayId}/keys`, { count: 2 }));
  await h.ok(h.fd.send('/shifts', { floatMinor: '0' }));
  let fd = h.fd;
  /** Moves the clock and signs the desk in again (sessions expire). */
  const at = async (instant: string) => {
    now = new Date(instant);
    fd = await h.as(h.fdId);
  };
  await at(morning); // by default 09:00 in Lagos on the departure day
  const preview = () => h.ok<Preview>(fd.get(`/stays/${h.stayId}/check-out`));
  const checkOut = async (body: object = {}) => {
    const { version } = await preview();
    return fd
      .post(`/stays/${h.stayId}/check-out`, body)
      .set('Idempotency-Key', randomUUID())
      .set('If-Match', `"${version}"`);
  };
  const pay = (amountMinor: string, windowNumber = 1) =>
    h.ok(fd.send('/payments', { folioId: h.folioId, windowNumber, method: 'CASH', amountMinor }));
  return {
    ...h,
    get fd() {
      return fd;
    },
    charge: (b: object) => fd.send(`/folios/${h.folioId}/lines`, b),
    at,
    preview,
    checkOut,
    pay,
  };
}

describe('Check-out (M3 rules 3–4)', () => {
  it('refuses a balance with FOLIO_BALANCE_OUTSTANDING, then checks out once it is paid', async () => {
    const h = await leaving();
    const before = await h.preview();
    expect(before).toMatchObject({
      status: 'CHECKED_IN',
      departure: '2026-11-12',
      businessDate: '2026-11-12',
      folio: {
        number: 'F00001',
        balanceMinor: '12325000',
        windows: [{ number: 1, balanceMinor: '12325000' }],
      },
      warnings: [{ code: 'KEYS_NOT_RETURNED', count: 2 }],
      blockers: ['FOLIO_BALANCE_OUTSTANDING'],
    });

    const refused = await h.checkOut();
    expect(refused.status).toBe(409);
    expect(errorOf(refused)).toMatchObject({
      code: 'FOLIO_BALANCE_OUTSTANDING',
      details: { windows: [{ number: 1, balanceMinor: '12325000' }] },
    });

    await h.pay('12325000');
    expect((await h.preview()).blockers).toEqual([]);
    const done = await h.checkOut({ keysReturned: true });
    expect(done.status).toBe(200);
    expect(done.body).toMatchObject({ status: 'CHECKED_OUT', stays: [{ status: 'CHECKED_OUT' }] });

    // Housekeeping rule 2: the room is dirty; the folio is settled and takes nothing more.
    const room = await db.room.findFirstOrThrow({ where: { number: '101' } });
    expect(room.hkStatus).toBe('DIRTY');
    const folio = await db.folio.findUniqueOrThrow({ where: { id: h.folioId } });
    expect(folio.status).toBe('SETTLED');
    const late = await h.charge({
      revenueCode: 'MISC',
      description: 'Late',
      unitAmountMinor: '100',
    });
    expect(errorOf(late).code).toBe('STATE_TRANSITION_INVALID');
    const latePay = await h.fd.send('/payments', {
      folioId: h.folioId,
      method: 'CASH',
      amountMinor: '100',
    });
    expect(errorOf(latePay).code).toBe('STATE_TRANSITION_INVALID');

    expect(await db.keyIssue.count({ where: { stayId: h.stayId, returnedAt: null } })).toBe(0);
    const audit = await db.auditEvent.findFirstOrThrow({ where: { action: 'stay.checked_out' } });
    expect(audit.after).toMatchObject({ keysReturned: true, folioId: h.folioId });

    // Checked out once.
    const again = await h.checkOut();
    expect(errorOf(again).code).toBe('STATE_TRANSITION_INVALID');
  });

  it('counts each window: an overpaid guest window does not cover the company’s', async () => {
    const h = await leaving();
    await h.ok(
      h.fd.post(`/folios/${h.folioId}/windows`, { payerType: 'COMPANY', companyId: h.company.id }),
    );
    await h.ok(
      h.fd.send(`/folios/${h.folioId}/lines`, {
        windowNumber: 2,
        revenueCode: 'MISC',
        description: 'Meeting room',
        unitAmountMinor: '1000000',
      }),
    );
    // Window 2 owes ₦10,750 (with VAT); the guest pays that much extra on window 1.
    await h.pay('13400000');
    const preview = await h.preview();
    expect(preview.folio?.balanceMinor).toBe('0');
    expect(preview.folio?.windows).toEqual([
      expect.objectContaining({ number: 1, balanceMinor: '-1075000' }),
      expect.objectContaining({ number: 2, balanceMinor: '1075000' }),
    ]);
    expect(preview.blockers).toEqual(['FOLIO_BALANCE_OUTSTANDING']);
    expect(errorOf(await h.checkOut()).code).toBe('FOLIO_BALANCE_OUTSTANDING');
  });

  it('warns about keys but does not block, and logs them as still out when not returned', async () => {
    const h = await leaving();
    await h.pay('12325000');
    await h.ok(h.checkOut({ keysReturned: false }));
    expect(await db.keyIssue.count({ where: { stayId: h.stayId, returnedAt: null } })).toBe(1);
  });

  it('shortens an early departure to the business date as part of the check-out (M3-12)', async () => {
    const h = await leaving('2026-11-11T08:00:00Z'); // the day before departure
    await h.pay('12325000');
    const early = await h.preview();
    expect(early).toMatchObject({
      departure: '2026-11-12',
      leavesOn: '2026-11-11',
      blockers: [],
    });
    expect(early.warnings).toContainEqual({ code: 'EARLY_DEPARTURE', count: 1 });
    expect((await h.checkOut()).status).toBe(200);

    const stay = await db.stay.findUniqueOrThrow({
      where: { id: h.stayId },
      include: { nights: true },
    });
    expect(stay).toMatchObject({ status: 'CHECKED_OUT', departure: new Date('2026-11-11') });
    expect(stay.nights.map((n) => n.date.toISOString().slice(0, 10))).toEqual(['2026-11-10']);
    const shortened = await db.auditEvent.findFirstOrThrow({ where: { action: 'stay.shortened' } });
    expect(shortened.reason).toBe('Early departure at check-out');
    // The night of the 11th is for sale again.
    const night = await db.roomTypeInventory.findFirstOrThrow({
      where: { date: new Date('2026-11-11') },
    });
    expect(night.sold).toBe(0);
  });

  it('keeps one night for a guest leaving on the arrival day', async () => {
    const h = await leaving('2026-11-10T15:00:00Z'); // the arrival day, afternoon
    await h.pay('12325000');
    const early = await h.preview();
    expect(early).toMatchObject({ leavesOn: '2026-11-11', blockers: [] });
    expect(early.warnings).toContainEqual({ code: 'EARLY_DEPARTURE', count: 1 });
    expect((await h.checkOut()).status).toBe(200);
    const stay = await db.stay.findUniqueOrThrow({ where: { id: h.stayId } });
    expect(stay.departure).toEqual(new Date('2026-11-11'));
  });

  it('lets an overstay leave without shortening', async () => {
    const h = await leaving('2026-11-13T08:00:00Z'); // a day after the departure date
    await h.pay('12325000');
    const overstay = await h.preview();
    expect(overstay).toMatchObject({ leavesOn: '2026-11-12', blockers: [] });
    expect(overstay.warnings.map((w) => w.code)).not.toContain('EARLY_DEPARTURE');
    expect((await h.checkOut()).status).toBe(200);
    expect(await db.auditEvent.count({ where: { action: 'stay.shortened' } })).toBe(0);
  });

  it('checks out once when two check-outs race, and needs reservation.checkout', async () => {
    const h = await leaving();
    await h.pay('12325000');
    const { version } = await h.preview();
    const send = () =>
      h.fd
        .post(`/stays/${h.stayId}/check-out`, {})
        .set('Idempotency-Key', randomUUID())
        .set('If-Match', `"${version}"`);
    const results = await Promise.all([send(), send()]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
    expect(await db.reservationStatusHistory.count({ where: { toStatus: 'CHECKED_OUT' } })).toBe(1);

    const agent = await h.as((await h.person('reservations', h.p1.id)).id);
    expect((await agent.get(`/stays/${h.stayId}/check-out`)).status).toBe(403);
  });
});
