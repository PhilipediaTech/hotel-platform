import { beforeEach, describe, expect, it } from 'vitest';
import { resetDb, testDb } from '../../../test/db.ts';
import { errorOf } from '../../../test/helpers.ts';
import { inHouse, TODAY } from '../../../test/in-house.ts';
import { raiseAlert } from '../leakage/engine.ts';

// Reports (PRD M12-01–M12-03, M12-06; M12 rules "reports for closed days read from the closed
// day's data and never change; definitions are documented on each report"; M12 AC "the flash
// report's room revenue equals the sum of room-revenue lines posted for that business date;
// ADR = room revenue ÷ rooms sold"; tab 4 Reports; S28; T-092).

const db = testDb();
let now: Date;
const clock = () => new Date(now);

beforeEach(async () => {
  await resetDb(db);
  now = new Date('2026-11-10T09:00:00Z');
});

const dbDate = (d: string) => new Date(`${d}T00:00:00Z`);

/** Ada Obi in house in 101 (₦100,000 a night); laundry posted; cash taken; the day audited. */
async function audited(options: { audit?: boolean } = {}) {
  const h = await inHouse(db, clock);
  await db.property.update({
    where: { id: h.p1.id },
    data: { settings: { paymentMethods: ['CASH', 'BANK_TRANSFER'] } },
  });
  const auditorId = (await h.person('night-auditor', h.p1.id)).id;
  await h.ok(h.fd.send('/shifts', { floatMinor: '0' }));
  await h.ok(h.charge({ revenueCode: 'MISC', description: 'Laundry', unitAmountMinor: '500000' }));
  await h.ok(h.fd.send('/payments', { folioId: h.folioId, method: 'CASH', amountMinor: '200000' }));
  const finance = await h.as(h.finance.id);
  const asAuditor = () => h.as(auditorId);
  if (options.audit !== false) {
    // The desk's shift closes and is signed off before the audit (open shifts block it).
    const shift = await db.cashierShift.findFirstOrThrow({ where: { userId: h.fdId } });
    await h.ok(
      h.fd.send(`/shifts/${shift.id}/close`, {
        counts: [{ method: 'CASH', currency: 'NGN', countedMinor: '200000' }],
      }),
    );
    now = new Date('2026-11-10T21:00:00Z');
    const run = await (await asAuditor()).send('/night-audits', { businessDate: TODAY });
    expect(run.status, JSON.stringify(run.body)).toBeLessThan(300);
  }
  const gm = await h.as(
    (await db.membership.findFirstOrThrow({ where: { roleId: h.role('gm') } })).userId,
  );
  return { ...h, auditorId, asAuditor, finance, gmClient: gm };
}

type Flash = {
  businessDate: string;
  nightAuditId: string;
  roomsSold: number;
  roomsAvailable: number;
  occupancyBps: number;
  roomRevenueMinor: string;
  adrMinor: string;
  revparMinor: string;
  definitions: string;
  paymentsByMethod: { method: string; count: number; amountMinor: string }[];
};

describe('closed-day reports (M12-02)', () => {
  it('the flash report is night audit’s kept figures; room revenue and ADR as the AC says', async () => {
    const h = await audited();
    const auditor = await h.asAuditor();
    const flash = await h.ok<Flash>(auditor.get('/reports/flash'));
    const run = await db.nightAuditRun.findFirstOrThrow({ where: { propertyId: h.p1.id } });
    expect(flash).toMatchObject({
      businessDate: TODAY,
      nightAuditId: run.id,
      roomsSold: 1,
      occupancyBps: 10_000,
      paymentsByMethod: [{ method: 'CASH', count: 1, amountMinor: '200000' }],
    });
    const roomLines = await db.folioLine.findMany({
      where: { propertyId: h.p1.id, businessDate: dbDate(TODAY), revenueCode: { group: 'ROOM' } },
    });
    const roomRevenue = roomLines.reduce((a, l) => a + l.amountMinor, 0n);
    expect(flash.roomRevenueMinor).toBe(roomRevenue.toString());
    expect(BigInt(flash.adrMinor)).toBe(roomRevenue / BigInt(flash.roomsSold));
    expect(flash.definitions).toMatch(/ADR = room revenue without day-use ÷ rooms sold/);

    // Never changes: a room charge posted after the day closed does not move its report.
    const fd = await h.as(h.fdId);
    await h.ok(
      fd.send(`/folios/${h.folioId}/lines`, {
        revenueCode: 'ROOM',
        description: 'Extra night',
        unitAmountMinor: '1000000',
      }),
    );
    expect((await h.ok<Flash>(auditor.get(`/reports/flash?date=${TODAY}`))).roomRevenueMinor).toBe(
      flash.roomRevenueMinor,
    );
  });

  it('trial balance and cashier summary of the closed day; a day without an audit is 404', async () => {
    const h = await audited();
    const auditor = await h.asAuditor();
    const trial = await h.ok<{ balanced: boolean; differenceMinor: string }>(
      auditor.get('/reports/trial-balance'),
    );
    expect(trial).toMatchObject({ balanced: true, differenceMinor: '0' });
    const cashier = await h.ok<{
      shifts: { payments: { method: string; amountMinor: string }[] }[];
    }>(auditor.get('/reports/cashier'));
    expect(cashier.shifts[0]?.payments).toEqual([
      { method: 'CASH', count: 1, amountMinor: '200000' },
    ]);
    const none = await auditor.get('/reports/flash?date=2026-11-01');
    expect(none.status).toBe(404);
    expect(errorOf(none).message).toBe('No night audit report for 2026-11-01');
  });

  it('before any night audit there is nothing to show', async () => {
    const h = await audited({ audit: false });
    expect((await h.gmClient.get('/reports/flash')).status).toBe(404);
  });
});

