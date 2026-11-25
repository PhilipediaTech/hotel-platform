import {
  microsToRate,
  rateToMicros,
  toBaseMinor,
  type GroupDashboard,
  type GroupRates,
  type GroupRatesBody,
} from '@hotel/shared';
import type { z } from 'zod';
import { recordAudit } from '../../core/audit.ts';
import { businessDay } from '../../core/business-day.ts';
import { AppError } from '../../core/errors.ts';
import { withoutTenant, type TenantContext } from '../../core/tenancy.ts';
import type { AuditReports } from '../nightaudit/reports.ts';
import type { ReportDeps } from './service.ts';

// Group dashboards (PRD M1-13, M12-07; S46 /group; T-161). The owner's view across properties:
// a month's closed days from night audit's kept figures (as the dashboard's month to date),
// each property in its own currency, and the group's totals in the group currency. A property
// in another currency joins the money totals with the month's group rate the owner set; with
// none it stays out of them and its currency is listed as missing, so a total never rests on
// a guessed rate. Rooms and occupancy need no rate and always count every property.

type DashboardOut = z.input<typeof GroupDashboard>;
type RatesOut = z.input<typeof GroupRates>;

const DEFINITIONS =
  'Closed days of the month, from what night audit kept for each day. Rooms sold: overnight room nights. Room revenue: room-revenue lines before tax, day-use included. Revenue: every revenue line before tax. ADR = room revenue without day-use ÷ rooms sold; RevPAR = the same ÷ rooms available; occupancy = rooms sold ÷ rooms available. A property in another currency is converted at the month’s group rate (group currency per one unit), set by the owner; without a rate its money is left out of the group totals.';

const s = (n: bigint) => n.toString();
const sum = (xs: bigint[]) => xs.reduce((a, b) => a + b, 0n);
const day = (d: Date) => d.toISOString().slice(0, 10);
const monthStart = (month: string) => new Date(`${month}-01T00:00:00Z`);
const nextMonth = (month: string) => {
  const d = monthStart(month);
  d.setUTCMonth(d.getUTCMonth() + 1);
  return d;
};
const iso = (d: Date) => d.toISOString().replace(/\.\d{3}Z$/, 'Z');

/**
 * The properties whose group figures the caller sees: every one of the organisation when they
 * hold report.group organisation-wide, else those they hold it for. Archived ones are left out.
 */
async function groupProperties(deps: ReportDeps, tenant: TenantContext) {
  const memberships = await deps.db.membership.findMany({
    where: {
      userId: tenant.userId,
      organisationId: tenant.organisationId,
      active: true,
      role: { permissions: { has: 'report.group' } },
    },
    select: { propertyId: true },
  });
  const orgWide = memberships.some((m) => m.propertyId === null);
  const ids = memberships.flatMap((m) => (m.propertyId ? [m.propertyId] : []));
  return deps.db.property.findMany({
    where: {
      organisationId: tenant.organisationId,
      status: { not: 'ARCHIVED' },
      ...(orgWide ? {} : { id: { in: ids } }),
    },
    orderBy: [{ createdAt: 'asc' }, { name: 'asc' }],
  });
}

/** The group currency: the organisation's choice, else its first property's. */
async function groupCurrencyOf(deps: ReportDeps, tenant: TenantContext): Promise<string> {
  const org = await deps.db.organisation.findUniqueOrThrow({
    where: { id: tenant.organisationId },
  });
  if (org.groupCurrency) return org.groupCurrency;
  const first = await deps.db.property.findFirst({
    where: { organisationId: tenant.organisationId },
    orderBy: { createdAt: 'asc' },
  });
  return first?.baseCurrency ?? 'NGN';
}

async function ratesFor(deps: ReportDeps, tenant: TenantContext, month: string, to: string) {
  const rows = await deps.db.groupExchangeRate.findMany({
    where: { organisationId: tenant.organisationId, toCurrency: to, month: monthStart(month) },
    include: { setBy: { select: { name: true } } },
  });
  return new Map(rows.map((r) => [r.fromCurrency, r]));
}

