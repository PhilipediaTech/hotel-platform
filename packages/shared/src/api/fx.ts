import { z } from 'zod';
import { defineRoute } from './contract.ts';
import { Instant, IsoDate } from './primitives.ts';

// Exchange rates (PRD M4-18, M4 rule 6; tab 4 row "Tax and FX" GET/PUT /exchange-rates/{date};
// S25 Exchange rates tab; T-065). Finance sets what one unit of a foreign currency is worth in
// the base currency for a business date; a foreign payment uses the business date's rate, or
// the latest earlier one. Night audit locks the day's rates (T-073); a locked rate never
// changes.

/** "1580.5" → naira per US dollar; up to 6 decimals. */
export const RateText = z
  .string()
  .regex(/^(0|[1-9]\d{0,11})(\.\d{1,6})?$/, 'A rate like 1580.50')
  .refine((v) => Number(v) > 0, 'Must be more than zero')
  .meta({ id: 'Rate', example: '1580.5' });

export const ExchangeRateItem = z
  .object({
    currency: z.string(),
    /** Base currency per one unit of `currency`. */
    rate: RateText,
    /** The business date the rate was set for (an earlier one when carried forward). */
    setFor: IsoDate,
    setBy: z.string(),
    lockedAt: Instant.nullable(),
  })
  .meta({ id: 'ExchangeRate' });

export const ExchangeRates = z
  .object({
    date: IsoDate,
    baseCurrency: z.string(),
    businessDate: IsoDate,
    /** Rates in force on `date`: set for it, or carried from the latest earlier date. */
    rates: z.array(ExchangeRateItem),
  })
  .meta({ id: 'ExchangeRates' });

const DateParams = z.object({ date: IsoDate });

export const ExchangeRatesBody = z.object({
  rates: z
    .array(z.object({ currency: z.string().regex(/^[A-Z]{3}$/), rate: RateText }))
    .min(1)
    .max(20)
    .refine((r) => new Set(r.map((x) => x.currency)).size === r.length, {
      message: 'One rate per currency',
    }),
});

export const getExchangeRates = defineRoute({
  operationId: 'getExchangeRates',
  method: 'get',
  path: '/exchange-rates/{date}',
  summary: 'Exchange rates in force on a date',
  tags: ['Tax and FX'],
  propertyScoped: true,
  permission: 'folio.read',
  params: DateParams,
  response: ExchangeRates,
});

export const putExchangeRates = defineRoute({
  operationId: 'putExchangeRates',
  method: 'put',
  path: '/exchange-rates/{date}',
  summary: 'Set exchange rates for a business date (today or later)',
  description:
    'Sets or replaces the listed currencies’ rates for the date; others stay. 409 STATE_TRANSITION_INVALID for a date before the business date or a rate night audit has locked.',
  tags: ['Tax and FX'],
  propertyScoped: true,
  permission: 'fx.manage',
  params: DateParams,
  body: ExchangeRatesBody,
  response: ExchangeRates,
  errors: ['STATE_TRANSITION_INVALID'],
});

export const FX_ROUTES = { getExchangeRates, putExchangeRates } as const;

/** "1580.5" → 1580500000n (millionths). */
export function rateToMicros(rate: string): bigint {
  const [whole = '0', fraction = ''] = rate.split('.');
  return BigInt(whole) * 1_000_000n + BigInt(fraction.padEnd(6, '0').slice(0, 6));
}

/** 1580500000n → "1580.5". */
export function microsToRate(micros: bigint): string {
  const whole = micros / 1_000_000n;
  const fraction = (micros % 1_000_000n).toString().padStart(6, '0').replace(/0+$/, '');
  return fraction ? `${whole}.${fraction}` : whole.toString();
}

/** Base minor units for `amountMinor` of a currency at `rateMicros`, half up. */
export function toBaseMinor(amountMinor: bigint, rateMicros: bigint): bigint {
  const product = amountMinor * rateMicros;
  const sign = product < 0n ? -1n : 1n;
  const abs = product < 0n ? -product : product;
  return sign * ((abs + 500_000n) / 1_000_000n);
}
