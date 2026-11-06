import { beforeEach, describe, expect, it } from 'vitest';
import { moveBusinessDay } from '../../../test/business-day.ts';
import { resetDb, testDb } from '../../../test/db.ts';
import { errorOf } from '../../../test/helpers.ts';
import { inHouse, TODAY, type Folio } from '../../../test/in-house.ts';

// Cancellation and no-show fees (PRD M3 "I cancel with a reason code; cancellation fees apply
// per policy; I can reinstate if inventory allows", the night auditor's no-show story and the
// rule "no-show is only possible after night audit of the arrival date; non-guaranteed
// no-shows release inventory without fee"; tab 4 POST /reservations/{id}/cancel, /no-show,
// /reinstate; T-074).

const db = testDb();
let now: Date;
const clock = () => new Date(now);

beforeEach(async () => {
  await resetDb(db);
  now = new Date('2026-11-10T09:00:00Z');
});

type Cancelled = { status: string; feeMinor: string; feeFolioId: string | null; version: number };
type Lines = { kind: string; revenueCode: string; description: string; amountMinor: string }[];

/** Ada Obi booked for tonight and tomorrow (₦100,000 a night; 1 night's fee on the day). */
async function booking(guarantee: string) {
  const h = await inHouse(db, clock, { guarantee, checkIn: false });
  await db.property.update({
    where: { id: h.p1.id },
    data: { settings: { paymentMethods: ['CASH'] } },
  });
  const auditor = await h.as((await h.person('night-auditor', h.p1.id)).id);
  const cancel = (reason = 'GUEST_REQUEST') =>
    h.fd.send(`/reservations/${h.reservationId}/cancel`, { reason });
  const folioLines = async (id: string) =>
    (await h.ok<Folio>(h.fd.get(`/folios/${id}`))).windows.flatMap((w) => w.lines) as Lines;
  return { ...h, auditor, cancel, folioLines };
}

describe('cancellation fees', () => {
  it('charges a guaranteed booking on its folio, where the deposit pays it; reinstating reverses it', async () => {
    const h = await booking('DEPOSIT');
    await h.ok(h.fd.send('/shifts', { floatMinor: '0' }));
    await h.ok(
      h.fd.send('/payments', {
        reservationId: h.reservationId,
        method: 'CASH',
        amountMinor: '5000000',
      }),
    );
    const res = await h.cancel();
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const cancelled = res.body as Cancelled;
    expect(cancelled).toMatchObject({ status: 'CANCELLED', feeMinor: '10000000' });
    const folioId = cancelled.feeFolioId ?? '';
    expect(folioId).not.toBe('');

    const folio = await h.ok<Folio>(h.fd.get(`/folios/${folioId}`));
    expect(
      folio.windows.flatMap((w) => w.lines).map((l) => [l.kind, l.revenueCode, l.amountMinor]),
    ).toEqual(
      expect.arrayContaining([
        ['CHARGE', 'CANCEL', '10000000'],
        ['DEPOSIT_APPLY', 'DEPOSIT', '-5000000'],
      ]),
    );
    // No tax on the fee: ₦100,000 less the ₦50,000 deposit.
    expect(folio.balanceMinor).toBe('5000000');
    const ledger = await db.depositLedgerEntry.findMany({ orderBy: { amountMinor: 'desc' } });
    expect(ledger.map((e) => [e.kind, e.amountMinor])).toEqual([
      ['RECEIVED', 5_000_000n],
      ['APPLIED', -5_000_000n],
    ]);

    // Reinstated: the fee goes, the deposit stays on the folio, and check-in uses that folio.
    await h.ok(h.gm.send(`/reservations/${h.reservationId}/reinstate`));
    const after = await h.folioLines(folioId);
    expect(
      after.filter((l) => l.kind === 'REVERSAL').map((l) => [l.revenueCode, l.amountMinor]),
    ).toEqual([['CANCEL', '-10000000']]);
    expect((await h.ok<Folio>(h.fd.get(`/folios/${folioId}`))).balanceMinor).toBe('-5000000');
    const stay = await db.stay.findUniqueOrThrow({ where: { id: h.stayId } });
    const room = await db.room.findFirstOrThrow({ where: { propertyId: h.p1.id } });
    const checkedIn = await h.ok<{ folioId: string }>(
      h.fd
        .send(`/stays/${h.stayId}/check-in`, {
          roomId: room.id,
          registration: {
            nationality: 'NG',
            purpose: 'BUSINESS',
            idType: 'PASSPORT',
            idNumber: 'A1234567',
          },
        })
        .set('If-Match', `"${stay.version}"`),
    );
    expect(checkedIn.folioId).toBe(folioId);
    // System lines can't be reversed again by hand.
    expect(await db.folioLine.count({ where: { kind: 'REVERSAL' } })).toBe(1);
  });

  it('only tells a booking without a guarantee what it would owe, and waives it for a duplicate', async () => {
    const h = await booking('NONE');
    expect(await h.ok<Cancelled>(h.cancel())).toMatchObject({
      status: 'CANCELLED',
      feeMinor: '10000000',
      feeFolioId: null,
    });
    expect(await db.folio.count()).toBe(0);

    const g = await booking('CARD_ON_FILE');
    expect(await g.ok<Cancelled>(g.cancel('DUPLICATE'))).toMatchObject({
      feeMinor: '0',
      feeFolioId: null,
    });
    expect(await db.folioLine.count()).toBe(0);
  });
});

describe('no-shows by hand', () => {
  it('only after night audit of the arrival date; a guaranteed booking pays the fee', async () => {
    const h = await booking('CARD_ON_FILE');
    const mark = () =>
      h.auditor.send(`/reservations/${h.reservationId}/no-show`, { note: 'Called, no answer' });
    const early = await mark();
    expect(early.status).toBe(409);
    expect(errorOf(early).message).toBe(
      'A no-show is marked once night audit has closed the arrival date',
    );
    const hk = await h.as((await h.person('hk-attendant', h.p1.id)).id);
    expect((await hk.send(`/reservations/${h.reservationId}/no-show`, {})).status).toBe(403);

    // The arrival date is closed and the guest never came (night audit left them).
    await moveBusinessDay(db, h.p1.id, '2026-11-11');
    const res = await mark();
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const done = res.body as Cancelled & { stays: { status: string; roomNumber: string | null }[] };
    expect(done).toMatchObject({ status: 'NO_SHOW', feeMinor: '10000000' });
    expect(done.stays.map((s) => s.status)).toEqual(['NO_SHOW']);
    const lines = await h.folioLines(done.feeFolioId ?? '');
    expect(lines.map((l) => [l.revenueCode, l.description, l.amountMinor])).toEqual([
      ['NOSHOW', `No-show fee, arrival ${TODAY}`, '10000000'],
    ]);
    const history = await db.reservationStatusHistory.findFirstOrThrow({
      where: { toStatus: 'NO_SHOW' },
    });
    expect(history.reason).toBe('Marked by the desk: Called, no answer');
    // The rooms are free again for both nights.
    const sold = await db.roomTypeInventory.findMany({
      where: { date: { in: [new Date(`${TODAY}T00:00:00Z`), new Date('2026-11-11T00:00:00Z')] } },
    });
    expect(sold.map((r) => r.sold)).toEqual([0, 0]);

    expect(errorOf(await mark()).message).toBe('No guest on this booking is waiting to arrive');
    // The arrival date has passed: a no-show isn't reinstated (book again).
    expect(
      errorOf(await h.gm.send(`/reservations/${h.reservationId}/reinstate`)).details,
    ).toMatchObject({ reason: 'ARRIVAL_PASSED' });
  });
});