// ── The dashboard ───────────────────────────────────────────────────────────────────────

export async function groupDashboard(
  deps: ReportDeps,
  tenant: TenantContext,
  q: { month?: string | undefined },
): Promise<DashboardOut> {
  const month =
    q.month ?? (await businessDay(deps.db, tenant.propertyId, deps.clock)).date.slice(0, 7);
  const properties = await groupProperties(deps, tenant);
  const groupCurrency = await groupCurrencyOf(deps, tenant);
  const rates = await ratesFor(deps, tenant, month, groupCurrency);
  // Several properties: read outside this request's property (row-level security would show
  // only it), limited to the group's own properties above.
  const runs = await withoutTenant(() =>
    deps.db.nightAuditRun.findMany({
      where: {
        propertyId: { in: properties.map((p) => p.id) },
        businessDate: { gte: monthStart(month), lt: nextMonth(month) },
      },
      orderBy: { businessDate: 'asc' },
      select: { propertyId: true, businessDate: true, summary: true },
    }),
  );

  const missing = new Set<string>();
  let converted = 0;
  const money = { room: 0n, night: 0n, revenue: 0n, sold: 0, available: 0 };
  const all = { sold: 0, available: 0 };
  const rows = properties.map((p) => {
    const kept = runs.flatMap((r) => {
      if (r.propertyId !== p.id) return [];
      const f = (r.summary as { reports?: AuditReports } | null)?.reports?.flash;
      return f ? [{ date: day(r.businessDate), f }] : [];
    });
    const sold = kept.reduce((a, k) => a + k.f.roomsSold, 0);
    const available = kept.reduce((a, k) => a + k.f.roomsAvailable, 0);
    const room = sum(kept.map((k) => BigInt(k.f.roomRevenueMinor)));
    const night = room - sum(kept.map((k) => BigInt(k.f.dayUseRevenueMinor)));
    const revenue = sum(
      kept.flatMap((k) =>
        k.f.revenueByGroup.filter((g) => g.group !== 'TAX').map((g) => BigInt(g.amountMinor)),
      ),
    );
    all.sold += sold;
    all.available += available;

    const same = p.baseCurrency === groupCurrency;
    const rate = same ? 1_000_000n : (rates.get(p.baseCurrency)?.rateMicros ?? null);
    if (rate === null && kept.length > 0) missing.add(p.baseCurrency);
    const inGroup = (minor: bigint) => (same ? minor : toBaseMinor(minor, rate ?? 0n));
    let inGroupCurrency: DashboardOut['properties'][number]['inGroupCurrency'] = null;
    if (rate !== null) {
      const g = { room: inGroup(room), night: inGroup(night), revenue: inGroup(revenue) };
      inGroupCurrency = {
        roomRevenueMinor: s(g.room),
        revenueMinor: s(g.revenue),
        adrMinor: s(sold > 0 ? g.night / BigInt(sold) : 0n),
        revparMinor: s(available > 0 ? g.night / BigInt(available) : 0n),
      };
      converted += 1;
      money.room += g.room;
      money.night += g.night;
      money.revenue += g.revenue;
      money.sold += sold;
      money.available += available;
    }
    return {
      propertyId: p.id,
      code: p.code,
      name: p.name,
      currency: p.baseCurrency,
      days: kept.length,
      through: kept.at(-1)?.date ?? null,
      roomsAvailable: available,
      roomsSold: sold,
      occupancyBps: available > 0 ? Math.round((sold * 10_000) / available) : 0,
      roomRevenueMinor: s(room),
      revenueMinor: s(revenue),
      adrMinor: s(sold > 0 ? night / BigInt(sold) : 0n),
      revparMinor: s(available > 0 ? night / BigInt(available) : 0n),
      rate: rate === null ? null : microsToRate(rate),
      inGroupCurrency,
    };
  });

  return {
    month,
    groupCurrency,
    properties: rows,
    totals: {
      roomsAvailable: all.available,
      roomsSold: all.sold,
      occupancyBps: all.available > 0 ? Math.round((all.sold * 10_000) / all.available) : 0,
      roomRevenueMinor: s(money.room),
      revenueMinor: s(money.revenue),
      adrMinor: s(money.sold > 0 ? money.night / BigInt(money.sold) : 0n),
      revparMinor: s(money.available > 0 ? money.night / BigInt(money.available) : 0n),
      propertiesInMoneyTotals: converted,
    },
    missingRates: [...missing].sort(),
    definitions: DEFINITIONS,
  };
}