describe('export to CSV or PDF (M12-06)', () => {
  it('CSV with plain decimals and the definitions; PDF; each export audited', async () => {
    const h = await audited();
    const res = await h.gmClient.get('/reports/flash?format=csv');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/^text\/csv/);
    expect(res.headers['content-disposition']).toMatch(
      /attachment; filename="flash-P1-2026-11-10\.csv"/,
    );
    const text = res.text;
    expect(text.charCodeAt(0)).toBe(0xfeff);
    expect(text).toContain('Rooms sold,1\r\n');
    expect(text).toContain('CASH,1,2000.00\r\n');
    expect(text).toMatch(/Definitions,/);

    const pdf = await h.gmClient.get('/reports/trial-balance?format=pdf').buffer(true);
    expect(pdf.headers['content-type']).toBe('application/pdf');
    expect((pdf.body as Buffer).subarray(0, 4).toString()).toBe('%PDF');

    const tax = await h.gmClient.get(`/reports/tax?from=${TODAY}&to=${TODAY}&format=csv`);
    expect(tax.text).toContain('Authority,Tax,Rates %,Taxable,Tax amount,Lines');
    expect(await db.auditEvent.count({ where: { action: 'report.exported' } })).toBe(3);
  });

  it('needs report.export: the night auditor reads the report but cannot export it', async () => {
    const h = await audited();
    const auditor = await h.asAuditor();
    expect((await auditor.get('/reports/flash')).status).toBe(200);
    const csv = await auditor.get('/reports/flash?format=csv');
    expect(csv.status).toBe(403);
    expect(errorOf(csv).details).toEqual({ permission: 'report.export' });
    expect((await auditor.get('/reports/flash?format=xlsx')).status).toBe(400);
  });
});

