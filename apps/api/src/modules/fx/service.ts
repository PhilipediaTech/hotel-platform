import {
  microsToRate,
  rateToMicros,
  type ExchangeRates,
  type ExchangeRatesBody,
} from '@hotel/shared';
import type { z } from 'zod';
import type { Prisma } from '../../generated/prisma/client.ts';
import { recordAudit } from '../../core/audit.ts';
import { businessDate } from '../../core/business-day.ts';
import type { Clock } from '../../core/clock.ts';
import { raisedBy, type Db } from '../../core/db.ts';
import { AppError } from '../../core/errors.ts';
import type { TenantContext } from '../../core/tenancy.ts';
import type { TenantDb } from '../../core/tenant-db.ts';

// Exchange rates (PRD M4-18, M4 rule 6; tab 4 GET/PUT /exchange-rates/{date}; S25; T-065).
// One rate per currency per business date: base currency for one unit, in millionths. A date
// without its own rate uses the latest earlier one. Rates are set for the business date or
// later; night audit locks the day's rates (T-073) and a locked rate never changes (trigger).

export interface FxDeps {
  db: Db;
  tenantDb: TenantDb;
  clock: Clock;
}

type Tx = Parameters<Parameters<TenantDb['$transaction']>[0]>[0];
type Client = Tx | TenantDb;

const day = (d: Date) => d.toISOString().slice(0, 10);
const dbDate = (date: string) => new Date(`${date}T00:00:00Z`);

/** The rate in force for `currency` on `date`, or null when none was ever set. */
export async function rateFor(db: Client, currency: string, date: string) {
  return db.exchangeRate.findFirst({
    where: { currency, businessDate: { lte: dbDate(date) } },
    orderBy: { businessDate: 'desc' },
  });
}

export async function getExchangeRates(
  deps: FxDeps,
  tenant: TenantContext,
  date: string,
): Promise<z.input<typeof ExchangeRates>> {
  const db = deps.tenantDb;
  const [property, today, rows] = await Promise.all([
    db.property.findUniqueOrThrow({ where: { id: tenant.propertyId } }),
    businessDate(db, tenant.propertyId, deps.clock),
    db.exchangeRate.findMany({
      where: { businessDate: { lte: dbDate(date) } },
      orderBy: [{ currency: 'asc' }, { businessDate: 'desc' }],
      include: { setBy: { select: { name: true } } },
    }),
  ]);
  // The latest row per currency.
  const latest = rows.filter((r, i) => i === 0 || rows[i - 1]?.currency !== r.currency);
  return {
    date,
    baseCurrency: property.baseCurrency,
    businessDate: today,
    rates: latest.map((r) => ({
      currency: r.currency,
      rate: microsToRate(r.rateMicros),
      setFor: day(r.businessDate),
      setBy: r.setBy.name,
      lockedAt: r.lockedAt ? r.lockedAt.toISOString().replace(/\.\d{3}Z$/, 'Z') : null,
    })),
  };
}

export async function putExchangeRates(
  deps: FxDeps,
  tenant: TenantContext,
  date: string,
  body: z.output<typeof ExchangeRatesBody>,
) {
  const db = deps.tenantDb;
  const property = await db.property.findUniqueOrThrow({ where: { id: tenant.propertyId } });
  const today = await businessDate(db, tenant.propertyId, deps.clock);
  if (date < today) {
    throw new AppError('STATE_TRANSITION_INVALID', 'Rates are set for the business date or later', {
      businessDate: today,
    });
  }
  const base = body.rates.findIndex((r) => r.currency === property.baseCurrency);
  if (base >= 0) {
    const message = `${property.baseCurrency} is the base currency`;
    throw new AppError('VALIDATION_ERROR', message, {
      issues: [{ path: `body.rates.${base}.currency`, code: 'custom', message }],
    });
  }
  try {
    await db.$transaction(async (tx) => {
      for (const r of body.rates) {
        const key = {
          propertyId_currency_businessDate: {
            propertyId: tenant.propertyId,
            currency: r.currency,
            businessDate: dbDate(date),
          },
        };
        const before = await tx.exchangeRate.findUnique({ where: key });
        const rateMicros = rateToMicros(r.rate);
        await tx.exchangeRate.upsert({
          where: key,
          update: { rateMicros, setById: tenant.userId },
          create: {
            currency: r.currency,
            businessDate: dbDate(date),
            rateMicros,
            setById: tenant.userId,
          } as unknown as Prisma.ExchangeRateUncheckedCreateInput, // tenant IDs come from the client
        });
        await recordAudit(tx, {
          action: 'fx.rate_set',
          entityType: 'exchange_rate',
          entityId: `${r.currency}:${date}`,
          before: before ? { rate: microsToRate(before.rateMicros) } : null,
          after: { rate: r.rate },
        });
      }
    });
  } catch (err) {
    if (raisedBy(err, 'EXCHANGE_RATE_LOCKED')) {
      throw new AppError('STATE_TRANSITION_INVALID', 'Night audit has locked this day’s rates');
    }
    throw err;
  }
  return getExchangeRates(deps, tenant, date);
}