// ── Group rates ─────────────────────────────────────────────────────────────────────────

async function ratesOut(deps: ReportDeps, tenant: TenantContext, month: string): Promise<RatesOut> {
  const groupCurrency = await groupCurrencyOf(deps, tenant);
  const properties = await groupProperties(deps, tenant);
  const currencies = [...new Set(properties.map((p) => p.baseCurrency))]
    .filter((c) => c !== groupCurrency)
    .sort();
  const rates = await ratesFor(deps, tenant, month, groupCurrency);
  return {
    month,
    groupCurrency,
    rates: currencies.map((currency) => {
      const r = rates.get(currency);
      return {
        currency,
        rate: r ? microsToRate(r.rateMicros) : null,
        setBy: r?.setBy.name ?? null,
        setAt: r ? iso(r.setAt) : null,
      };
    }),
  };
}

export const getGroupRates = (deps: ReportDeps, tenant: TenantContext, month: string) =>
  ratesOut(deps, tenant, month);

export async function putGroupRates(
  deps: ReportDeps,
  tenant: TenantContext,
  body: z.output<typeof GroupRatesBody>,
): Promise<RatesOut> {
  const properties = await groupProperties(deps, tenant);
  const used = new Set(properties.map((p) => p.baseCurrency));
  const issues: { path: string; code: string; message: string }[] = [];
  body.rates.forEach((r, i) => {
    if (r.currency === body.groupCurrency) {
      issues.push({
        path: `body.rates.${i}.currency`,
        code: 'custom',
        message: 'The group currency needs no rate',
      });
    } else if (!used.has(r.currency)) {
      issues.push({
        path: `body.rates.${i}.currency`,
        code: 'custom',
        message: 'No property of the group keeps its books in this currency',
      });
    }
  });
  if (issues.length > 0) {
    throw new AppError('VALIDATION_ERROR', 'Request validation failed.', { issues });
  }
  const now = deps.clock();
  const before = await ratesOut(deps, tenant, body.month);
  await deps.db.$transaction(async (tx) => {
    await tx.organisation.update({
      where: { id: tenant.organisationId },
      data: { groupCurrency: body.groupCurrency },
    });
    for (const r of body.rates) {
      const key = {
        organisationId: tenant.organisationId,
        fromCurrency: r.currency,
        toCurrency: body.groupCurrency,
        month: monthStart(body.month),
      };
      const data = { rateMicros: rateToMicros(r.rate), setById: tenant.userId, setAt: now };
      await tx.groupExchangeRate.upsert({
        where: { organisationId_fromCurrency_toCurrency_month: key },
        create: { ...key, ...data },
        update: data,
      });
    }
    await recordAudit(tx, {
      organisationId: tenant.organisationId,
      propertyId: null,
      action: 'group.rates_set',
      entityType: 'organisation',
      entityId: tenant.organisationId,
      before: { groupCurrency: before.groupCurrency },
      after: {
        month: body.month,
        groupCurrency: body.groupCurrency,
        rates: body.rates.map((r) => `${r.currency} ${r.rate}`),
      },
    });
  });
  return ratesOut(deps, tenant, body.month);
}
