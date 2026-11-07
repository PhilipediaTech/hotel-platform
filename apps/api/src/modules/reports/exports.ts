import type {
  CashierReport,
  DashboardReport,
  FlashReport,
  TaxReport,
  TrialBalanceReport,
} from '@hotel/shared';
import type { z } from 'zod';
import type { Property } from '../../generated/prisma/client.ts';
import { csv, decimal } from '../../core/exports.ts';
import { facts, footer, header, money, render, table, totals } from '../payments/documents.ts';

// CSV and PDF of each report (PRD M12-06; T-092). CSVs carry plain decimals (no currency
// sign, no thousands separator) so a spreadsheet can add them up; each ends with the
// report's definitions, as on screen (M12 rule).

type Row = (string | number | null)[];
const pct = (bps: number) => (bps / 100).toFixed(2);

export function flashCsv(r: z.infer<typeof FlashReport>): Uint8Array {
  const rows: Row[] = [
    ['Flash report', r.businessDate, r.currency],
    [],
    ['Figure', 'Value'],
    ['Rooms', r.roomsTotal],
    ['Out of order', r.outOfOrder],
    ['Rooms available', r.roomsAvailable],
    ['Rooms sold', r.roomsSold],
    ['Occupancy %', pct(r.occupancyBps)],
    ['Room revenue', decimal(r.roomRevenueMinor)],
    ['Day-use revenue', decimal(r.dayUseRevenueMinor)],
    ['Day-use stays', r.dayUses],
    ['ADR', decimal(r.adrMinor)],
    ['RevPAR', decimal(r.revparMinor)],
    ['Arrivals', r.arrivals],
    ['Departures', r.departures],
    ['No-shows', r.noShows],
    [],
    ['Revenue group', 'Amount'],
    ...r.revenueByGroup.map((g) => [g.group, decimal(g.amountMinor)]),
    [],
    ['Payment method', 'Count', 'Amount'],
    ...r.paymentsByMethod.map((m) => [m.method, m.count, decimal(m.amountMinor)]),
    [],
    ['Definitions', r.definitions],
  ];
  return csv(rows);
}

export function trialCsv(r: z.infer<typeof TrialBalanceReport>): Uint8Array {
  return csv([
    ['Trial balance', r.businessDate, r.currency],
    [],
    ['Figure', 'Amount'],
    ['Charges', decimal(r.chargesMinor)],
    ['Payments', decimal(r.paymentsMinor)],
    ['Company account transfers', decimal(r.arTransfersMinor)],
    ['Guest ledger opening', decimal(r.guestLedgerOpeningMinor)],
    ['Guest ledger closing', decimal(r.guestLedgerClosingMinor)],
    ['Deposit ledger opening', decimal(r.depositLedgerOpeningMinor)],
    ['Deposit ledger closing', decimal(r.depositLedgerClosingMinor)],
    ['Difference', decimal(r.differenceMinor)],
    ['Balanced', r.balanced ? 'yes' : 'no'],
    [],
    ['Definitions', r.definitions],
  ]);
}

export function cashierCsv(r: z.infer<typeof CashierReport>): Uint8Array {
  const rows: Row[] = [
    ['Cashier summary', r.businessDate, r.currency],
    [],
    [
      'Cashier',
      'Status',
      'Opened',
      'Closed',
      'Line',
      'Method',
      'Count',
      'Taken',
      'Expected',
      'Counted',
      'Variance',
    ],
  ];
  for (const sh of r.shifts) {
    for (const p of sh.payments) {
      rows.push([
        sh.cashier,
        sh.status,
        sh.openedAt,
        sh.closedAt,
        'payment',
        p.method,
        p.count,
        decimal(p.amountMinor),
        null,
        null,
        null,
      ]);
    }
    for (const c of sh.counts) {
      rows.push([
        sh.cashier,
        sh.status,
        sh.openedAt,
        sh.closedAt,
        'count',
        c.method,
        null,
        null,
        decimal(c.expectedMinor),
        decimal(c.countedMinor),
        decimal(c.varianceMinor),
      ]);
    }
  }
  rows.push([], ['Definitions', r.definitions]);
  return csv(rows);
}

