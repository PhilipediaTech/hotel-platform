import { z } from 'zod';
import { defineRoute } from './contract.ts';
import { AmountMinor, Instant, Uuid } from './primitives.ts';

// Utilities (PRD M5-11 "As maintenance, I log generator start/stop, diesel received and issued,
// and fuel checks"; M5-12 "I record meter readings for electricity, water and gas per shift";
// utility.log; M5 rule 4; tab 3 generators, generator_runs, fuel_movements, meter_readings;
// tab 4 row "Utilities"; S35 /utilities; T-132).
//
// A generator is an asset of the register; its tank is the diesel store that feeds it. Fuel
// moves in (RECEIVED) and out (ISSUED); a LEVEL_CHECK is a dip reading. At each check:
// variance = opening litres (the last check) + received − issued − closing litres (this check);
// fuel missing above 5% (configurable, leakage rule FUEL_VARIANCE) of what had to be accounted
// for (opening + received) raises a leakage alert. Litres travel as millilitres (integers).

export const FUEL_KINDS = ['RECEIVED', 'ISSUED', 'LEVEL_CHECK'] as const;
export type FuelKind = (typeof FUEL_KINDS)[number];

/** Suggested meters; a hotel can name others (a sub-meter, a borehole). */
export const STANDARD_METERS = ['GRID', 'WATER', 'GAS'] as const;

export interface FuelVariance {
  openingMilli: number;
  receivedMilli: number;
  issuedMilli: number;
  closingMilli: number;
  /** Missing (positive) or surplus (negative) fuel. */
  varianceMilli: number;
  /** Opening plus received: the fuel to account for. */
  accountableMilli: number;
  /** varianceMilli over accountableMilli, in basis points (0 when nothing to account for). */
  varianceBps: number;
}

/** M5 rule 4: opening + received − issued − closing. */
export function fuelVariance(
  openingMilli: number,
  receivedMilli: number,
  issuedMilli: number,
  closingMilli: number,
): FuelVariance {
  const varianceMilli = openingMilli + receivedMilli - issuedMilli - closingMilli;
  const accountableMilli = openingMilli + receivedMilli;
  return {
    openingMilli,
    receivedMilli,
    issuedMilli,
    closingMilli,
    varianceMilli,
    accountableMilli,
    varianceBps: accountableMilli > 0 ? Math.round((varianceMilli * 10_000) / accountableMilli) : 0,
  };
}

const Milli = z.number().int().min(0).max(100_000_000);
const Person = z.object({ id: Uuid, name: z.string() });
const NonNegative = AmountMinor.refine((a) => !a.startsWith('-'), 'Cannot be negative');
/** An instant up to a day back (a reading taken earlier in the shift); now when left out. */
const When = Instant.optional();

export const GeneratorRunItem = z
  .object({
    id: Uuid,
    startedAt: Instant,
    stoppedAt: Instant.nullable(),
    startedBy: Person,
    stoppedBy: Person.nullable(),
    /** Whole minutes, up to now while it runs. */
    minutes: z.number().int(),
  })
  .meta({ id: 'GeneratorRun' });

export const FuelVarianceItem = z.object({
  openingMilli: z.number().int(),
  receivedMilli: z.number().int(),
  issuedMilli: z.number().int(),
  closingMilli: z.number().int(),
  varianceMilli: z.number().int(),
  accountableMilli: z.number().int(),
  varianceBps: z.number().int(),
  /** A leakage alert was raised for it. */
  alerted: z.boolean(),
});

export const FuelMovementItem = z
  .object({
    id: Uuid,
    kind: z.enum(FUEL_KINDS),
    litresMilli: z.number().int(),
    costMinor: AmountMinor.nullable(),
    supplier: z.string().nullable(),
    by: Person,
    at: Instant,
    /** Level checks after the first: the check's variance. */
    variance: FuelVarianceItem.nullable(),
  })
  .meta({ id: 'FuelMovement' });

export const GeneratorItem = z
  .object({
    id: Uuid,
    name: z.string(),
    asset: z.object({ id: Uuid, tag: z.string(), name: z.string() }),
    tankLitresMilli: z.number().int(),
    serviceEveryMinutes: z.number().int().nullable(),
    /** The run in progress. */
    running: GeneratorRunItem.nullable(),
    /** Run minutes on the property's date today, and in all. */
    minutesToday: z.number().int(),
    totalMinutes: z.number().int(),
    lastCheck: z.object({ litresMilli: z.number().int(), at: Instant }).nullable(),
    /** Since the last check. */
    receivedMilli: z.number().int(),
    issuedMilli: z.number().int(),
    /** The last check plus received minus issued; null before the first check. */
    expectedMilli: z.number().int().nullable(),
  })
  .meta({ id: 'Generator' });

export const GeneratorDetail = GeneratorItem.extend({
  /** The latest 50 of each, newest first. */
  runs: z.array(GeneratorRunItem),
  fuel: z.array(FuelMovementItem),
}).meta({ id: 'GeneratorDetail' });

export const GeneratorBody = z.object({
  /** The register's asset it is (one generator per asset). */
  assetId: Uuid,
  name: z.string().trim().min(2).max(80),
  tankLitresMilli: Milli.min(1000),
  serviceEveryMinutes: z
    .number()
    .int()
    .min(60)
    .max(60 * 10_000)
    .nullable()
    .default(null),
});

export const RunBody = z.object({ at: When });

