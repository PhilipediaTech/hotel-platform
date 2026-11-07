import {
  LEAKAGE_ALERT_LABELS,
  type CashierReport,
  type DashboardReport,
  type FlashReport,
  type TaxReport,
  type TrialBalanceReport,
} from '@hotel/shared';
import type { z } from 'zod';
import type { Property } from '../../generated/prisma/client.ts';
import { recordAudit } from '../../core/audit.ts';
import { businessDay } from '../../core/business-day.ts';
import type { Clock } from '../../core/clock.ts';
import type { Db } from '../../core/db.ts';
import { AppError } from '../../core/errors.ts';
import { exportFile, type ExportFile } from '../../core/exports.ts';
import type { TenantContext } from '../../core/tenancy.ts';
import type { TenantDb } from '../../core/tenant-db.ts';
import { ledgers, reportPdf, type AuditReports } from '../nightaudit/reports.ts';
import { roomsAvailable } from '../owner/service.ts';
import * as out from './exports.ts';

// Reports (PRD M12-01–M12-03, M12-06; M12 rules: closed days read from the closed day's data
// and never change, definitions on each report, times in the property's time zone; tab 4
// Reports; S28; T-092). Flash, trial balance and cashier are night audit's kept snapshot
// (step 9); the dashboard's month to date adds up those snapshots; the tax report reads tax
// lines of closed days only, so none of them moves once shown.

export interface ReportDeps {
  db: Db;
  tenantDb: TenantDb;
  clock: Clock;
}

type Format = 'json' | 'csv' | 'pdf';
type Dashboard = z.infer<typeof DashboardReport>;
type Flash = z.infer<typeof FlashReport>;
type Trial = z.infer<typeof TrialBalanceReport>;
type Cashier = z.infer<typeof CashierReport>;
type Tax = z.infer<typeof TaxReport>;

const dbDate = (date: string) => new Date(`${date}T00:00:00Z`);
const day = (d: Date) => d.toISOString().slice(0, 10);
const s = (n: bigint) => n.toString();
const sum = (xs: bigint[]) => xs.reduce((a, b) => a + b, 0n);
const NOT_REVENUE = ['DEPOSIT', 'TRANSFER'];

export const DEFINITIONS = {
  flash:
    'Rooms sold: overnight room nights night audit posted for the date. Room revenue: every room-revenue line of the date (charges, discounts, reversals), day-use included. ADR = room revenue without day-use ÷ rooms sold; RevPAR = the same ÷ rooms available; occupancy = rooms sold ÷ rooms available. Rooms available leave out rooms out of order or service, or blocked. Amounts before tax, in the base currency.',
  trialBalance:
    'Charges − payments − company account transfers = change in guest ledger + change in deposit ledger. The guest ledger is every folio’s balance; the deposit ledger counts advance deposits held as owed to guests (negative).',
  cashier:
    'Each cashier’s shift with payments on the date: what was taken by method, and at close what was expected, counted and the difference.',
  dashboard:
    'Today: the open business day, live (occupancy = rooms with a guest in house for the night ÷ rooms available; revenue = the day’s charges without deposits and folio transfers). Month to date: closed days of this month as night audit kept them (ADR = room revenue without day-use ÷ rooms sold). Balances: now.',
  tax: 'Tax lines posted on closed business days of the period, by authority and rule. Taxable = the amounts the tax was charged on (charges less discounts and reversals); a rate change in the period shows both rates.',
} as const;

/** Night audit's kept reports for a closed day (default: the last one kept). */
async function keptRun(deps: ReportDeps, date: string | undefined) {
  const runs = await deps.tenantDb.nightAuditRun.findMany({
    where: date ? { businessDate: dbDate(date) } : {},
    orderBy: { businessDate: 'desc' },
    take: date ? 1 : 10,
  });
  for (const run of runs) {
    const reports = (run.summary as { reports?: AuditReports } | null)?.reports;
    if (reports) return { run, reports, date: day(run.businessDate) };
  }
  throw new AppError(
    'NOT_FOUND',
    date ? `No night audit report for ${date}` : 'No night audit has kept a report yet',
  );
}

