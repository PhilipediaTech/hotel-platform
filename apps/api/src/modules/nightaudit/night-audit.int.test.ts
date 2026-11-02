import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resetDb, testDb } from '../../../test/db.ts';
import { errorOf } from '../../../test/helpers.ts';
import { inHouse, TODAY, type Folio } from '../../../test/in-house.ts';
import { nightAuditFaults } from './service.ts';

// Night audit, steps 1–5 and 10 (PRD M4 rule 8 and the acceptance criteria "running night
// audit twice for the same date posts room charges once" and "a night audit that fails at
// step 6 resumes at step 6 and finishes with correct totals"; QA "night audit with one
// unarrived guest and one open shift → exceptions resolved → day closed"; tab 4 POST
// /night-audits, GET /night-audits/{id}, POST /night-audits/{id}/resume; T-073a).

const db = testDb();
let now: Date;
const clock = () => new Date(now);

beforeEach(async () => {
  await resetDb(db);
  now = new Date('2026-11-10T09:00:00Z');
});
afterEach(() => {
  nightAuditFaults.at = null;
});

type Exception = {
  type: string;
  blocking: boolean;
  message: string;
  shiftId?: string;
  stayId?: string;
};
type Step = {
  step: number;
  name: string;
  status: string;
  exceptions: Exception[];
  result: Record<string, string | number>;
};
type Run = {
  id: string;
  businessDate: string;
  status: string;
  currentStep: number;
  error: string | null;
  steps: Step[];
};
type Day = { date: string; status: string; nightAuditId: string | null };

/** Ada Obi in house in room 101 (10–12 Nov, ₦100,000 a night); a night auditor; room 102. */
async function hotel() {
  const h = await inHouse(db, clock);
  await db.property.update({
    where: { id: h.p1.id },
    data: { settings: { paymentMethods: ['CASH', 'POS_TERMINAL'] } },
  });
  const auditorId = (await h.person('night-auditor', h.p1.id)).id;
  // Signed-in clients, signed in again when the clock moves (sessions end when idle).
  const who = { fd: h.fd, auditor: await h.as(auditorId) };
  const at = async (instant: string) => {
    now = new Date(instant);
    who.fd = await h.as(h.fdId);
    who.auditor = await h.as(auditorId);
  };
  const type = await db.roomType.findFirstOrThrow({ where: { propertyId: h.p1.id } });
  const bar = await db.ratePlan.findFirstOrThrow({ where: { propertyId: h.p1.id, code: 'BAR' } });
  const room102 = await h.ok<{ id: string }>(
    h.gm.post('/rooms', { number: '102', roomTypeId: type.id }),
  );
  await db.room.update({ where: { id: room102.id }, data: { hkStatus: 'CLEAN' } });
  /** Books a guest on `plan` (BAR by default) arriving today. */
  const book = async (
    first: string,
    options: {
      ratePlanId?: string;
      adults?: number;
      guarantee?: string;
      arrival?: string;
      departure?: string;
    } = {},
  ) => {
    const quote = await h.ok<{ quoteId: string }>(
      who.fd.post('/quotes', {
        roomTypeId: type.id,
        ratePlanId: options.ratePlanId ?? bar.id,
        arrival: options.arrival ?? TODAY,
        departure: options.departure ?? '2026-11-12',
        adults: options.adults ?? 1,
      }),
    );
    const r = await h.ok<{ id: string; stays: { id: string; version: number }[] }>(
      who.fd.send('/reservations', {
        source: 'PHONE',
        booker: { firstName: first, lastName: 'Ade' },
        ...(options.guarantee ? { guarantee: options.guarantee } : {}),
        stays: [{ quoteId: quote.quoteId }],
      }),
    );
    return r.stays[0] as { id: string; version: number };
  };
  const checkIn = async (stay: { id: string; version: number }) => {
    const res = await h.ok<{ folioId: string }>(
      who.fd
        .send(`/stays/${stay.id}/check-in`, {
          roomId: room102.id,
          registration: {
            nationality: 'NG',
            purpose: 'BUSINESS',
            idType: 'PASSPORT',
            idNumber: 'B1234567',
          },
        })
        .set('If-Match', `"${stay.version}"`),
    );
    return res.folioId;
  };
  const start = (date = TODAY) => who.auditor.send('/night-audits', { businessDate: date });
  const resume = (id: string) => who.auditor.send(`/night-audits/${id}/resume`);
  const day = () => h.ok<Day>(who.auditor.get('/business-day'));
  const folioOf = (id: string) => h.ok<Folio>(who.fd.get(`/folios/${id}`));
  const roomLines = (folio: Folio) =>
    folio.windows
      .flatMap((w) => w.lines)
      .filter((l) => l.kind === 'CHARGE' && l.revenueCode === 'ROOM');
  const step = (run: Run, n: number) => run.steps.find((s) => s.step === n) as Step;
  /** Pays the folio's balance in cash on a shift of its own and checks the guest out. */
  const settleAndLeave = async (stayId: string, folioId: string) => {
    const { shift } = await h.ok<{ shift: { id: string } }>(
      who.fd.send('/shifts', { floatMinor: '0' }),
    );
    const { balanceMinor } = await folioOf(folioId);
    await h.ok(who.fd.send('/payments', { folioId, method: 'CASH', amountMinor: balanceMinor }));
    const { version } = await db.stay.findUniqueOrThrow({ where: { id: stayId } });
    await h.ok(who.fd.send(`/stays/${stayId}/check-out`, {}).set('If-Match', `"${version}"`));
    await h.ok(
      who.fd.send(`/shifts/${shift.id}/close`, {
        counts: [{ method: 'CASH', currency: 'NGN', countedMinor: balanceMinor }],
      }),
    );
  };
  return {
    ...h,
    get fd() {
      return who.fd;
    },
    get auditor() {
      return who.auditor;
    },
    at,
    folio: () => folioOf(h.folioId),
    charge: (b: object) => who.fd.send(`/folios/${h.folioId}/lines`, b),
    type,
    bar,
    room102,
    book,
    checkIn,
    start,
    resume,
    day,
    folioOf,
    roomLines,
    step,
    settleAndLeave,
  };
}