describe('tax by authority and period (M12-03)', () => {
  it('sums tax lines of closed days by authority and rule, with what they were charged on', async () => {
    const h = await audited();
    // Posted on the next (open) day: not counted until that day closes.
    const fd = await h.as(h.fdId);
    await h.ok(
      fd.send(`/folios/${h.folioId}/lines`, {
        revenueCode: 'MISC',
        description: 'Late',
        unitAmountMinor: '100000',
      }),
    );
    const report = await h.ok<{
      through: string;
      authorities: {
        authority: string;
        taxMinor: string;
        rules: { name: string; ratesBps: number[]; taxableMinor: string; taxMinor: string }[];
      }[];
      totalTaxMinor: string;
    }>(h.gmClient.get(`/reports/tax?from=2026-11-01&to=2026-11-30`));
    expect(report.through).toBe(TODAY);

    const taxLines = await db.folioLine.findMany({
      where: {
        propertyId: h.p1.id,
        taxRuleVersionId: { not: null },
        businessDate: { lte: dbDate(TODAY) },
      },
      include: { taxRuleVersion: { include: { taxRule: true } }, parentLine: true },
    });
    expect(taxLines.length).toBeGreaterThan(0);
    expect(report.totalTaxMinor).toBe(taxLines.reduce((a, l) => a + l.amountMinor, 0n).toString());
    for (const a of report.authorities) {
      const mine = taxLines.filter((l) => l.taxRuleVersion?.taxRule.authority === a.authority);
      expect(a.taxMinor).toBe(mine.reduce((x, l) => x + l.amountMinor, 0n).toString());
      for (const rule of a.rules) {
        const lines = mine.filter((l) => l.taxRuleVersion?.taxRule.name === rule.name);
        const parents = new Map(
          lines.map((l) => [l.parentLineId, l.parentLine?.amountMinor ?? 0n]),
        );
        expect(rule.taxableMinor).toBe(
          [...parents.values()].reduce((x, v) => x + v, 0n).toString(),
        );
        expect(rule.ratesBps).toEqual([...new Set(lines.map((l) => l.taxRuleVersion?.rateBps))]);
      }
    }
  });

  it('a reversed charge takes its tax back out; the period is checked', async () => {
    const h = await audited({ audit: false });
    const posted = await h.ok<{ lines: { id: string; kind: string }[] }>(
      h.charge({ revenueCode: 'MISC', description: 'Wrong', unitAmountMinor: '300000' }),
    );
    const charge = posted.lines.find((l) => l.kind === 'CHARGE');
    await h.ok(
      h.gmClient.send(`/folio-lines/${charge?.id ?? ''}/reverse`, { reason: 'Wrong room' }),
    );
    const shift = await db.cashierShift.findFirstOrThrow({ where: { userId: h.fdId } });
    await h.ok(
      h.fd.send(`/shifts/${shift.id}/close`, {
        counts: [{ method: 'CASH', currency: 'NGN', countedMinor: '200000' }],
      }),
    );
    now = new Date('2026-11-10T21:00:00Z');
    await h.ok((await h.asAuditor()).send('/night-audits', { businessDate: TODAY }));
    const gm = await h.as(
      (await db.membership.findFirstOrThrow({ where: { roleId: h.role('gm') } })).userId,
    );
    const withReversal = await h.ok<{ totalTaxMinor: string }>(
      gm.get(`/reports/tax?from=${TODAY}&to=${TODAY}`),
    );
    const net = await db.folioLine.aggregate({
      where: { propertyId: h.p1.id, taxRuleVersionId: { not: null } },
      _sum: { amountMinor: true },
    });
    expect(withReversal.totalTaxMinor).toBe((net._sum.amountMinor ?? 0n).toString());

    expect((await gm.get('/reports/tax?from=2026-11-10&to=2026-11-01')).status).toBe(400);
    const tooLong = await gm.get('/reports/tax?from=2025-01-01&to=2026-11-10');
    expect(errorOf(tooLong).message).toBe('A tax report covers at most a year');
  });
});

describe('dashboard (M12-01)', () => {
  it('today live, month to date from the kept days, balances and alerts', async () => {
    const h = await audited();
    await raiseAlert(db, {
      propertyId: h.p1.id,
      organisationId: h.org.id,
      ruleCode: 'OCCUPIED_NO_FOLIO',
      businessDate: '2026-11-11',
      severity: 'HIGH',
      entityType: 'room',
      entityId: h.p1.id,
      evidence: {},
      dedupeKey: 'test:dash',
    });
    const d = await h.ok<{
      businessDate: string;
      today: { roomsOccupied: number; revenueMinor: string };
      monthToDate: {
        days: number;
        through: string;
        roomsSold: number;
        roomRevenueMinor: string;
        adrMinor: string;
      };
      balances: { guestLedgerMinor: string; openFolios: number };
      alerts: { open: number; byRule: { rule: string; open: number }[] };
      definitions: string;
    }>(h.gmClient.get('/reports/dashboard'));
    expect(d.businessDate).toBe('2026-11-11');
    expect(d.today).toMatchObject({ roomsOccupied: 1, revenueMinor: '0' });
    const flash = await h.ok<Flash>(h.gmClient.get('/reports/flash'));
    expect(d.monthToDate).toMatchObject({
      days: 1,
      through: TODAY,
      roomsSold: 1,
      roomRevenueMinor: flash.roomRevenueMinor,
      adrMinor: flash.adrMinor,
    });
    const lines = await db.folioLine.aggregate({
      where: { propertyId: h.p1.id },
      _sum: { amountMinor: true },
    });
    const paid = await db.payment.aggregate({
      where: { propertyId: h.p1.id },
      _sum: { baseAmountMinor: true },
    });
    expect(d.balances).toMatchObject({
      guestLedgerMinor: (
        (lines._sum.amountMinor ?? 0n) - (paid._sum.baseAmountMinor ?? 0n)
      ).toString(),
      openFolios: 1,
    });
    expect(d.alerts).toEqual({ open: 1, byRule: [{ rule: 'Occupied without folio', open: 1 }] });
    expect(d.definitions).toMatch(/Month to date: closed days/);
    // Needs report.dashboard: the front desk is refused.
    expect((await (await h.as(h.fdId)).get('/reports/dashboard')).status).toBe(403);
  });
});