async function property(deps: ReportDeps, tenant: TenantContext): Promise<Property> {
  return deps.tenantDb.property.findUniqueOrThrow({ where: { id: tenant.propertyId } });
}

/** Exports are audited (who took which figures out, and when). */
async function issued(
  deps: ReportDeps,
  name: string,
  format: Format,
  after: Record<string, unknown>,
): Promise<void> {
  await recordAudit(deps.tenantDb, {
    action: 'report.exported',
    entityType: 'report',
    entityId: name,
    after: { format, ...after },
  });
}

// ── Closed-day reports (M12-02) ──────────────────────────────────────────────────────────

export async function flash(
  deps: ReportDeps,
  tenant: TenantContext,
  q: { date?: string | undefined; format: Format },
): Promise<Flash | ExportFile> {
  const { run, reports, date } = await keptRun(deps, q.date);
  const p = await property(deps, tenant);
  const report: Flash = {
    businessDate: date,
    nightAuditId: run.id,
    currency: p.baseCurrency,
    definitions: DEFINITIONS.flash,
    ...reports.flash,
  };
  if (q.format === 'json') return report;
  await issued(deps, 'flash', q.format, { businessDate: date });
  return q.format === 'pdf'
    ? pdfOf(await reportPdf(p, date, 'flash', reports))
    : exportFile(`flash-${p.code}-${date}.csv`, 'text/csv', out.flashCsv(report));
}

export async function trialBalance(
  deps: ReportDeps,
  tenant: TenantContext,
  q: { date?: string | undefined; format: Format },
): Promise<Trial | ExportFile> {
  const { run, reports, date } = await keptRun(deps, q.date);
  const p = await property(deps, tenant);
  const report: Trial = {
    businessDate: date,
    nightAuditId: run.id,
    currency: p.baseCurrency,
    definitions: DEFINITIONS.trialBalance,
    ...reports.trialBalance,
  };
  if (q.format === 'json') return report;
  await issued(deps, 'trial-balance', q.format, { businessDate: date });
  return q.format === 'pdf'
    ? pdfOf(await reportPdf(p, date, 'trial-balance', reports))
    : exportFile(`trial-balance-${p.code}-${date}.csv`, 'text/csv', out.trialCsv(report));
}

export async function cashier(
  deps: ReportDeps,
  tenant: TenantContext,
  q: { date?: string | undefined; format: Format },
): Promise<Cashier | ExportFile> {
  const { run, reports, date } = await keptRun(deps, q.date);
  const p = await property(deps, tenant);
  const report: Cashier = {
    businessDate: date,
    nightAuditId: run.id,
    currency: p.baseCurrency,
    definitions: DEFINITIONS.cashier,
    shifts: reports.cashier.shifts,
  };
  if (q.format === 'json') return report;
  await issued(deps, 'cashier', q.format, { businessDate: date });
  return q.format === 'pdf'
    ? pdfOf(await reportPdf(p, date, 'cashier', reports))
    : exportFile(`cashier-${p.code}-${date}.csv`, 'text/csv', out.cashierCsv(report));
}

function pdfOf(pdf: { filename: string; content: Uint8Array }): ExportFile {
  return exportFile(pdf.filename, 'application/pdf', pdf.content);
}

// ── Dashboard (M12-01) ───────────────────────────────────────────────────────────────────

function addUp<T extends { amountMinor: string }>(
  rows: T[],
  key: (row: T) => string,
  count?: (row: T) => number,
) {
  const m = new Map<string, { amount: bigint; count: number }>();
  for (const r of rows) {
    const e = m.get(key(r)) ?? { amount: 0n, count: 0 };
    m.set(key(r), { amount: e.amount + BigInt(r.amountMinor), count: e.count + (count?.(r) ?? 0) });
  }
  return [...m.entries()].sort(([a], [b]) => a.localeCompare(b));
}

