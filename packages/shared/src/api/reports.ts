import { z } from 'zod';
import { defineRoute } from './contract.ts';
import { AmountMinor, IsoDate, Uuid } from './primitives.ts';

// Reports (PRD M12-01–M12-03, M12-06, M12 rules and AC; tab 4 row "Reports": GET
// /reports/dashboard, /flash, /trial-balance, /cashier, /tax with ?format=csv|pdf; S28;
// T-092). Closed days are read from the figures night audit kept (they never change);
// definitions travel with each report.

export const ReportFormat = z.enum(['json', 'csv', 'pdf']).default('json');

const ByGroup = z.array(z.object({ group: z.string(), amountMinor: AmountMinor }));
const ByMethod = z.array(
  z.object({ method: z.string(), count: z.number().int(), amountMinor: AmountMinor }),
);

/** The closed day a report is for, and the night audit that kept it. */
const ClosedDay = {
  businessDate: IsoDate,
  nightAuditId: Uuid,
  currency: z.string(),
  definitions: z.string(),
};

export const DashboardReport = z
  .object({
    currency: z.string(),
    businessDate: IsoDate,
    today: z.object({
      roomsAvailable: z.number().int(),
      roomsOccupied: z.number().int(),
      occupancyBps: z.number().int(),
      revenueMinor: AmountMinor,
      revenueByGroup: ByGroup,
      paymentsByMethod: ByMethod,
    }),
    /** Closed days of the month so far, from night audit's kept figures. */
    monthToDate: z.object({
      from: IsoDate,
      /** The last closed day counted; null when none this month. */
      through: IsoDate.nullable(),
      days: z.number().int(),
      roomsAvailable: z.number().int(),
      roomsSold: z.number().int(),
      occupancyBps: z.number().int(),
      roomRevenueMinor: AmountMinor,
      adrMinor: AmountMinor,
      revparMinor: AmountMinor,
      revenueByGroup: ByGroup,
      paymentsByMethod: ByMethod,
    }),
    balances: z.object({
      /** Every folio's balance (what guests and companies owe the hotel). */
      guestLedgerMinor: AmountMinor,
      /** Advance deposits held (owed to guests: negative). */
      depositLedgerMinor: AmountMinor,
      openFolios: z.number().int(),
    }),
    alerts: z.object({
      open: z.number().int(),
      byRule: z.array(z.object({ rule: z.string(), open: z.number().int() })),
    }),
    definitions: z.string(),
  })
  .meta({ id: 'DashboardReport' });

export const FlashReport = z
  .object({
    ...ClosedDay,
    roomsTotal: z.number().int(),
    outOfOrder: z.number().int(),
    roomsAvailable: z.number().int(),
    roomsSold: z.number().int(),
    occupancyBps: z.number().int(),
    roomRevenueMinor: AmountMinor,
    dayUses: z.number().int(),
    dayUseRevenueMinor: AmountMinor,
    adrMinor: AmountMinor,
    revparMinor: AmountMinor,
    revenueByGroup: ByGroup,
    paymentsByMethod: ByMethod,
    arrivals: z.number().int(),
    departures: z.number().int(),
    noShows: z.number().int(),
  })
  .meta({ id: 'FlashReport' });

export const TrialBalanceReport = z
  .object({
    ...ClosedDay,
    chargesMinor: AmountMinor,
    paymentsMinor: AmountMinor,
    arTransfersMinor: AmountMinor,
    guestLedgerOpeningMinor: AmountMinor,
    guestLedgerClosingMinor: AmountMinor,
    depositLedgerOpeningMinor: AmountMinor,
    depositLedgerClosingMinor: AmountMinor,
    differenceMinor: AmountMinor,
    balanced: z.boolean(),
    openingMatchesPreviousClose: z.boolean().nullable(),
  })
  .meta({ id: 'TrialBalanceReport' });

