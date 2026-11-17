import { beforeEach, describe, expect, it } from 'vitest';
import { resetDb, testDb } from '../../../test/db.ts';
import { inHouse, TODAY } from '../../../test/in-house.ts';
import { unmatchedTransferAlerts } from '../payments/webhooks.ts';

// Leakage Guard (PRD M6-07, M6-08, M6-09, M6 rule 3 and the AC "each leakage rule has a fixture
// that triggers it and one that does not; both pass"; QA "morning report marks a vacant room
// occupied → alert → owner records recovered amount"; tab 4 row "Leakage"; T-090).

const db = testDb();
let now: Date;
const clock = () => new Date(now);

beforeEach(async () => {
  await resetDb(db);
  now = new Date('2026-11-10T09:00:00Z');
});

type Alert = {
  id: string;
  ruleCode: string;
  rule: string | null;
  label: string;
  severity: string;
  status: string;
  subject: { id: string; name: string } | null;
  evidence: Record<string, unknown>;
  outcomes: number;
  recoveredMinor: string;
};
type Detail = Alert & {
  outcomeList: {
    outcome: string;
    recoveredMinor: string | null;
    linkedLine: { id: string; description: string } | null;
    linkedPayment: { id: string } | null;
    note: string;
    by: { name: string };
  }[];
};
type Rules = {
  currency: string;
  rules: {
    code: string;
    enabled: boolean;
    canDisable: boolean;
    notifyInstant: boolean;
    params: { key: string; value: string | number; default: string | number }[];
    open: number;
    reviewed: number;
    recoveredMinor: string;
  }[];
  totals: { open: number; reviewed: number; recoveredMinor: string };
};

/** Ada Obi in house in 101 (₦100,000 a night on BAR); a vacant room 102; cash and transfers on. */
async function hotel() {
  const h = await inHouse(db, clock);
  await db.property.update({
    where: { id: h.p1.id },
    data: { settings: { paymentMethods: ['CASH', 'BANK_TRANSFER'] } },
  });
  const type = await db.roomType.findFirstOrThrow({ where: { propertyId: h.p1.id } });
  const room102 = await h.ok<{ id: string }>(
    h.gm.post('/rooms', { number: '102', roomTypeId: type.id }),
  );
  const room101 = await db.room.findFirstOrThrow({ where: { propertyId: h.p1.id, number: '101' } });
  const auditorId = (await h.person('night-auditor', h.p1.id)).id;
  const supervisorId = (await h.person('hk-supervisor', h.p1.id)).id;
  const ownerId = h.owner.id;
  const gmId = (await db.membership.findFirstOrThrow({ where: { roleId: h.role('gm') } })).userId;
  const who = {
    fd: h.fd,
    gm: h.gm,
    auditor: await h.as(auditorId),
    supervisor: await h.as(supervisorId),
    owner: await h.as(ownerId),
  };
  /** Moves the clock; sessions end when idle, so everyone signs in again. */
  const at = async (instant: string) => {
    now = new Date(instant);
    who.fd = await h.as(h.fdId);
    who.gm = await h.as(gmId);
    who.auditor = await h.as(auditorId);
    who.supervisor = await h.as(supervisorId);
    who.owner = await h.as(ownerId);
  };
  const audit = async () => {
    await at('2026-11-10T21:00:00Z');
    const res = await who.auditor.send('/night-audits', { businessDate: TODAY });
    expect(res.status, JSON.stringify(res.body)).toBeLessThan(300);
    return res.body as {
      status: string;
      steps: { step: number; result: Record<string, number> }[];
    };
  };
  const alerts = async (query = '') =>
    (await h.ok<{ data: Alert[] }>(who.gm.get(`/leakage/alerts${query}`))).data;
  const rules = () => h.ok<Rules>(who.gm.get('/leakage/rules'));
  const setRule = (rule: Record<string, unknown>, as = who.gm) =>
    as.patch('/leakage/rules', { rules: [rule] });
  const reverse = async (n: number) => {
    for (let i = 1; i <= n; i += 1) {
      const posted = await h.ok<{ lines: { id: string }[] }>(
        h.charge({ revenueCode: 'MISC', description: `Water ${i}`, unitAmountMinor: '100000' }),
      );
      await h.ok(who.gm.send(`/folio-lines/${posted.lines[0]?.id}/reverse`, { reason: 'Wrong' }));
    }
  };
  return {
    ...h,
    who,
    at,
    audit,
    alerts,
    rules,
    setRule,
    reverse,
    room101: room101.id,
    room102: room102.id,
    auditorId,
    ownerId,
  };
}