export function dashboardCsv(r: z.infer<typeof DashboardReport>): Uint8Array {
  const t = r.today;
  const m = r.monthToDate;
  return csv([
    ['Dashboard', r.businessDate, r.currency],
    [],
    ['Figure', 'Today', 'Month to date'],
    ['Rooms available', t.roomsAvailable, m.roomsAvailable],
    ['Rooms occupied / sold', t.roomsOccupied, m.roomsSold],
    ['Occupancy %', pct(t.occupancyBps), pct(m.occupancyBps)],
    ['Revenue', decimal(t.revenueMinor), null],
    ['Room revenue', null, decimal(m.roomRevenueMinor)],
    ['ADR', null, decimal(m.adrMinor)],
    ['RevPAR', null, decimal(m.revparMinor)],
    [],
    ['Revenue group', 'Today', 'Month to date'],
    ...[...new Set([...t.revenueByGroup, ...m.revenueByGroup].map((g) => g.group))]
      .sort()
      .map((group) => [
        group,
        decimal(t.revenueByGroup.find((g) => g.group === group)?.amountMinor ?? '0'),
        decimal(m.revenueByGroup.find((g) => g.group === group)?.amountMinor ?? '0'),
      ]),
    [],
    ['Payment method', 'Today', 'Month to date'],
    ...[...new Set([...t.paymentsByMethod, ...m.paymentsByMethod].map((x) => x.method))]
      .sort()
      .map((method) => [
        method,
        decimal(t.paymentsByMethod.find((x) => x.method === method)?.amountMinor ?? '0'),
        decimal(m.paymentsByMethod.find((x) => x.method === method)?.amountMinor ?? '0'),
      ]),
    [],
    ['Balance', 'Amount'],
    ['Guest ledger', decimal(r.balances.guestLedgerMinor)],
    ['Deposit ledger', decimal(r.balances.depositLedgerMinor)],
    ['Open folios', r.balances.openFolios],
    [],
    ['Open alerts', r.alerts.open],
    ...r.alerts.byRule.map((a) => [a.rule, a.open]),
    [],
    ['Month to date covers', m.from, m.through ?? 'no closed day yet'],
    ['Definitions', r.definitions],
  ]);
}

export function taxCsv(r: z.infer<typeof TaxReport>): Uint8Array {
  const rows: Row[] = [
    ['Tax report', r.from, r.through ?? 'no closed day', r.currency],
    [],
    ['Authority', 'Tax', 'Rates %', 'Taxable', 'Tax amount', 'Lines'],
  ];
  for (const a of r.authorities) {
    for (const t of a.rules) {
      rows.push([
        a.authority,
        t.name,
        t.ratesBps.map(pct).join(' / '),
        decimal(t.taxableMinor),
        decimal(t.taxMinor),
        t.lines,
      ]);
    }
  }
  rows.push(
    ['Total', null, null, null, decimal(r.totalTaxMinor), null],
    [],
    ['Definitions', r.definitions],
  );
  return csv(rows);
}

export function dashboardPdf(p: Property, r: z.infer<typeof DashboardReport>): Promise<Uint8Array> {
  const m = (minor: string) => money(BigInt(minor), r.currency);
  return render((doc) => {
    header(doc, p, 'Dashboard');
    facts(doc, [
      ['Business date', r.businessDate],
      [
        'Month to date',
        r.monthToDate.through
          ? `${r.monthToDate.from} to ${r.monthToDate.through}`
          : 'no closed day yet',
      ],
      ['Currency', r.currency],
    ]);
    totals(
      doc,
      [
        [
          'Occupancy today',
          `${pct(r.today.occupancyBps)}% (${r.today.roomsOccupied} of ${r.today.roomsAvailable})`,
        ],
        ['Revenue today', m(r.today.revenueMinor)],
        ['Occupancy, month', `${pct(r.monthToDate.occupancyBps)}%`],
        ['Room revenue, month', m(r.monthToDate.roomRevenueMinor)],
        ['ADR, month', m(r.monthToDate.adrMinor)],
        ['RevPAR, month', m(r.monthToDate.revparMinor)],
        ['Guest ledger', m(r.balances.guestLedgerMinor)],
        ['Deposit ledger', m(r.balances.depositLedgerMinor)],
        ['Open alerts', String(r.alerts.open)],
      ],
      false,
    );
    doc.moveDown(1);
    table(
      doc,
      [
        { title: 'Payments, month', width: 250 },
        { title: 'Count', width: 80, align: 'right' },
        { title: 'Amount', width: 165, align: 'right' },
      ],
      r.monthToDate.paymentsByMethod.map((x) => [x.method, String(x.count), m(x.amountMinor)]),
    );
    footer(doc, r.definitions);
  });
}

export function taxPdf(p: Property, r: z.infer<typeof TaxReport>, to: string): Promise<Uint8Array> {
  const m = (minor: string) => money(BigInt(minor), r.currency);
  return render((doc) => {
    header(doc, p, 'Tax report');
    facts(doc, [
      ['Period', `${r.from} to ${to}`],
      ['Closed days through', r.through ?? 'none yet'],
      ['Currency', r.currency],
    ]);
    for (const a of r.authorities) {
      doc.font('Helvetica-Bold').fontSize(10).text(a.authority);
      doc.font('Helvetica').fontSize(9);
      table(
        doc,
        [
          { title: 'Tax', width: 170 },
          { title: 'Rate', width: 75, align: 'right' },
          { title: 'Taxable', width: 125, align: 'right' },
          { title: 'Tax', width: 125, align: 'right' },
        ],
        a.rules.map((t) => [
          t.name,
          t.ratesBps.map((b) => `${pct(b)}%`).join(' / '),
          m(t.taxableMinor),
          m(t.taxMinor),
        ]),
      );
    }
    totals(doc, [['Total tax', m(r.totalTaxMinor)]], true);
    footer(doc, r.definitions);
  });
}