export async function dashboard(
  deps: ReportDeps,
  tenant: TenantContext,
  q: { format: Format },
): Promise<Dashboard | ExportFile> {
  const p = await property(deps, tenant);
  const today = (await businessDay(deps.db, p.id, deps.clock)).date;
  const on = dbDate(today);
  const monthStart = `${today.slice(0, 8)}01`;
  const db = deps.tenantDb;
  const [available, occupied, lines, payments, runs, ledger, openFolios, alerts] =
    await Promise.all([
      roomsAvailable(deps.db, p.id, today),
      db.stay.count({
        where: {
          status: 'CHECKED_IN',
          isDayUse: false,
          arrival: { lte: on },
          departure: { gt: on },
        },
      }),
      db.folioLine.findMany({
        where: { businessDate: on, revenueCode: { code: { notIn: NOT_REVENUE } } },
        select: { amountMinor: true, revenueCode: { select: { group: true } } },
      }),
      db.payment.findMany({
        where: { businessDate: on },
        select: { method: true, baseAmountMinor: true },
      }),
      db.nightAuditRun.findMany({
        where: { businessDate: { gte: dbDate(monthStart), lt: on } },
        orderBy: { businessDate: 'asc' },
        select: { businessDate: true, summary: true },
      }),
      ledgers(db, on),
      db.folio.count({ where: { status: 'OPEN' } }),
      db.leakageAlert.groupBy({ by: ['ruleCode'], where: { status: 'OPEN' }, _count: true }),
    ]);

  const kept = runs.flatMap((r) => {
    const f = (r.summary as { reports?: AuditReports } | null)?.reports?.flash;
    return f ? [{ date: day(r.businessDate), f }] : [];
  });
  const sold = kept.reduce((a, k) => a + k.f.roomsSold, 0);
  const availableNights = kept.reduce((a, k) => a + k.f.roomsAvailable, 0);
  const roomRevenue = sum(kept.map((k) => BigInt(k.f.roomRevenueMinor)));
  const nightRevenue = roomRevenue - sum(kept.map((k) => BigInt(k.f.dayUseRevenueMinor)));

  const report: Dashboard = {
    currency: p.baseCurrency,
    businessDate: today,
    today: {
      roomsAvailable: available,
      roomsOccupied: occupied,
      occupancyBps: available > 0 ? Math.round((occupied * 10_000) / available) : 0,
      revenueMinor: s(sum(lines.map((l) => l.amountMinor))),
      revenueByGroup: addUp(
        lines.map((l) => ({ group: l.revenueCode.group, amountMinor: s(l.amountMinor) })),
        (l) => l.group,
      ).map(([group, e]) => ({ group, amountMinor: s(e.amount) })),
      paymentsByMethod: addUp(
        payments.map((x) => ({ method: x.method, amountMinor: s(x.baseAmountMinor) })),
        (x) => x.method,
        () => 1,
      ).map(([method, e]) => ({ method, count: e.count, amountMinor: s(e.amount) })),
    },
    monthToDate: {
      from: monthStart,
      through: kept.at(-1)?.date ?? null,
      days: kept.length,
      roomsAvailable: availableNights,
      roomsSold: sold,
      occupancyBps: availableNights > 0 ? Math.round((sold * 10_000) / availableNights) : 0,
      roomRevenueMinor: s(roomRevenue),
      adrMinor: s(sold > 0 ? nightRevenue / BigInt(sold) : 0n),
      revparMinor: s(availableNights > 0 ? nightRevenue / BigInt(availableNights) : 0n),
      revenueByGroup: addUp(
        kept.flatMap((k) => k.f.revenueByGroup),
        (g) => g.group,
      ).map(([group, e]) => ({ group, amountMinor: s(e.amount) })),
      paymentsByMethod: addUp(
        kept.flatMap((k) => k.f.paymentsByMethod),
        (x) => x.method,
        (x) => x.count,
      ).map(([method, e]) => ({ method, count: e.count, amountMinor: s(e.amount) })),
    },
    balances: {
      guestLedgerMinor: s(ledger.guest),
      depositLedgerMinor: s(ledger.deposit),
      openFolios,
    },
    alerts: {
      open: alerts.reduce((a, g) => a + g._count, 0),
      byRule: alerts
        .map((g) => ({ rule: LEAKAGE_ALERT_LABELS[g.ruleCode] ?? g.ruleCode, open: g._count }))
        .sort((a, b) => a.rule.localeCompare(b.rule)),
    },
    definitions: DEFINITIONS.dashboard,
  };
  if (q.format === 'json') return report;
  await issued(deps, 'dashboard', q.format, { businessDate: today });
  return q.format === 'pdf'
    ? exportFile(
        `dashboard-${p.code}-${today}.pdf`,
        'application/pdf',
        await out.dashboardPdf(p, report),
      )
    : exportFile(`dashboard-${p.code}-${today}.csv`, 'text/csv', out.dashboardCsv(report));
}