describe('the five core rules: a fixture that triggers each, and one that does not', () => {
  it('occupied without folio: a vacant room reported occupied, not an occupied one', async () => {
    const h = await hotel();
    const sent = await h.ok<{ alertsRaised: number }>(
      h.who.supervisor.send('/housekeeping/status-reports', {
        entries: [
          { roomId: h.room101, observed: 'OCCUPIED' }, // Ada is in house: no alert
          { roomId: h.room102, observed: 'OCCUPIED' }, // nobody checked in: alert
        ],
      }),
    );
    expect(sent.alertsRaised).toBe(1);
    const [alert] = await h.alerts();
    expect(alert).toMatchObject({
      ruleCode: 'OCCUPIED_NO_FOLIO',
      rule: 'OCCUPIED_NO_FOLIO',
      label: 'Occupied without folio',
      severity: 'HIGH',
      status: 'OPEN',
      evidence: { roomNumber: '102', observed: 'OCCUPIED', frontOffice: 'VACANT' },
    });
    const event = await db.domainEvent.findFirstOrThrow({
      where: { type: 'leakage.alert_raised' },
    });
    expect(event.payload).toMatchObject({
      alertId: alert?.id,
      rule: 'OCCUPIED_NO_FOLIO',
      notify: 'FLASH',
    });
  });

  it('rate override: a night posted below the floor without approval; at the floor or approved, none', async () => {
    const h = await hotel();
    // BAR sells Ada's night at ₦100,000; its floor is now ₦120,000.
    await db.ratePlan.updateMany({
      where: { propertyId: h.p1.id, code: 'BAR' },
      data: { floorMinor: 12_000_000n },
    });
    const run = await h.audit();
    expect(run.status).toBe('COMPLETED');
    expect(run.steps.find((s) => s.step === 8)?.result).toMatchObject({ raisedNow: 1 });
    const [alert] = await h.alerts('?rule=RATE_OVERRIDE');
    expect(alert).toMatchObject({
      ruleCode: 'RATE_OVERRIDE',
      severity: 'NORMAL',
      evidence: {
        room: '101',
        night: TODAY,
        ratePlan: 'BAR',
        amountMinor: '10000000',
        floorMinor: '12000000',
      },
    });
    expect(alert?.subject?.id).toBe(h.fdId); // who booked it
  });

  it('rate override: nothing at the floor, and nothing with an approved below-floor request', async () => {
    const h = await hotel();
    await db.ratePlan.updateMany({
      where: { propertyId: h.p1.id, code: 'BAR' },
      data: { floorMinor: 10_000_000n },
    });
    const run = await h.audit();
    expect(run.steps.find((s) => s.step === 8)?.result).toMatchObject({ raisedNow: 0 });

    // The next night is below a raised floor, but a manager approved it for the stay.
    await db.ratePlan.updateMany({
      where: { propertyId: h.p1.id, code: 'BAR' },
      data: { floorMinor: 20_000_000n },
    });
    await db.approvalRequest.create({
      data: {
        organisationId: h.org.id,
        propertyId: h.p1.id,
        action: 'rate.below_floor',
        payload: { stayId: h.stayId },
        payloadHash: 'x',
        reason: 'Long-standing guest',
        requestedById: h.fdId,
        status: 'APPROVED',
        decidedById: h.ownerId,
        decidedAt: now,
        expiresAt: new Date('2026-12-31T00:00:00Z'),
      },
    });
    await h.at('2026-11-11T21:00:00Z');
    const next = await h.who.auditor.send('/night-audits', { businessDate: '2026-11-11' });
    expect(next.status, JSON.stringify(next.body)).toBeLessThan(300);
    expect(await h.alerts()).toEqual([]);
  });

  it('void/reversal pattern: more than the threshold per user and shift; at it, none', async () => {
    const h = await hotel();
    expect(
      await h.ok(h.setRule({ code: 'REVERSAL_PATTERN', params: { maxCount: 1 } })),
    ).toBeTruthy();
    await h.reverse(2);
    await h.audit();
    const [alert] = await h.alerts();
    expect(alert).toMatchObject({
      ruleCode: 'REVERSAL_PATTERN',
      evidence: { reversals: 2, limits: { count: 1, amountMinor: '5000000' } },
    });
  });

  it('void/reversal pattern: one reversal under a threshold of one raises nothing', async () => {
    const h = await hotel();
    await h.ok(h.setRule({ code: 'REVERSAL_PATTERN', params: { maxCount: 1 } }));
    await h.reverse(1);
    await h.audit();
    expect(await h.alerts()).toEqual([]);
  });

  it('cash variance: above the rule’s tolerance raises one; within it, none', async () => {
    const h = await hotel();
    const close = async (countedMinor: string) => {
      const { shift } = await h.ok<{ shift: { id: string } }>(
        h.who.fd.send('/shifts', { floatMinor: '0' }),
      );
      return h.ok<{ status: string }>(
        h.who.fd.send(`/shifts/${shift.id}/close`, {
          counts: [{ method: 'CASH', currency: 'NGN', countedMinor }],
          varianceNote: 'Counted twice',
        }),
      );
    };
    // ₦2,000 over with the default ₦500 tolerance: an alert, and the shift waits for sign-off.
    expect((await close('200000')).status).toBe('CLOSING');
    expect((await h.alerts()).map((a) => a.ruleCode)).toEqual(['SHIFT_VARIANCE']);
    // The tolerance is now ₦5,000: the same variance closes the shift and raises nothing.
    await h.ok(h.setRule({ code: 'SHIFT_VARIANCE', params: { toleranceMinor: '500000' } }));
    await db.cashierShift.updateMany({ where: { status: 'CLOSING' }, data: { status: 'CLOSED' } });
    expect((await close('200000')).status).toBe('CLOSED');
    expect(await h.alerts()).toHaveLength(1);
  });

  it('unmatched transfer: a bank transfer typed in at the desk, once its hours have passed', async () => {
    const h = await hotel();
    await h.ok(h.who.fd.send('/shifts', { floatMinor: '0' }));
    await h.ok(
      h.who.fd.send('/payments', {
        folioId: h.folioId,
        method: 'BANK_TRANSFER',
        amountMinor: '5000000',
        externalRef: 'GTB-778',
      }),
    );
    const paid = await db.payment.findFirstOrThrow({ where: { externalRef: 'GTB-778' } });
    // A cash payment never counts.
    await h.ok(
      h.who.fd.send('/payments', { folioId: h.folioId, method: 'CASH', amountMinor: '10000' }),
    );
    now = new Date('2026-11-11T08:59:00Z'); // 23 h 59 min on: not yet
    expect(await unmatchedTransferAlerts(db, clock)).toBe(0);
    now = new Date('2026-11-11T09:01:00Z');
    expect(await unmatchedTransferAlerts(db, clock)).toBe(1);
    expect(await unmatchedTransferAlerts(db, clock)).toBe(0);
    const alert = await db.leakageAlert.findFirstOrThrow();
    expect(alert).toMatchObject({
      ruleCode: 'UNMATCHED_TRANSFER',
      severity: 'NORMAL',
      entityType: 'payment',
      entityId: paid.id,
      subjectUserId: h.fdId,
    });
    expect(alert.evidence).toMatchObject({
      source: 'MANUAL',
      reference: 'GTB-778',
      amountMinor: '5000000',
    });
  });

  it('unmatched transfer: nothing before the property’s hours, nothing when switched off', async () => {
    const h = await hotel();
    await h.ok(h.setRule({ code: 'UNMATCHED_TRANSFER', params: { hours: 48 } }));
    await h.ok(h.who.fd.send('/shifts', { floatMinor: '0' }));
    await h.ok(
      h.who.fd.send('/payments', {
        folioId: h.folioId,
        method: 'BANK_TRANSFER',
        amountMinor: '5000000',
        externalRef: 'GTB-779',
      }),
    );
    now = new Date('2026-11-11T10:00:00Z');
    expect(await unmatchedTransferAlerts(db, clock)).toBe(0);
    await h.at('2026-11-11T10:00:00Z');
    await h.ok(h.setRule({ code: 'UNMATCHED_TRANSFER', enabled: false }));
    now = new Date('2026-11-12T10:00:00Z');
    expect(await unmatchedTransferAlerts(db, clock)).toBe(0);
  });
});