export const CashierReport = z
  .object({
    ...ClosedDay,
    shifts: z.array(
      z.object({
        cashier: z.string(),
        status: z.string(),
        openedAt: z.string(),
        closedAt: z.string().nullable(),
        payments: ByMethod,
        counts: z.array(
          z.object({
            method: z.string(),
            expectedMinor: AmountMinor,
            countedMinor: AmountMinor,
            varianceMinor: AmountMinor,
          }),
        ),
      }),
    ),
  })
  .meta({ id: 'CashierReport' });

export const TaxReport = z
  .object({
    from: IsoDate,
    /** Closed days only: the last one counted (null when none in the period). */
    through: IsoDate.nullable(),
    currency: z.string(),
    authorities: z.array(
      z.object({
        authority: z.string(),
        taxMinor: AmountMinor,
        rules: z.array(
          z.object({
            taxRuleId: Uuid,
            name: z.string(),
            /** Every rate charged in the period (a rate change shows two). */
            ratesBps: z.array(z.number().int()),
            taxableMinor: AmountMinor,
            taxMinor: AmountMinor,
            lines: z.number().int(),
          }),
        ),
      }),
    ),
    totalTaxMinor: AmountMinor,
    definitions: z.string(),
  })
  .meta({ id: 'TaxReport' });

const ClosedDayQuery = z.object({
  /** A closed business day; default the last one. */
  date: IsoDate.optional(),
  format: ReportFormat,
});

const EXPORTS_NOTE = ' `?format=csv|pdf` answers the file and needs report.export (M12-06).';

export const getDashboardReport = defineRoute({
  operationId: 'getDashboardReport',
  method: 'get',
  path: '/reports/dashboard',
  summary: 'Dashboard: today and month to date (M12-01)',
  description: 'Today is live; month to date counts closed days only.' + EXPORTS_NOTE,
  tags: ['Reports'],
  propertyScoped: true,
  permission: 'report.dashboard',
  exports: true,
  query: z.object({ format: ReportFormat }),
  response: DashboardReport,
});

export const getFlashReport = defineRoute({
  operationId: 'getFlashReport',
  method: 'get',
  path: '/reports/flash',
  summary: 'Flash report of a closed day (M12-02)',
  description:
    'As night audit kept it: never changes. 404 for a day without a night audit.' + EXPORTS_NOTE,
  tags: ['Reports'],
  propertyScoped: true,
  permission: 'report.audit',
  exports: true,
  query: ClosedDayQuery,
  response: FlashReport,
});

export const getTrialBalanceReport = defineRoute({
  operationId: 'getTrialBalanceReport',
  method: 'get',
  path: '/reports/trial-balance',
  summary: 'Trial balance of a closed day (M12-02)',
  description: 'As night audit kept it.' + EXPORTS_NOTE,
  tags: ['Reports'],
  propertyScoped: true,
  permission: 'report.audit',
  exports: true,
  query: ClosedDayQuery,
  response: TrialBalanceReport,
});

export const getCashierReport = defineRoute({
  operationId: 'getCashierReport',
  method: 'get',
  path: '/reports/cashier',
  summary: 'Cashier summary of a closed day (M12-02)',
  description: 'As night audit kept it.' + EXPORTS_NOTE,
  tags: ['Reports'],
  propertyScoped: true,
  permission: 'report.audit',
  exports: true,
  query: ClosedDayQuery,
  response: CashierReport,
});

export const getTaxReport = defineRoute({
  operationId: 'getTaxReport',
  method: 'get',
  path: '/reports/tax',
  summary: 'Tax by authority and period (M12-03)',
  description:
    'Tax lines posted on closed business days from `from` to `to` (at most a year), by ' +
    'authority and rule, with the amounts they were charged on.' +
    EXPORTS_NOTE,
  tags: ['Reports'],
  propertyScoped: true,
  permission: 'report.tax',
  exports: true,
  query: z.object({ from: IsoDate, to: IsoDate, format: ReportFormat }),
  response: TaxReport,
});

export const REPORT_ROUTES = {
  getDashboardReport,
  getFlashReport,
  getTrialBalanceReport,
  getCashierReport,
  getTaxReport,
} as const;