export const FuelMovementBody = z
  .object({
    generatorId: Uuid,
    kind: z.enum(FUEL_KINDS),
    litresMilli: Milli,
    /** Deliveries: what was paid and to whom. */
    costMinor: NonNegative.nullable().default(null),
    supplier: z
      .string()
      .trim()
      .max(120)
      .transform((v) => (v === '' ? null : v))
      .nullable()
      .default(null),
    at: When,
  })
  .superRefine((b, ctx) => {
    if (b.kind !== 'LEVEL_CHECK' && b.litresMilli === 0) {
      ctx.addIssue({ code: 'custom', path: ['litresMilli'], message: 'Enter the litres' });
    }
    if (b.kind !== 'RECEIVED' && (b.costMinor !== null || b.supplier !== null)) {
      ctx.addIssue({
        code: 'custom',
        path: ['costMinor'],
        message: 'Cost and supplier go with a delivery',
      });
    }
  });

export const MeterName = z
  .string()
  .trim()
  .min(2)
  .max(40)
  .transform((v) => v.toUpperCase().replace(/\s+/g, '_'));

export const MeterReadingBody = z.object({
  meter: MeterName,
  /** Whole units on the meter's dial (kWh, m³…). */
  reading: z.string().regex(/^(0|[1-9]\d{0,15})$/, 'A whole number'),
  at: When,
});

export const MeterReadingItem = z
  .object({
    id: Uuid,
    meter: z.string(),
    reading: z.string(),
    /** Since the meter's reading before this one. */
    usage: z.string().nullable(),
    hoursSincePrevious: z.number().nullable(),
    by: Person,
    at: Instant,
  })
  .meta({ id: 'MeterReading' });

const COMMON = { tags: ['Utilities'], propertyScoped: true as const, permission: 'utility.log' };
const GeneratorParams = z.object({ generatorId: Uuid });

export const listGenerators = defineRoute({
  ...COMMON,
  operationId: 'listGenerators',
  method: 'get',
  path: '/generators',
  summary: 'Generators with their run and fuel position (M5-11)',
  response: z.object({ data: z.array(GeneratorItem) }),
});

export const createGenerator = defineRoute({
  ...COMMON,
  operationId: 'createGenerator',
  method: 'post',
  path: '/generators',
  summary: 'Add a generator: an asset of the register with a diesel tank (M5-11)',
  idempotent: true,
  status: 201,
  body: GeneratorBody,
  response: GeneratorDetail,
});

export const getGenerator = defineRoute({
  ...COMMON,
  operationId: 'getGenerator',
  method: 'get',
  path: '/generators/{generatorId}',
  summary: 'A generator with its runs and fuel log (M5-11)',
  description: 'Added beyond tab 4 (T-132).',
  params: GeneratorParams,
  response: GeneratorDetail,
});

export const startGeneratorRun = defineRoute({
  ...COMMON,
  operationId: 'startGeneratorRun',
  method: 'post',
  path: '/generators/{generatorId}/runs',
  summary: 'Log a generator start (M5-11)',
  idempotent: true,
  status: 201,
  params: GeneratorParams,
  body: RunBody,
  response: GeneratorDetail,
  errors: ['STATE_TRANSITION_INVALID'],
});

export const stopGeneratorRun = defineRoute({
  ...COMMON,
  operationId: 'stopGeneratorRun',
  method: 'patch',
  path: '/generator-runs/{runId}/stop',
  summary: 'Log a generator stop (M5-11)',
  description:
    "The run's hours go on the generator's run-hours maintenance plans (M5-10), which may " +
    'open their jobs.',
  params: z.object({ runId: Uuid }),
  body: RunBody,
  response: GeneratorDetail,
  errors: ['STATE_TRANSITION_INVALID'],
});

export const recordFuelMovement = defineRoute({
  ...COMMON,
  operationId: 'recordFuelMovement',
  method: 'post',
  path: '/fuel-movements',
  summary: 'Log diesel received or issued, or a fuel check (M5-11, M5 rule 4)',
  description:
    'A check works out the variance since the last one and raises the FUEL_VARIANCE leakage ' +
    'alert when the fuel missing is over the threshold.',
  idempotent: true,
  status: 201,
  body: FuelMovementBody,
  response: z.object({ movement: FuelMovementItem, generator: GeneratorItem }),
});

export const recordMeterReading = defineRoute({
  ...COMMON,
  operationId: 'recordMeterReading',
  method: 'post',
  path: '/meter-readings',
  summary: 'Record a meter reading: electricity, water, gas… (M5-12)',
  idempotent: true,
  status: 201,
  body: MeterReadingBody,
  response: MeterReadingItem,
  errors: ['STATE_TRANSITION_INVALID'],
});

export const listMeterReadings = defineRoute({
  ...COMMON,
  operationId: 'listMeterReadings',
  method: 'get',
  path: '/meter-readings',
  summary: 'Meter readings with the usage between them (M5-12)',
  description: 'Added beyond tab 4 (T-132). The latest 100, newest first.',
  query: z.object({ meter: MeterName.optional() }),
  response: z.object({
    data: z.array(MeterReadingItem),
    /** Every meter read so far, with the standard ones. */
    meters: z.array(z.string()),
  }),
});

export const UTILITIES_ROUTES = {
  listGenerators,
  createGenerator,
  getGenerator,
  startGeneratorRun,
  stopGeneratorRun,
  recordFuelMovement,
  recordMeterReading,
  listMeterReadings,
} as const;
