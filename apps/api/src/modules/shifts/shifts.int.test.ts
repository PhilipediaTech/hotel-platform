import { randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import { resetDb, testDb } from '../../../test/db.ts';
import { errorOf } from '../../../test/helpers.ts';
import { hotelClient, makeHotel } from '../../../test/hotel.ts';
import { sessionCookie } from '../../../test/tenancy.ts';

// Cashier shifts (PRD M4-10–M4-12, M4 rule 4 and the acceptance criterion "shift close with
// ₦2,000 variance above tolerance (default ₦500) requires supervisor sign-off and raises a
// leakage alert"; tab 4 POST /shifts/{id}/close example; QA "shift close races"; T-061).

const db = testDb();
let now: Date;
const clock = () => new Date(now);

beforeEach(async () => {
  await resetDb(db);
  now = new Date('2026-11-10T09:00:00Z');
});

type Handover = {
  id: string;
  from: string;
  to: string | null;
  amountMinor: string;
  confirmedAt: string | null;
};
type Current = {
  shift: {
    id: string;
    status: string;
    floatMinor: string;
    handoversOut: Handover[];
    handoversIn: Handover[];
    paymentCounts: unknown[];
  } | null;
  awaitingSignOff: Shift[];
  incoming: Handover[];
  colleagues: { userId: string; name: string }[];
};
type Shift = {
  id: string;
  cashier: string;
  status: string;
  lines: {
    method: string;
    currency: string;
    expectedMinor: string;
    countedMinor: string | null;
    varianceMinor: string | null;
  }[];
  toleranceMinor: string;
  requiresSignOff: boolean;
  varianceNote: string | null;
  signedOffBy: string | null;
};

async function hotel() {
  const h = await makeHotel(db, now);
  await db.property.update({ where: { id: h.p1.id }, data: { status: 'LIVE' } });
  const c = hotelClient(db, clock, h.p1.id);
  const as = async (userId: string) => {
    const client = c.as(await sessionCookie(db, userId, clock));
    return {
      ...client,
      send: (path: string, body?: object) =>
        client.post(path, body).set('Idempotency-Key', randomUUID()),
    };
  };
  const ok = async <T>(res: Promise<{ status: number; body: unknown }>) => {
    const r = await res;
    expect(r.status, JSON.stringify(r.body)).toBeLessThan(300);
    return r.body as T;
  };
  const fd2User = await h.person('front-desk', h.p1.id);
  const financeUser = await h.person('finance', h.p1.id);
  const cashier = await as(h.fd.id);
  const fd2 = await as(fd2User.id);
  const gm = await as(h.gm.id);
  const finance = await as(financeUser.id);
  const open = async (who: typeof cashier, floatMinor: string) =>
    (await ok<Current>(who.send('/shifts', { floatMinor }))).shift?.id ?? '';
  const close = (who: typeof cashier, shiftId: string, counts: object[], varianceNote?: string) =>
    who.send(`/shifts/${shiftId}/close`, { counts, ...(varianceNote ? { varianceNote } : {}) });
  const cash = (countedMinor: string) => ({ method: 'CASH', currency: 'NGN', countedMinor });
  return {
    ...h,
    ok,
    cashier,
    fd2,
    fd2Id: fd2User.id,
    gm,
    finance,
    financeId: financeUser.id,
    open,
    close,
    cash,
  };
}

describe('Opening a shift (M4-10, M4 rule 4)', () => {
  it('opens with a counted float, one open shift per cashier, and shows no expected amounts', async () => {
    const h = await hotel();
    const res = await h.cashier.send('/shifts', { floatMinor: '2000000' });
    expect(res.status).toBe(201);
    const body = res.body as Current;
    expect(body.shift).toMatchObject({
      status: 'OPEN',
      floatMinor: '2000000',
      handoversOut: [],
      handoversIn: [],
      paymentCounts: [],
    });
    // Blind: the cashier's view never carries what the drawer should hold.
    expect(JSON.stringify(body)).not.toContain('expected');
    expect(await h.ok<Current>(h.cashier.get('/shifts/current'))).toEqual(body);

    const again = await h.cashier.send('/shifts', { floatMinor: '0' });
    expect(again.status).toBe(409);
    expect(errorOf(again).code).toBe('STATE_TRANSITION_INVALID');
    expect((await h.fd2.send('/shifts', { floatMinor: '-100' })).status).toBe(400);
    expect(await db.auditEvent.count({ where: { action: 'shift.opened' } })).toBe(1);
  });

  it('lets only one of two simultaneous opens through', async () => {
    const h = await hotel();
    const results = await Promise.all([
      h.fd2.send('/shifts', { floatMinor: '100000' }),
      h.fd2.send('/shifts', { floatMinor: '100000' }),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([201, 409]);
    expect(await db.cashierShift.count({ where: { status: 'OPEN' } })).toBe(1);
  });

  it('answers 403 without shift.open, and an empty view before the first shift', async () => {
    const h = await hotel();
    const empty = await h.ok<Current>(h.cashier.get('/shifts/current'));
    expect(empty).toEqual({ shift: null, awaitingSignOff: [], incoming: [], colleagues: [] });
    const reservations = await h.person('reservations', h.p1.id);
    const agent = hotelClient(db, clock, h.p1.id).as(
      await sessionCookie(db, reservations.id, clock),
    );
    expect((await agent.get('/shifts/current')).status).toBe(403);
  });
});

describe('Blind close and variance (M4-11)', () => {
  it('within tolerance the shift closes at once, revealing expected and variance', async () => {
    const h = await hotel();
    const id = await h.open(h.cashier, '2000000');
    const shift = await h.ok<Shift>(h.close(h.cashier, id, [h.cash('1980000')]));
    expect(shift).toMatchObject({
      status: 'CLOSED',
      requiresSignOff: false,
      toleranceMinor: '50000',
      lines: [
        {
          method: 'CASH',
          currency: 'NGN',
          expectedMinor: '2000000',
          countedMinor: '1980000',
          varianceMinor: '-20000',
        },
      ],
    });
    expect(await db.leakageAlert.count()).toBe(0);
    expect((await h.ok<Current>(h.cashier.get('/shifts/current'))).shift).toBeNull();
    // A closed shift can't be closed again, and the counts stand as given.
    const again = await h.close(h.cashier, id, [h.cash('2000000')]);
    expect(errorOf(again).code).toBe('STATE_TRANSITION_INVALID');
    await expect(
      db.cashCount.updateMany({ where: { shiftId: id }, data: { countedMinor: 2000000n } }),
    ).rejects.toThrow();
  });

  it('₦2,000 over tolerance: needs a reason and a supervisor’s sign-off, and raises a leakage alert', async () => {
    const h = await hotel();
    const id = await h.open(h.cashier, '12550000');
    // The tab 4 example: ₦2,000 short in cash; POS counted though none was expected.
    const res = await h.close(h.cashier, id, [
      h.cash('12350000'),
      { method: 'POS_TERMINAL', currency: 'NGN', countedMinor: '0' },
    ]);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      status: 'CLOSING',
      requiresSignOff: true,
      varianceNote: null,
      lines: [
        {
          method: 'CASH',
          expectedMinor: '12550000',
          countedMinor: '12350000',
          varianceMinor: '-200000',
        },
        { method: 'POS_TERMINAL', expectedMinor: '0', countedMinor: '0', varianceMinor: '0' },
      ],
    });
    const alert = await db.leakageAlert.findFirstOrThrow();
    expect(alert).toMatchObject({
      propertyId: h.p1.id,
      ruleCode: 'SHIFT_VARIANCE',
      entityType: 'cashier_shift',
      entityId: id,
      subjectUserId: h.fd.id,
      status: 'OPEN',
      severity: 'NORMAL',
      dedupeKey: `SHIFT_VARIANCE:${id}`,
    });
    expect(alert.evidence).toMatchObject({ toleranceMinor: '50000' });
    expect(await db.domainEvent.count({ where: { type: 'leakage.alert_raised' } })).toBe(1);

    // The cashier sees it waiting; supervisors see it in their list.
    const mine = await h.ok<Current>(h.cashier.get('/shifts/current'));
    expect(mine.awaitingSignOff.map((s) => s.id)).toEqual([id]);
    const list = await h.ok<{ data: Shift[] }>(h.finance.get('/shifts'));
    expect(list.data.map((s) => s.id)).toEqual([id]);
    expect((await h.cashier.get('/shifts')).status).toBe(403);

    // No sign-off before the cashier gives a reason; the cashier can't sign off.
    const early = await h.finance.post(`/shifts/${id}/sign-off`, {});
    expect(errorOf(early).code).toBe('STATE_TRANSITION_INVALID');
    expect((await h.cashier.post(`/shifts/${id}/sign-off`, {})).status).toBe(403);
    await h.ok(
      h.cashier.post(`/shifts/${id}/variance-note`, { note: '₦2,000 short - change given' }),
    );

    const signed = await h.ok<Shift>(h.finance.post(`/shifts/${id}/sign-off`, { note: 'Checked' }));
    expect(signed).toMatchObject({
      status: 'CLOSED',
      requiresSignOff: false,
      varianceNote: '₦2,000 short - change given',
      signedOffBy: expect.any(String) as string,
    });
    const row = await db.cashierShift.findUniqueOrThrow({ where: { id } });
    expect(row.signedOffById).toBe(h.financeId);
    const audit = await db.auditEvent.findFirstOrThrow({ where: { action: 'shift.signed_off' } });
    expect(audit.reason).toBe('Checked');
    // Signed off once only.
    const twice = await h.finance.post(`/shifts/${id}/sign-off`, {});
    expect(errorOf(twice).code).toBe('STATE_TRANSITION_INVALID');
  });

  it('takes the reason with the count, and a supervisor never signs off their own shift', async () => {
    const h = await hotel();
    const id = await h.open(h.gm, '1000000');
    const shift = await h.ok<Shift>(h.close(h.gm, id, [h.cash('400000')], 'Paid a supplier'));
    expect(shift).toMatchObject({ status: 'CLOSING', varianceNote: 'Paid a supplier' });
    expect((await h.gm.post(`/shifts/${id}/sign-off`, {})).status).toBe(403);
    await h.ok(h.finance.post(`/shifts/${id}/sign-off`, {}));
    // ₦6,000 is more than ten times the tolerance: high severity.
    expect((await db.leakageAlert.findFirstOrThrow()).severity).toBe('HIGH');
  });

  it('uses the property’s own tolerance', async () => {
    const h = await hotel();
    await db.property.update({
      where: { id: h.p1.id },
      data: { settings: { shiftVarianceToleranceMinor: '300000' } },
    });
    const id = await h.open(h.cashier, '1000000');
    const shift = await h.ok<Shift>(h.close(h.cashier, id, [h.cash('800000')]));
    expect(shift).toMatchObject({ status: 'CLOSED', toleranceMinor: '300000' });
    expect(await db.leakageAlert.count()).toBe(0);
  });

  it('closes once when two closes race (QA: shift close races)', async () => {
    const h = await hotel();
    const id = await h.open(h.cashier, '1000000');
    const results = await Promise.all([
      h.close(h.cashier, id, [h.cash('1000000')]),
      h.close(h.cashier, id, [h.cash('1000000')]),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
    expect(await db.cashCount.count({ where: { shiftId: id } })).toBe(1);
  });

  it('only the cashier or a supervisor closes a shift; the count must include cash', async () => {
    const h = await hotel();
    const id = await h.open(h.cashier, '1000000');
    expect((await h.close(h.fd2, id, [h.cash('1000000')])).status).toBe(403);
    expect(
      (
        await h.close(h.cashier, id, [
          { method: 'POS_TERMINAL', currency: 'NGN', countedMinor: '0' },
        ])
      ).status,
    ).toBe(400);
    expect((await h.close(h.cashier, id, [h.cash('1'), h.cash('2')])).status).toBe(400);
    // A supervisor counts for a cashier who left without closing.
    expect((await h.ok<Shift>(h.close(h.gm, id, [h.cash('1000000')]))).status).toBe('CLOSED');
  });
});

describe('Cash handovers (M4-12)', () => {
  it('to a colleague (who confirms) and to the safe; the expected cash follows', async () => {
    const h = await hotel();
    const mine = await h.open(h.cashier, '5000000');
    const theirs = await h.open(h.fd2, '0');

    const colleagues = (await h.ok<Current>(h.cashier.get('/shifts/current'))).colleagues;
    expect(colleagues.map((c) => c.userId)).toEqual([h.fd2Id]);

    const sent = await h.cashier.send('/cash-handovers', {
      toUserId: h.fd2Id,
      amountMinor: '1000000',
    });
    expect(sent.status).toBe(201);
    await h.ok(h.cashier.send('/cash-handovers', { toUserId: null, amountMinor: '500000' }));
    const view = await h.ok<Current>(h.cashier.get('/shifts/current'));
    expect(view.shift?.handoversOut).toMatchObject([
      { to: expect.any(String) as string, amountMinor: '1000000', confirmedAt: null },
      { to: null, amountMinor: '500000', confirmedAt: expect.any(String) as string },
    ]);

    // The colleague sees it coming and confirms it into their shift.
    const incoming = (await h.ok<Current>(h.fd2.get('/shifts/current'))).incoming;
    expect(incoming).toMatchObject([{ amountMinor: '1000000', confirmedAt: null }]);
    const handoverId = incoming[0]?.id ?? '';
    expect((await h.gm.post(`/cash-handovers/${handoverId}/confirm`)).status).toBe(404);
    now = new Date('2026-11-10T10:00:00Z');
    const confirmed = await h.ok<Current>(h.fd2.post(`/cash-handovers/${handoverId}/confirm`));
    expect(confirmed.incoming).toEqual([]);
    expect(confirmed.shift?.handoversIn).toMatchObject([{ amountMinor: '1000000' }]);
    const twice = await h.fd2.post(`/cash-handovers/${handoverId}/confirm`);
    expect(errorOf(twice).code).toBe('STATE_TRANSITION_INVALID');

    // Supervisors see the expected amounts of open shifts.
    const open = await h.ok<{ data: Shift[] }>(h.finance.get('/shifts?status=OPEN'));
    expect(Object.fromEntries(open.data.map((s) => [s.id, s.lines[0]?.expectedMinor]))).toEqual({
      [mine]: '3500000',
      [theirs]: '1000000',
    });

    now = new Date('2026-11-10T17:00:00Z');
    const a = await h.ok<Shift>(h.close(h.cashier, mine, [h.cash('3500000')]));
    expect(a).toMatchObject({
      status: 'CLOSED',
      lines: [{ expectedMinor: '3500000', varianceMinor: '0' }],
    });
    const b = await h.ok<Shift>(h.close(h.fd2, theirs, [h.cash('1000000')]));
    expect(b).toMatchObject({
      status: 'CLOSED',
      lines: [{ expectedMinor: '1000000', varianceMinor: '0' }],
    });

    // A handover is never changed or deleted.
    await expect(db.cashHandover.deleteMany({ where: { id: handoverId } })).rejects.toThrow();
    await expect(
      db.cashHandover.update({ where: { id: handoverId }, data: { amountMinor: 1n } }),
    ).rejects.toThrow();
  });

  it('needs an open shift on both sides', async () => {
    const h = await hotel();
    const none = await h.cashier.send('/cash-handovers', { toUserId: null, amountMinor: '100000' });
    expect(none.status).toBe(409);
    expect(errorOf(none).code).toBe('SHIFT_NOT_OPEN');
    await h.open(h.cashier, '1000000');
    const noShift = await h.cashier.send('/cash-handovers', {
      toUserId: h.fd2Id,
      amountMinor: '100000',
    });
    expect(errorOf(noShift).details).toMatchObject({ issues: [{ path: 'body.toUserId' }] });
    const self = await h.cashier.send('/cash-handovers', {
      toUserId: h.fd.id,
      amountMinor: '100000',
    });
    expect(self.status).toBe(400);
    expect(
      (await h.cashier.send('/cash-handovers', { toUserId: null, amountMinor: '0' })).status,
    ).toBe(400);

    // Received while the receiver has no open shift: confirming needs one.
    const theirs = await h.open(h.fd2, '0');
    await h.ok(h.cashier.send('/cash-handovers', { toUserId: h.fd2Id, amountMinor: '100000' }));
    await h.ok(h.close(h.fd2, theirs, [h.cash('0')]));
    const pending = (await h.ok<Current>(h.fd2.get('/shifts/current'))).incoming[0]?.id ?? '';
    const res = await h.fd2.post(`/cash-handovers/${pending}/confirm`);
    expect(errorOf(res).code).toBe('SHIFT_NOT_OPEN');
  });
});