describe('night audit', () => {
  it('stops at an open shift, lists unarrived guests, then posts the night and closes the day', async () => {
    const h = await hotel();
    const bola = await h.book('Bola');
    const { shift } = await h.ok<{ shift: { id: string } }>(
      h.fd.send('/shifts', { floatMinor: '0' }),
    );
    await h.at('2026-11-10T21:00:00Z');

    const started = await h.start();
    expect(started.status).toBe(202);
    let run = started.body as Run;
    expect(run).toMatchObject({ businessDate: TODAY, status: 'FAILED', currentStep: 1 });
    expect(run.error).toMatch(/Step 1 has exceptions/);
    expect(h.step(run, 1)).toMatchObject({
      name: 'OPEN_SHIFTS',
      status: 'BLOCKED',
      exceptions: [{ type: 'SHIFT_OPEN', blocking: true, shiftId: shift.id }],
    });
    expect(h.step(run, 2).status).toBe('PENDING');
    // Steps 1–3 only look: the desk can still post while the cashier closes.
    expect(await h.day()).toMatchObject({ date: TODAY, status: 'OPEN', nightAuditId: run.id });
    expect((await h.auditor.get(`/night-audits/${run.id}`)).body).toMatchObject({
      id: run.id,
      status: 'FAILED',
    });

    // A second start for the same date points at the run.
    const again = await h.start();
    expect(again.status).toBe(409);
    expect(errorOf(again)).toMatchObject({
      code: 'AUDIT_IN_PROGRESS',
      details: { nightAuditId: run.id },
    });

    await h.ok(
      h.fd.send(`/shifts/${shift.id}/close`, {
        counts: [{ method: 'CASH', currency: 'NGN', countedMinor: '0' }],
      }),
    );
    run = await h.ok<Run>(h.resume(run.id));
    expect(run).toMatchObject({ status: 'COMPLETED', currentStep: 10, error: null });
    expect(run.steps.map((s) => s.status)).toEqual([
      'DONE',
      'DONE',
      'DONE',
      'DONE',
      'DONE',
      'DONE',
      'DONE',
      'DONE',
      'DONE',
      'DONE',
    ]);
    expect(h.step(run, 2)).toMatchObject({
      result: { unarrived: 1, dueOut: 0 },
      exceptions: [{ type: 'UNARRIVED', blocking: false, stayId: bola.id }],
    });
    expect(h.step(run, 4).result).toMatchObject({
      stays: 1,
      postedNow: 1,
      postedTotal: 1,
      roomRevenueNowMinor: '10000000',
    });

    // Room and its taxes on the audited date (10% service, 7.5% VAT, 5% consumption).
    const folio = await h.folio();
    const [room] = h.roomLines(folio);
    expect(room).toMatchObject({
      businessDate: TODAY,
      description: 'Room 101, night of 2026-11-10',
      amountMinor: '10000000',
    });
    const taxes = folio.windows[0]?.lines.filter((l) => l.parentLineId === room?.id);
    expect(taxes?.map((t) => t.amountMinor).sort()).toEqual(['1000000', '500000', '825000']);
    expect(folio.balanceMinor).toBe('12325000');

    // The day is closed and the next is open; a new posting goes on it.
    expect(await h.day()).toMatchObject({ date: '2026-11-11', status: 'OPEN', nightAuditId: null });
    const posted = await h.ok<{ lines: { businessDate: string }[] }>(
      h.charge({ revenueCode: 'ROOM', description: 'Late check-out', unitAmountMinor: '100000' }),
    );
    expect(posted.lines[0]?.businessDate).toBe('2026-11-11');
    const closed = await db.businessDay.findFirstOrThrow({
      where: { propertyId: h.p1.id, date: new Date(`${TODAY}T00:00:00Z`) },
    });
    expect(closed).toMatchObject({ status: 'CLOSED' });
    expect(closed.closedById).not.toBeNull();

    // The finished run can't be started or resumed again; 11 Nov can't be audited on 10 Nov.
    expect(errorOf(await h.start()).code).toBe('AUDIT_IN_PROGRESS');
    expect(errorOf(await h.resume(run.id)).code).toBe('STATE_TRANSITION_INVALID');
    const early = await h.start('2026-11-11');
    expect(early.status).toBe(409);
    expect(errorOf(early).message).toMatch(/has not started yet/);
  });

  it('resumes where it stopped (step 4 mid-way, then step 6) and posts every night once', async () => {
    const h = await hotel();
    const folioB = await h.checkIn(await h.book('Bola'));
    await h.at('2026-11-10T21:00:00Z');

    // A crash after the first stay's night: step 4 fails, the day stays AUDITING.
    nightAuditFaults.at = (point) => {
      if (point === 'posting:1') throw new Error('power cut');
    };
    let run = (await h.start()).body as Run;
    expect(run).toMatchObject({ status: 'FAILED', currentStep: 4 });
    expect(h.step(run, 4)).toMatchObject({
      status: 'FAILED',
      exceptions: [{ type: 'ERROR', message: 'Step 4 stopped on an unexpected error' }],
    });
    expect(await h.day()).toMatchObject({ status: 'AUDITING' });
    expect(await db.roomChargePosting.count()).toBe(1);

    // The desk waits while the audit posts.
    const charge = await h.charge({
      revenueCode: 'ROOM',
      description: 'Extra bed',
      unitAmountMinor: '100000',
    });
    expect(charge.status).toBe(409);
    expect(errorOf(charge).code).toBe('AUDIT_IN_PROGRESS');

    // Resume: step 4 posts only the night still missing, then a crash at step 6.
    nightAuditFaults.at = (point) => {
      if (point === 'step:6') throw new Error('disk full');
    };
    run = await h.ok<Run>(h.resume(run.id));
    expect(run).toMatchObject({ status: 'FAILED', currentStep: 6 });
    expect(h.step(run, 4)).toMatchObject({
      status: 'DONE',
      result: { stays: 2, postedNow: 1, postedTotal: 2 },
    });
    expect(h.step(run, 6).status).toBe('FAILED');

    // Resume at step 6: it finishes, and each guest has exactly one night.
    nightAuditFaults.at = null;
    run = await h.ok<Run>(h.resume(run.id));
    expect(run).toMatchObject({ status: 'COMPLETED', currentStep: 10 });
    expect(h.step(run, 4).status).toBe('DONE');
    for (const folioId of [h.folioId, folioB]) {
      const folio = await h.folioOf(folioId);
      expect(h.roomLines(folio).map((l) => [l.businessDate, l.amountMinor])).toEqual([
        [TODAY, '10000000'],
      ]);
      expect(folio.balanceMinor).toBe('12325000');
    }
    expect(await db.roomChargePosting.count()).toBe(2);
    expect(await h.day()).toMatchObject({ date: '2026-11-11', status: 'OPEN' });
  });

  it('stops for guests past their departure until they leave', async () => {
    const h = await hotel();
    await h.at('2026-11-11T21:00:00Z');
    // Night of the 10th first (the day moves only with night audit).
    await h.ok(h.start());
    await h.at('2026-11-12T21:00:00Z');
    await h.ok(h.start('2026-11-11'));
    let run = (await h.start('2026-11-12')).body as Run;
    expect(run).toMatchObject({ status: 'FAILED', currentStep: 2 });
    expect(h.step(run, 2).exceptions).toEqual([
      expect.objectContaining({ type: 'DUE_OUT', blocking: true, stayId: h.stayId }),
    ]);
    // Two nights posted (10th and 11th), none for the departure day.
    expect(h.roomLines(await h.folio()).map((l) => l.businessDate)).toEqual([TODAY, '2026-11-11']);

    // Checking out (and closing the shift that took the money) resolves it.
    await h.settleAndLeave(h.stayId, h.folioId);
    run = await h.ok<Run>(h.resume(run.id));
    expect(run.status).toBe('COMPLETED');
  });

  it('posts package components to their codes and the rest to the room', async () => {
    const h = await hotel();
    const policy = await db.cancellationPolicy.findFirstOrThrow({
      where: { propertyId: h.p1.id },
    });
    const bb = await h.ok<{ id: string }>(
      h.gm.post('/rate-plans', {
        cancellationPolicyId: policy.id,
        code: 'BB',
        name: 'Bed and breakfast',
        kind: 'PACKAGE',
        parentRatePlanId: h.bar.id,
        derivationAmountMinor: '1000000',
        mealPlan: 'BREAKFAST',
      }),
    );
    const fnb = await db.revenueCode.findFirstOrThrow({
      where: { propertyId: h.p1.id, code: 'FNB' },
    });
    await h.ok(
      h.gm.post('/packages', {
        ratePlanId: bb.id,
        components: [
          { name: 'Breakfast', revenueCodeId: fnb.id, amountMinor: '500000', perPerson: true },
        ],
      }),
    );
    const folioB = await h.checkIn(await h.book('Bola', { ratePlanId: bb.id, adults: 2 }));
    await h.at('2026-11-10T21:00:00Z');
    const run = await h.ok<Run>(h.start());
    expect(run.status).toBe('COMPLETED');
    expect(h.step(run, 5).result).toMatchObject({ packageStays: 1, linesPosted: 1 });

    // ₦110,000 a night for two: breakfast 2 × ₦5,000 to FNB, ₦100,000 to the room.
    const lines = (await h.folioOf(folioB)).windows
      .flatMap((w) => w.lines)
      .filter((l) => l.kind === 'CHARGE');
    expect(lines.map((l) => [l.revenueCode, l.description, l.amountMinor]).sort()).toEqual([
      ['FNB', 'Breakfast, night of 2026-11-10', '1000000'],
      ['ROOM', 'Room 102, night of 2026-11-10', '10000000'],
    ]);
  });

  it('charges a day-use at check-in and never again at night audit', async () => {
    const h = await hotel();
    const policy = await db.cancellationPolicy.findFirstOrThrow({
      where: { propertyId: h.p1.id },
    });
    const plan = await h.ok<{ id: string }>(
      h.gm.post('/rate-plans', {
        cancellationPolicyId: policy.id,
        code: 'DAY',
        name: 'Day use',
        kind: 'DAY_USE',
        dayUseMaxMinutes: 360,
      }),
    );
    await h.ok(
      h.gm.put('/rate-calendar', {
        ratePlanId: plan.id,
        roomTypeIds: [h.type.id],
        from: TODAY,
        to: '2026-12-31',
        set: { amountMinor: '1500000' },
      }),
    );
    const sold = await h.ok<{ stays: { id: string; version: number }[] }>(
      h.fd.send('/day-use', {
        date: TODAY,
        start: '10:00',
        minutes: 240,
        roomTypeId: h.type.id,
        ratePlanId: plan.id,
        roomId: h.room102.id,
        adults: 1,
        booker: { firstName: 'Kemi', lastName: 'Ade', phone: '+2348011111111' },
      }),
    );
    const stay = sold.stays[0] as { id: string; version: number };
    await h.at('2026-11-10T09:30:00Z');
    const folioId = await h.checkIn(stay);
    const folio = await h.folioOf(folioId);
    expect(h.roomLines(folio).map((l) => [l.description, l.amountMinor])).toEqual([
      ['Day-use, room 102', '1500000'],
    ]);
    // Paid and gone before the night.
    await h.settleAndLeave(stay.id, folioId);

    await h.at('2026-11-10T21:00:00Z');
    const run = await h.ok<Run>(h.start());
    expect(run.status).toBe('COMPLETED');
    expect(h.step(run, 4).result).toMatchObject({ stays: 1, postedNow: 1, postedTotal: 2 });
    expect(h.roomLines(await h.folioOf(folioId))).toHaveLength(1);
  });

  it('keeps the business day until night audit, and only the auditor runs it on that day', async () => {
    const h = await hotel();
    await h.at('2026-11-12T09:00:00Z');
    expect(await h.day()).toMatchObject({ date: TODAY, status: 'OPEN', nightAuditId: null });
    expect((await h.fd.send('/night-audits', { businessDate: TODAY })).status).toBe(403);
    const wrong = await h.start('2026-11-09');
    expect(wrong.status).toBe(400);
    expect(errorOf(wrong).message).toBe(
      'Night audit runs for the current business date, 2026-11-10',
    );
    expect((await h.auditor.get('/night-audits/0d0d0d0d-0000-4000-8000-000000000002')).status).toBe(
      404,
    );
  });
});