// ── Tax (M12-03) ─────────────────────────────────────────────────────────────────────────

const MAX_TAX_DAYS = 366;

export async function tax(
  deps: ReportDeps,
  tenant: TenantContext,
  q: { from: string; to: string; format: Format },
): Promise<Tax | ExportFile> {
  if (q.to < q.from) {
    throw new AppError('VALIDATION_ERROR', 'The period ends before it starts', { field: 'to' });
  }
  if ((dbDate(q.to).getTime() - dbDate(q.from).getTime()) / 86_400_000 >= MAX_TAX_DAYS) {
    throw new AppError('VALIDATION_ERROR', 'A tax report covers at most a year', { field: 'to' });
  }
  const p = await property(deps, tenant);
  const lastClosed = await deps.tenantDb.businessDay.findFirst({
    where: { status: 'CLOSED', date: { lte: dbDate(q.to) } },
    orderBy: { date: 'desc' },
  });
  const through = lastClosed && day(lastClosed.date) >= q.from ? day(lastClosed.date) : null;
  const lines = through
    ? await deps.tenantDb.folioLine.findMany({
        where: {
          taxRuleVersionId: { not: null },
          businessDate: { gte: dbDate(q.from), lte: dbDate(through) },
        },
        select: {
          amountMinor: true,
          parentLineId: true,
          parentLine: { select: { amountMinor: true } },
          taxRuleVersion: {
            select: {
              rateBps: true,
              taxRule: { select: { id: true, name: true, authority: true } },
            },
          },
        },
      })
    : [];

  type Rule = {
    id: string;
    name: string;
    rates: Set<number>;
    taxable: bigint;
    tax: bigint;
    lines: number;
    parents: Set<string>;
  };
  const byAuthority = new Map<string, Map<string, Rule>>();
  for (const l of lines) {
    const v = l.taxRuleVersion;
    if (!v) continue;
    const rules = byAuthority.get(v.taxRule.authority) ?? new Map<string, Rule>();
    byAuthority.set(v.taxRule.authority, rules);
    const r = rules.get(v.taxRule.id) ?? {
      id: v.taxRule.id,
      name: v.taxRule.name,
      rates: new Set<number>(),
      taxable: 0n,
      tax: 0n,
      lines: 0,
      parents: new Set<string>(),
    };
    rules.set(v.taxRule.id, r);
    r.rates.add(v.rateBps);
    r.tax += l.amountMinor;
    r.lines += 1;
    // Each charged amount counts once per rule, however many tax lines it has.
    if (l.parentLineId && l.parentLine && !r.parents.has(l.parentLineId)) {
      r.parents.add(l.parentLineId);
      r.taxable += l.parentLine.amountMinor;
    }
  }
  const authorities = [...byAuthority.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([authority, rules]) => {
      const list = [...rules.values()].sort((a, b) => a.name.localeCompare(b.name));
      return {
        authority,
        taxMinor: s(sum(list.map((r) => r.tax))),
        rules: list.map((r) => ({
          taxRuleId: r.id,
          name: r.name,
          ratesBps: [...r.rates].sort((a, b) => a - b),
          taxableMinor: s(r.taxable),
          taxMinor: s(r.tax),
          lines: r.lines,
        })),
      };
    });
  const report: Tax = {
    from: q.from,
    through,
    currency: p.baseCurrency,
    authorities,
    totalTaxMinor: s(sum(authorities.map((a) => BigInt(a.taxMinor)))),
    definitions: DEFINITIONS.tax,
  };
  if (q.format === 'json') return report;
  await issued(deps, 'tax', q.format, { from: q.from, to: q.to });
  const name = `tax-${p.code}-${q.from}-to-${q.to}`;
  return q.format === 'pdf'
    ? exportFile(`${name}.pdf`, 'application/pdf', await out.taxPdf(p, report, q.to))
    : exportFile(`${name}.csv`, 'text/csv', out.taxCsv(report));
}
