import {
  localDate,
  toBaseMinor,
  type GroupCompanyDetail,
  type GroupCompanyItem,
} from '@hotel/shared';
import type { z } from 'zod';
import type { Clock } from '../../core/clock.ts';
import type { Db } from '../../core/db.ts';
import { AppError } from '../../core/errors.ts';
import { withoutTenant, type TenantContext } from '../../core/tenancy.ts';
import { groupCurrencyOf, propertiesWith, ratesFor } from '../reports/group.ts';
import { ACCOUNT_INCLUDE, itemOf } from './service.ts';

// Corporate accounts at group level (Versions V2; T-163). A company is the organisation's, but
// each property keeps its own city-ledger account and limit (M4-21). At group level: what the
// company owes across the properties, in the group currency at this month's group rates
// (T-161), against the company's own credit limit, which is the group limit. A transfer to the
// city ledger in any property that would take the group total past it goes for approval, as an
// over-limit transfer does (M4 rule). A balance in a currency with no rate this month can't be
// added up: the check then asks for approval rather than guess, and the view says which.

type ItemOut = z.input<typeof GroupCompanyItem>;
type DetailOut = z.input<typeof GroupCompanyDetail>;

const day = (d: Date) => d.toISOString().slice(0, 10);

interface Exposure {
  groupCurrency: string;
  groupLimitMinor: bigint | null;
  balance: bigint;
  overdue: bigint;
  missing: Set<string>;
  accounts: {
    propertyId: string;
    propertyName: string;
    currency: string;
    row: Awaited<ReturnType<typeof accountsOf>>[number];
    balance: bigint;
    overdue: bigint;
    inGroup: bigint | null;
    today: string;
  }[];
}

/** The company's accounts in every property of the organisation (or those listed). */
function accountsOf(db: Db, organisationId: string, companyId: string, propertyIds?: string[]) {
  // Several properties: outside this request's row-level security, naming the organisation.
  return withoutTenant(() =>
    db.arAccount.findMany({
      where: {
        organisationId,
        companyId,
        ...(propertyIds ? { propertyId: { in: propertyIds } } : {}),
      },
      include: { ...ACCOUNT_INCLUDE, property: true },
      orderBy: { createdAt: 'asc' },
    }),
  );
}

async function exposureOf(
  deps: { db: Db; clock: Clock },
  tenant: Pick<TenantContext, 'organisationId'>,
  companyId: string,
  propertyIds?: string[],
): Promise<
  Exposure & {
    companyName: string;
    companyKind: string;
    rates: Awaited<ReturnType<typeof ratesFor>>;
  }
> {
  const company = await deps.db.company.findFirst({
    where: { id: companyId, organisationId: tenant.organisationId },
  });
  if (!company) throw new AppError('NOT_FOUND', 'Company not found');
  const groupCurrency = await groupCurrencyOf(deps, tenant);
  const now = deps.clock();
  const rows = await accountsOf(deps.db, tenant.organisationId, companyId, propertyIds);
  // This month's rates, by the first account's calendar (the group's month).
  const month = localDate(now, rows[0]?.property.timeZone ?? 'Africa/Lagos').slice(0, 7);
  const rates = await ratesFor(deps, tenant, month, groupCurrency);
  const missing = new Set<string>();
  let balance = 0n;
  let overdue = 0n;
  const accounts = rows.map((row) => {
    const today = localDate(now, row.property.timeZone);
    const item = itemOf(row, today);
    const b = BigInt(item.balanceMinor);
    const o = BigInt(item.overdueMinor);
    const currency = row.property.baseCurrency;
    const rate = currency === groupCurrency ? 1_000_000n : rates.get(currency)?.rateMicros;
    let inGroup: bigint | null = null;
    if (rate === undefined) {
      if (b !== 0n) missing.add(currency);
    } else {
      inGroup = currency === groupCurrency ? b : toBaseMinor(b, rate);
      balance += inGroup;
      overdue += currency === groupCurrency ? o : toBaseMinor(o, rate);
    }
    return {
      propertyId: row.propertyId,
      propertyName: row.property.name,
      currency,
      row,
      balance: b,
      overdue: o,
      inGroup,
      today,
    };
  });
  return {
    companyName: company.name,
    companyKind: company.kind,
    groupCurrency,
    groupLimitMinor: company.creditLimitMinor,
    balance,
    overdue,
    missing,
    accounts,
    rates,
  };
}

const overOf = (e: Exposure) => e.groupLimitMinor !== null && e.balance > e.groupLimitMinor;