describe('reviewing alerts (M6-08, M6 rule 3)', () => {
  /** A vacant room reported occupied, and the stay billed for it afterwards. */
  async function withAlert() {
    const h = await hotel();
    await h.ok(
      h.who.supervisor.send('/housekeeping/status-reports', {
        entries: [{ roomId: h.room102, observed: 'OCCUPIED' }],
      }),
    );
    const [alert] = await h.alerts();
    const billed = await h.ok<{ lines: { id: string }[] }>(
      h.charge({
        revenueCode: 'ROOM',
        description: 'Day-use, room 102',
        unitAmountMinor: '2500000',
      }),
    );
    return { ...h, alert: alert as Alert, lineId: billed.lines[0]?.id ?? '' };
  }

  it('records a recovered amount linked to the charge; the alert is reviewed and the total counts it', async () => {
    const h = await withAlert();
    const res = await h.who.owner.send(`/leakage/alerts/${h.alert.id}/outcomes`, {
      outcome: 'RECOVERED',
      recoveredMinor: '2500000',
      linkedLineId: h.lineId,
      note: 'Room 102 day-use billed after review',
    });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body).toMatchObject({ alertId: h.alert.id, status: 'REVIEWED' });

    // A second outcome is added, never an edit.
    now = new Date('2026-11-10T09:05:00Z');
    await h.ok(
      h.who.gm.send(`/leakage/alerts/${h.alert.id}/outcomes`, {
        outcome: 'ACTION_TAKEN',
        note: 'Spoke to the night porter',
      }),
    );
    const detail = await h.ok<Detail>(h.who.gm.get(`/leakage/alerts/${h.alert.id}`));
    expect(detail).toMatchObject({ status: 'REVIEWED', outcomes: 2, recoveredMinor: '2500000' });
    expect(
      detail.outcomeList.map((o) => [o.outcome, o.recoveredMinor, o.linkedLine?.id ?? null]),
    ).toEqual([
      ['RECOVERED', '2500000', h.lineId],
      ['ACTION_TAKEN', null, null],
    ]);
    expect(detail.outcomeList[0]?.linkedLine?.description).toBe('Day-use, room 102');

    const rules = await h.rules();
    expect(rules.currency).toBe('NGN');
    expect(rules.rules.find((r) => r.code === 'OCCUPIED_NO_FOLIO')).toMatchObject({
      open: 0,
      reviewed: 1,
      recoveredMinor: '2500000',
    });
    expect(rules.totals).toEqual({ open: 0, reviewed: 1, recoveredMinor: '2500000' });
    expect(await h.alerts('?status=OPEN')).toEqual([]);
    expect(await h.alerts('?status=REVIEWED')).toHaveLength(1);
    const audit = await db.auditEvent.findMany({ where: { action: 'leakage.outcome_added' } });
    expect(audit).toHaveLength(2);
  });

  it('refuses a recovery without a link, above the charge, twice from one charge, or with a payment that is not one', async () => {
    const h = await withAlert();
    const add = (body: object) => h.who.gm.send(`/leakage/alerts/${h.alert.id}/outcomes`, body);
    const code = async (body: object) => {
      const res = await add(body);
      return [res.status, (res.body as { error?: { code: string } }).error?.code];
    };
    expect(await code({ outcome: 'RECOVERED', recoveredMinor: '100', note: 'x' })).toEqual([
      400,
      'VALIDATION_ERROR',
    ]);
    expect(
      await code({
        outcome: 'EXPLAINED',
        recoveredMinor: '100',
        linkedLineId: h.lineId,
        note: 'x',
      }),
    ).toEqual([400, 'VALIDATION_ERROR']);
    expect(
      await code({
        outcome: 'RECOVERED',
        recoveredMinor: '2500001',
        linkedLineId: h.lineId,
        note: 'x',
      }),
    ).toEqual([400, 'VALIDATION_ERROR']);
    expect(
      await code({
        outcome: 'RECOVERED',
        recoveredMinor: '100',
        linkedPaymentId: h.lineId, // a line's ID is not a payment
        note: 'x',
      }),
    ).toEqual([400, 'VALIDATION_ERROR']);
    expect(await code({ outcome: 'EXPLAINED', note: '   ' })).toEqual([400, 'VALIDATION_ERROR']);
    await h.ok(
      add({ outcome: 'RECOVERED', recoveredMinor: '100', linkedLineId: h.lineId, note: 'x' }),
    );
    expect(
      await code({
        outcome: 'RECOVERED',
        recoveredMinor: '100',
        linkedLineId: h.lineId,
        note: 'y',
      }),
    ).toEqual([400, 'VALIDATION_ERROR']);
    expect(await code({ outcome: 'EXPLAINED', note: 'x' }).then((c) => c[0])).toBe(201);
  });

  it('the person an alert is about cannot review it', async () => {
    const h = await hotel();
    await h.ok(h.setRule({ code: 'REVERSAL_PATTERN', params: { maxCount: 0 } }));
    await h.reverse(1); // reversed by the GM
    await h.audit();
    const [alert] = await h.alerts();
    expect(alert?.subject?.name).toBeTruthy();
    const own = await h.who.gm.send(`/leakage/alerts/${alert?.id}/outcomes`, {
      outcome: 'EXPLAINED',
      note: 'My own mistake',
    });
    expect(own.status).toBe(403);
    const owner = await h.who.owner.send(`/leakage/alerts/${alert?.id}/outcomes`, {
      outcome: 'FALSE_POSITIVE',
      note: 'Training day',
    });
    expect(owner.status).toBe(201);
  });

  it('the database keeps alerts and outcomes as they were written', async () => {
    const h = await withAlert();
    await h.ok(
      h.who.gm.send(`/leakage/alerts/${h.alert.id}/outcomes`, { outcome: 'EXPLAINED', note: 'x' }),
    );
    await expect(
      db.leakageAlert.update({ where: { id: h.alert.id }, data: { evidence: {} } }),
    ).rejects.toThrow(/LEAKAGE_ALERT_IMMUTABLE/);
    await expect(
      db.leakageAlert.update({ where: { id: h.alert.id }, data: { status: 'OPEN' } }),
    ).rejects.toThrow(/LEAKAGE_ALERT_IMMUTABLE/);
    await expect(db.leakageAlert.delete({ where: { id: h.alert.id } })).rejects.toThrow(
      /LEAKAGE_ALERT_IMMUTABLE/,
    );
    await expect(db.alertOutcome.updateMany({ data: { note: 'edited' } })).rejects.toThrow(
      /append-only/,
    );
    await expect(db.alertOutcome.deleteMany()).rejects.toThrow(/append-only/);
    // A recovery without a link is refused by the database too.
    await expect(
      db.alertOutcome.create({
        data: {
          alertId: h.alert.id,
          outcome: 'RECOVERED',
          recoveredMinor: 100n,
          note: 'x',
          byUserId: h.ownerId,
        },
      }),
    ).rejects.toThrow(/alert_outcomes_recovered/);
  });

  it('pages and filters the list, and only leakage reviewers see it', async () => {
    const h = await hotel();
    await h.ok(
      h.who.supervisor.send('/housekeeping/status-reports', {
        entries: [{ roomId: h.room102, observed: 'OCCUPIED' }],
      }),
    );
    await h.ok(h.setRule({ code: 'REVERSAL_PATTERN', params: { maxCount: 0 } }));
    await h.reverse(1);
    await h.audit();
    const first = await h.ok<{ data: Alert[]; nextCursor: string | null }>(
      h.who.gm.get('/leakage/alerts?limit=1'),
    );
    expect(first.data.map((a) => a.ruleCode)).toEqual(['REVERSAL_PATTERN']);
    const second = await h.ok<{ data: Alert[]; nextCursor: string | null }>(
      h.who.gm.get(`/leakage/alerts?limit=1&cursor=${first.nextCursor}`),
    );
    expect(second.data.map((a) => a.ruleCode)).toEqual(['OCCUPIED_NO_FOLIO']);
    expect(second.nextCursor).toBeNull();
    expect((await h.alerts('?rule=OCCUPIED_NO_FOLIO')).map((a) => a.ruleCode)).toEqual([
      'OCCUPIED_NO_FOLIO',
    ]);
    expect(await h.alerts(`?from=2026-11-11`)).toEqual([]);

    expect((await h.who.fd.get('/leakage/alerts')).status).toBe(403);
    expect((await h.who.auditor.get(`/leakage/alerts/${first.data[0]?.id}`)).status).toBe(403);
    expect((await h.who.fd.get('/leakage/rules')).status).toBe(403);
    expect(
      (await h.who.gm.get('/leakage/alerts/0d0d0d0d-0000-4000-8000-000000000002')).status,
    ).toBe(404);
  });
});