describe('night audit, steps 6–9 (T-073b)', () => {
  const d = (date: string) => new Date(`${date}T00:00:00Z`);

  it('makes unarrived guests no-shows; guaranteed ones pay the fee, all give the rooms back', async () => {
    const h = await hotel();
    await h.ok(h.gm.post('/rooms', { number: '103', roomTypeId: h.type.id }));
    const bola = await h.book('Bola', { guarantee: 'CARD_ON_FILE' });
    const chi = await h.book('Chi');
    const sold = async () =>
      (
        await db.roomTypeInventory.findMany({
          where: { roomTypeId: h.type.id, date: { in: [d(TODAY), d('2026-11-11')] } },
          orderBy: { date: 'asc' },
        })
      ).map((r) => r.sold);
    expect(await sold()).toEqual([3, 3]);

    // A crash after the first no-show: resume finishes the rest, the first is not touched again.
    await h.at('2026-11-10T21:00:00Z');
    nightAuditFaults.at = (point) => {
      if (point === 'no-show:1') throw new Error('power cut');
    };
    let run = (await h.start()).body as Run;
    expect(run).toMatchObject({ status: 'FAILED', currentStep: 6 });
    nightAuditFaults.at = null;
    run = await h.ok<Run>(h.resume(run.id));
    expect(run.status).toBe('COMPLETED');
    expect(h.step(run, 6).result).toMatchObject({ noShowsNow: 1, noShowsTotal: 2 });

    const stays = await db.stay.findMany({
      where: { id: { in: [bola.id, chi.id] } },
      include: { reservation: true },
    });
    expect(stays.map((s) => [s.status, s.reservation.status, s.roomId])).toEqual([
      ['NO_SHOW', 'NO_SHOW', null],
      ['NO_SHOW', 'NO_SHOW', null],
    ]);
    expect(await sold()).toEqual([1, 1]);

    // Bola (guaranteed) owes the first night, untaxed, on a folio of her own; Chi owes nothing.
    const bolaStay = stays.find((s) => s.id === bola.id);
    const chiStay = stays.find((s) => s.id === chi.id);
    expect(chiStay?.folioId).toBeNull();
    const folio = await h.folioOf(bolaStay?.folioId ?? '');
    expect(
      folio.windows
        .flatMap((w) => w.lines)
        .map((l) => [l.kind, l.revenueCode, l.description, l.amountMinor, l.businessDate]),
    ).toEqual([['CHARGE', 'NOSHOW', 'No-show fee, arrival 2026-11-10', '10000000', TODAY]]);
    expect(folio.balanceMinor).toBe('10000000');
    const history = await db.reservationStatusHistory.findMany({
      where: { stayId: bola.id, toStatus: 'NO_SHOW' },
    });
    expect(history).toHaveLength(1);
  });

  it('locks the rates, raises the reversal pattern, keeps the reports, and balances day after day', async () => {
    const h = await hotel();
    const fin = await h.as(h.finance.id);
    await h.ok(
      fin.put(`/exchange-rates/${TODAY}`, { rates: [{ currency: 'USD', rate: '1580.50' }] }),
    );
    // A deposit on a booking for next week, and money on the in-house guest's folio.
    const later = await db.stay.findUniqueOrThrow({
      where: {
        id: (
          await h.book('Efe', {
            guarantee: 'DEPOSIT',
            arrival: '2026-11-20',
            departure: '2026-11-21',
          })
        ).id,
      },
    });
    const { shift } = await h.ok<{ shift: { id: string } }>(
      h.fd.send('/shifts', { floatMinor: '0' }),
    );
    await h.ok(
      h.fd.send('/payments', {
        reservationId: later.reservationId,
        method: 'CASH',
        amountMinor: '3000000',
      }),
    );
    await h.ok(
      h.fd.send('/payments', { folioId: h.folioId, method: 'CASH', amountMinor: '5000000' }),
    );
    await h.ok(
      h.fd.send('/payments', {
        folioId: h.folioId,
        method: 'POS_TERMINAL',
        amountMinor: '2000',
        currency: 'USD',
        externalRef: 'MPT-1',
      }),
    );
    // Four charges posted by the desk and reversed by the GM: a reversal pattern.
    for (const i of [1, 2, 3, 4]) {
      const posted = await h.ok<{ lines: { id: string }[] }>(
        h.charge({ revenueCode: 'MISC', description: `Water ${i}`, unitAmountMinor: '100000' }),
      );
      await h.ok(
        h.gm.send(`/folio-lines/${posted.lines[0]?.id}/reverse`, { reason: 'Wrong room' }),
      );
    }
    await h.ok(
      h.fd.send(`/shifts/${shift.id}/close`, {
        counts: [{ method: 'CASH', currency: 'NGN', countedMinor: '8000000' }],
      }),
    );

    await h.at('2026-11-10T21:00:00Z');
    const early = await h.auditor.get(
      '/night-audits/0d0d0d0d-0000-4000-8000-000000000002/reports/flash.pdf',
    );
    expect(early.status).toBe(404);
    let run = await h.ok<Run & { reports: string[] }>(h.start());
    expect(run.status).toBe('COMPLETED');
    expect(run.reports).toEqual([
      'flash',
      'trial-balance',
      'cashier',
      'high-balance',
      'discrepancy',
    ]);

    // Step 7: today's rate is locked.
    const rate = await db.exchangeRate.findFirstOrThrow({ where: { businessDate: d(TODAY) } });
    expect(rate.lockedAt).not.toBeNull();
    expect(h.step(run, 7).result).toMatchObject({ lockedNow: 1, rates: 1 });

    // Step 8: one alert for the GM's four reversals, listed for review.
    expect(h.step(run, 8)).toMatchObject({
      result: { raisedNow: 1, alerts: 1 },
      exceptions: [{ type: 'REVERSAL_PATTERN', blocking: false }],
    });
    const alert = await db.leakageAlert.findFirstOrThrow();
    expect(alert).toMatchObject({ ruleCode: 'REVERSAL_PATTERN', severity: 'NORMAL' });
    expect(alert.evidence).toMatchObject({ reversals: 4, totalMinor: '400000' });

    // Step 9: the figures are kept on the run.
    type Kept = {
      reports: {
        flash: Record<string, unknown>;
        trialBalance: Record<string, unknown>;
        highBalance: { folios: unknown[] };
      };
    };
    const kept = async (id: string) =>
      ((await db.nightAuditRun.findUniqueOrThrow({ where: { id } })).summary as Kept).reports;
    const day1 = await kept(run.id);
    const roomLines = await db.folioLine.aggregate({
      where: { businessDate: d(TODAY), revenueCode: { group: 'ROOM' } },
      _sum: { amountMinor: true },
    });
    expect(day1.flash).toMatchObject({
      roomsTotal: 2,
      roomsSold: 1,
      occupancyBps: 5000,
      roomRevenueMinor: String(roomLines._sum.amountMinor),
      adrMinor: '10000000',
      noShows: 0,
    });
    expect(day1.trialBalance).toMatchObject({
      paymentsMinor: String(3_000_000 + 5_000_000 + 3_161_000),
      depositLedgerClosingMinor: '-3000000',
      differenceMinor: '0',
      balanced: true,
      openingMatchesPreviousClose: null,
    });

    // The next day balances too, and opens where the first closed.
    await h.at('2026-11-11T21:00:00Z');
    run = await h.ok<Run & { reports: string[] }>(h.start('2026-11-11'));
    expect(run.status).toBe('COMPLETED');
    const day2 = await kept(run.id);
    expect(day2.trialBalance).toMatchObject({
      guestLedgerOpeningMinor: day1.trialBalance['guestLedgerClosingMinor'],
      balanced: true,
      openingMatchesPreviousClose: true,
    });

    // The PDFs, for report.audit only.
    const pdf = await h.auditor
      .get(`/night-audits/${run.id}/reports/trial-balance.pdf`)
      .buffer(true)
      .parse((res, done) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => done(null, Buffer.concat(chunks)));
      });
    expect(pdf.status).toBe(200);
    expect(pdf.headers['content-type']).toBe('application/pdf');
    expect((pdf.body as Buffer).subarray(0, 4).toString()).toBe('%PDF');
    expect((await h.fd.get(`/night-audits/${run.id}/reports/flash.pdf`)).status).toBe(403);
    expect((await h.auditor.get(`/night-audits/${run.id}/reports/nope.pdf`)).status).toBe(400);
  });
});