function exposureOut(e: Exposure) {
  return {
    groupCurrency: e.groupCurrency,
    groupLimitMinor: e.groupLimitMinor?.toString() ?? null,
    balanceMinor: e.balance.toString(),
    overdueMinor: e.overdue.toString(),
    overLimit: overOf(e),
    missingRates: [...e.missing].sort(),
  };
}

// ── The group's views ───────────────────────────────────────────────────────────────────

export async function listGroupCompanies(
  deps: { db: Db; clock: Clock },
  tenant: TenantContext,
): Promise<{ data: ItemOut[] }> {
  const properties = (await propertiesWith(deps, tenant, 'report.group')).map((p) => p.id);
  const companies = await withoutTenant(() =>
    deps.db.arAccount.findMany({
      where: { organisationId: tenant.organisationId, propertyId: { in: properties } },
      select: { companyId: true },
      distinct: ['companyId'],
    }),
  );
  const data: ItemOut[] = [];
  for (const { companyId } of companies) {
    const e = await exposureOf(deps, tenant, companyId, properties);
    data.push({
      companyId,
      name: e.companyName,
      kind: e.companyKind,
      properties: e.accounts.length,
      ...exposureOut(e),
    });
  }
  // Most owed first; then by name.
  data.sort(
    (a, b) =>
      Number(BigInt(b.balanceMinor) - BigInt(a.balanceMinor)) || a.name.localeCompare(b.name),
  );
  return { data };
}

export async function getGroupCompany(
  deps: { db: Db; clock: Clock },
  tenant: TenantContext,
  companyId: string,
): Promise<DetailOut> {
  const properties = (await propertiesWith(deps, tenant, 'report.group')).map((p) => p.id);
  const e = await exposureOf(deps, tenant, companyId, properties);
  if (e.accounts.length === 0) {
    throw new AppError('NOT_FOUND', 'This company has no account in your properties');
  }
  const openInvoices = e.accounts
    .flatMap((a) =>
      a.row.invoices.flatMap((inv) => {
        const left = inv.amountMinor - inv.allocations.reduce((s, x) => s + x.amountMinor, 0n);
        return left > 0n
          ? [
              {
                propertyName: a.propertyName,
                number: inv.number,
                currency: a.currency,
                openMinor: left.toString(),
                issuedOn: day(inv.issuedOn),
                dueOn: day(inv.dueOn),
                overdue: day(inv.dueOn) < a.today,
              },
            ]
          : [];
      }),
    )
    .sort((x, y) => x.dueOn.localeCompare(y.dueOn) || x.number.localeCompare(y.number));
  return {
    companyId,
    name: e.companyName,
    kind: e.companyKind,
    ...exposureOut(e),
    accounts: e.accounts.map((a) => ({
      propertyId: a.propertyId,
      propertyName: a.propertyName,
      accountId: a.row.id,
      currency: a.currency,
      status: a.row.status,
      creditLimitMinor: a.row.creditLimitMinor.toString(),
      balanceMinor: a.balance.toString(),
      overdueMinor: a.overdue.toString(),
      inGroupCurrencyMinor: a.inGroup?.toString() ?? null,
    })),
    openInvoices,
  };
}

// ── The check on a transfer ─────────────────────────────────────────────────────────────

/**
 * Whether adding `amountMinor` (in `currency`) to the company's city ledger takes it past its
 * group limit. Every property of the organisation counts, whoever is asking. Null when the
 * company has no group limit. A missing rate for an open balance (or for the transfer's own
 * currency) is treated as over: the transfer goes for approval with that reason.
 */
export async function groupLimitCheck(
  deps: { db: Db; clock: Clock },
  tenant: Pick<TenantContext, 'organisationId'>,
  companyId: string,
  currency: string,
  amountMinor: bigint,
): Promise<{ over: boolean; reason: string } | null> {
  const company = await deps.db.company.findFirst({
    where: { id: companyId, organisationId: tenant.organisationId },
    select: { creditLimitMinor: true },
  });
  if (company?.creditLimitMinor === null || company?.creditLimitMinor === undefined) return null;
  const e = await exposureOf(deps, tenant, companyId);
  let adding: bigint | null = amountMinor;
  if (currency !== e.groupCurrency) {
    const rate = e.rates.get(currency)?.rateMicros;
    adding = rate === undefined ? null : toBaseMinor(amountMinor, rate);
  }
  if (adding === null) e.missing.add(currency);
  if (e.missing.size > 0) {
    return {
      over: true,
      reason: `No group rate this month for ${[...e.missing].sort().join(', ')}: the group limit can’t be checked`,
    };
  }
  const total = e.balance + (adding ?? 0n);
  return { over: total > (e.groupLimitMinor ?? 0n), reason: 'Over the group credit limit' };
}