describe('rule settings (M6-07, M6-09)', () => {
  it('lists the rules with their defaults', async () => {
    const h = await hotel();
    const { rules } = await h.rules();
    expect(rules.map((r) => [r.code, r.enabled, r.canDisable, r.notifyInstant])).toEqual([
      ['OCCUPIED_NO_FOLIO', true, false, false],
      ['RATE_OVERRIDE', true, true, false],
      ['REVERSAL_PATTERN', true, true, false],
      ['SHIFT_VARIANCE', true, false, false],
      ['UNMATCHED_TRANSFER', true, true, false],
      ['VISITOR_OVERSTAY', true, true, false],
      ['FUEL_VARIANCE', true, true, false],
    ]);
    expect(rules.find((r) => r.code === 'VISITOR_OVERSTAY')?.params).toEqual([
      expect.objectContaining({ key: 'cutoffHour', value: 23, default: 23 }),
    ]);
    expect(rules.find((r) => r.code === 'REVERSAL_PATTERN')?.params).toEqual([
      expect.objectContaining({ key: 'maxCount', value: 3, default: 3 }),
      expect.objectContaining({ key: 'maxAmountMinor', value: '5000000', default: '5000000' }),
    ]);
    // The tolerance set on the property before T-090 still shows.
    await db.property.update({
      where: { id: h.p1.id },
      data: { settings: { shiftVarianceToleranceMinor: '100000' } },
    });
    expect((await h.rules()).rules.find((r) => r.code === 'SHIFT_VARIANCE')?.params[0]?.value).toBe(
      '100000',
    );
  });

  it('changes thresholds and instant alerts, refuses what may not change, and audits it', async () => {
    const h = await hotel();
    const changed = await h.ok<Rules>(
      h.setRule({ code: 'RATE_OVERRIDE', notifyInstant: true, enabled: false }),
    );
    expect(changed.rules.find((r) => r.code === 'RATE_OVERRIDE')).toMatchObject({
      enabled: false,
      notifyInstant: true,
    });
    const bad = async (rule: Record<string, unknown>) => {
      const res = await h.setRule(rule);
      return [res.status, (res.body as { error?: { code: string } }).error?.code];
    };
    expect(await bad({ code: 'SHIFT_VARIANCE', enabled: false })).toEqual([
      400,
      'VALIDATION_ERROR',
    ]);
    expect(await bad({ code: 'REVERSAL_PATTERN', params: { maxCount: -1 } })).toEqual([
      400,
      'VALIDATION_ERROR',
    ]);
    expect(await bad({ code: 'REVERSAL_PATTERN', params: { maxAmountMinor: '1.5' } })).toEqual([
      400,
      'VALIDATION_ERROR',
    ]);
    expect(await bad({ code: 'UNMATCHED_TRANSFER', params: { days: 2 } })).toEqual([
      400,
      'VALIDATION_ERROR',
    ]);
    expect(await bad({ code: 'NO_SUCH_RULE' })).toEqual([400, 'VALIDATION_ERROR']);
    expect(await db.auditEvent.count({ where: { action: 'leakage.rule_changed' } })).toBe(1);

    // Instant alerts need leakage.notify: a role with review only may change thresholds alone.
    const reviewer = await db.role.create({
      data: {
        organisationId: h.org.id,
        name: 'Reviewer',
        permissions: ['leakage.review'],
      },
    });
    const person = await h.person('front-desk', h.p1.id);
    await db.membership.updateMany({
      where: { userId: person.id },
      data: { roleId: reviewer.id },
    });
    const only = await h.as(person.id);
    expect(
      (await h.setRule({ code: 'UNMATCHED_TRANSFER', notifyInstant: true }, only)).status,
    ).toBe(403);
    expect(
      (await h.setRule({ code: 'UNMATCHED_TRANSFER', params: { hours: 12 } }, only)).status,
    ).toBe(200);
  });

  it('an instant rule says so on the event; a rule switched off raises nothing', async () => {
    const h = await hotel();
    await h.ok(h.setRule({ code: 'OCCUPIED_NO_FOLIO', notifyInstant: true }));
    await h.ok(h.setRule({ code: 'REVERSAL_PATTERN', enabled: false, params: { maxCount: 0 } }));
    await h.ok(
      h.who.supervisor.send('/housekeeping/status-reports', {
        entries: [{ roomId: h.room102, observed: 'OCCUPIED' }],
      }),
    );
    const event = await db.domainEvent.findFirstOrThrow({
      where: { type: 'leakage.alert_raised' },
    });
    expect(event.payload).toMatchObject({ rule: 'OCCUPIED_NO_FOLIO', notify: 'INSTANT' });
    await h.reverse(2);
    await h.audit();
    expect((await h.alerts()).map((a) => a.ruleCode)).toEqual(['OCCUPIED_NO_FOLIO']);
  });
});
