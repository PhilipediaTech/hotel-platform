import type { NightAuditReportName } from '@hotel/shared';
import type { Property } from '../../generated/prisma/client.ts';
import type { TenantDb } from '../../core/tenant-db.ts';
import { folioBalances } from '../folios/service.ts';
import { isSystemCode } from '../folios/system-codes.ts';
import {
  facts,
  footer,
  header,
  METHOD,
  money,
  render,
  table,
  totals,
} from '../payments/documents.ts';

// Night audit reports (step 9; PRD M10 "as a night auditor, I get the flash report, trial
// balance, cashier summary, high-balance and discrepancy reports for each closed day", rule
// "reports for closed days read from the closed day's data and never change", AC "the flash
// report's room revenue equals the sum of room-revenue lines posted for that business date;
// ADR = room revenue ÷ rooms sold"; M4 AC trial balance identity; T-073b). Step 9 works the
// figures out once and keeps them on the run, so a report never changes after its day closes;
// the PDFs are drawn from that snapshot. Amounts are minor units as strings.

/** Default high-balance line: ₦200,000, until the property sets `highBalanceMinor`. */
export const DEFAULT_HIGH_BALANCE_MINOR = 20_000_000n;

const dbDate = (date: string) => new Date(`${date}T00:00:00Z`);
const day = (d: Date) => d.toISOString().slice(0, 10);
const s = (n: bigint) => n.toString();
const sum = (xs: bigint[]) => xs.reduce((a, b) => a + b, 0n);

export interface AuditReports {
  flash: {
    roomsTotal: number;
    outOfOrder: number;
    roomsAvailable: number;
    roomsSold: number;
    occupancyBps: number;
    roomRevenueMinor: string;
    dayUses: number;
    dayUseRevenueMinor: string;
    adrMinor: string;
    revparMinor: string;
    revenueByGroup: { group: string; amountMinor: string }[];
    paymentsByMethod: { method: string; count: number; amountMinor: string }[];
    arrivals: number;
    departures: number;
    noShows: number;
  };
  trialBalance: {
    chargesMinor: string;
    paymentsMinor: string;
    arTransfersMinor: string;
    guestLedgerOpeningMinor: string;
    guestLedgerClosingMinor: string;
    depositLedgerOpeningMinor: string;
    depositLedgerClosingMinor: string;
    /** Charges − payments − AR transfers − (Δ guest ledger + Δ deposit ledger): 0 when it holds. */
    differenceMinor: string;
    balanced: boolean;
    /** The guest ledger opened where the previous audit closed it (no back-dated changes). */
    openingMatchesPreviousClose: boolean | null;
  };
  cashier: {
    shifts: {
      cashier: string;
      status: string;
      openedAt: string;
      closedAt: string | null;
      payments: { method: string; count: number; amountMinor: string }[];
      counts: {
        method: string;
        expectedMinor: string;
        countedMinor: string;
        varianceMinor: string;
      }[];
    }[];
  };
  highBalance: {
    thresholdMinor: string;
    folios: {
      number: string;
      name: string;
      room: string | null;
      balanceMinor: string;
      creditLimitMinor: string | null;
    }[];
  };
  discrepancy: { rooms: { room: string; message: string }[] };
}

/**
 * Ledger balances at the end of `date` (inclusive). Guest ledger: every folio's lines less
 * its payments (base currency). Deposit ledger, as the guest sees it: what is held is owed to
 * them, so it counts negative.
 */
async function ledgers(db: TenantDb, through: Date) {
  const [lines, folioPayments, deposits] = await Promise.all([
    db.folioLine.aggregate({
      where: { businessDate: { lte: through } },
      _sum: { amountMinor: true },
    }),
    db.payment.aggregate({
      where: { businessDate: { lte: through }, folioId: { not: null } },
      _sum: { baseAmountMinor: true },
    }),
    db.depositLedgerEntry.aggregate({
      where: { businessDate: { lte: through } },
      _sum: { amountMinor: true },
    }),
  ]);
  return {
    guest: (lines._sum.amountMinor ?? 0n) - (folioPayments._sum.baseAmountMinor ?? 0n),
    deposit: -(deposits._sum.amountMinor ?? 0n),
  };
}

export async function buildReports(
  db: TenantDb,
  args: {
    date: string;
    noShows: number;
    discrepancies: { room: string; message: string }[];
    previousGuestLedgerClosing: bigint | null;
    highBalanceMinor: bigint;
  },
): Promise<AuditReports> {
  const on = dbDate(args.date);
  const before = new Date(on.getTime() - 86_400_000);
  const [rooms, blocked, postings, lines, payments, shifts, open, close] = await Promise.all([
    db.room.findMany({ where: { active: true }, select: { id: true, hkStatus: true } }),
    db.roomBlock.findMany({
      where: { releasedAt: null, startDate: { lte: on }, endDate: { gt: on } },
      select: { roomId: true },
    }),
    db.roomChargePosting.findMany({
      where: { businessDate: on },
      include: { stay: { select: { isDayUse: true } }, folioLine: true },
    }),
    db.folioLine.findMany({ where: { businessDate: on }, include: { revenueCode: true } }),
    db.payment.findMany({ where: { businessDate: on } }),
    db.cashierShift.findMany({
      where: { userId: { not: null }, OR: [{ payments: { some: { businessDate: on } } }] },
      include: { user: { select: { name: true } }, counts: true, payments: true },
      orderBy: { openedAt: 'asc' },
    }),
    ledgers(db, before),
    ledgers(db, on),
  ]);

  // ── Flash ──
  const out = new Set([
    ...rooms
      .filter((r) => r.hkStatus === 'OUT_OF_ORDER' || r.hkStatus === 'OUT_OF_SERVICE')
      .map((r) => r.id),
    ...blocked.map((b) => b.roomId).filter((id) => rooms.some((r) => r.id === id)),
  ]);
  const roomsAvailable = rooms.length - out.size;
  const sold = postings.filter((p) => !p.stay.isDayUse);
  const dayUses = postings.filter((p) => p.stay.isDayUse);
  // Room revenue: every room-group line of the day (charges, discounts, reversals).
  const roomRevenue = sum(
    lines.filter((l) => l.revenueCode.group === 'ROOM').map((l) => l.amountMinor),
  );
  const dayUseRevenue = sum(dayUses.map((p) => p.folioLine.amountMinor));
  const nightRevenue = roomRevenue - dayUseRevenue;
  const byGroup = new Map<string, bigint>();
  for (const l of lines) {
    // Deposits and transfers move money between ledgers: they are not revenue.
    if (
      isSystemCode(l.revenueCode.code) &&
      l.revenueCode.code !== 'FX' &&
      l.revenueCode.code !== 'NOSHOW'
    )
      continue;
    byGroup.set(l.revenueCode.group, (byGroup.get(l.revenueCode.group) ?? 0n) + l.amountMinor);
  }
  const byMethod = (ps: typeof payments) => {
    const m = new Map<string, { count: number; amount: bigint }>();
    for (const p of ps) {
      const e = m.get(p.method) ?? { count: 0, amount: 0n };
      m.set(p.method, { count: e.count + 1, amount: e.amount + p.baseAmountMinor });
    }
    return [...m.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([method, e]) => ({ method, count: e.count, amountMinor: s(e.amount) }));
  };
  const [arrivals, departures] = await Promise.all([
    db.stay.count({
      where: { arrival: on, isDayUse: false, status: { in: ['CHECKED_IN', 'CHECKED_OUT'] } },
    }),
    db.stay.count({ where: { departure: on, isDayUse: false, status: 'CHECKED_OUT' } }),
  ]);

  // ── Trial balance (M4 AC) ──
  const charges = sum(lines.filter((l) => l.kind !== 'DEPOSIT_APPLY').map((l) => l.amountMinor));
  const ar = sum(payments.filter((p) => p.method === 'AR_TRANSFER').map((p) => p.baseAmountMinor));
  const paid = sum(
    payments.filter((p) => p.method !== 'AR_TRANSFER').map((p) => p.baseAmountMinor),
  );
  const difference =
    charges - paid - ar - (close.guest - open.guest + (close.deposit - open.deposit));

  // ── High balance ──
  const openFolios = await db.folio.findMany({
    where: { status: 'OPEN' },
    include: { stays: { include: { room: { select: { number: true } } } } },
  });
  const balances = await folioBalances(
    db,
    openFolios.map((f) => f.id),
  );
  const high = openFolios
    .map((f) => ({ f, balance: balances.get(f.id) ?? 0n }))
    .filter(
      ({ f, balance }) =>
        balance >= args.highBalanceMinor ||
        (f.creditLimitMinor !== null && balance > f.creditLimitMinor),
    )
    .sort((a, b) => (b.balance > a.balance ? 1 : b.balance < a.balance ? -1 : 0));

  return {
    flash: {
      roomsTotal: rooms.length,
      outOfOrder: out.size,
      roomsAvailable,
      roomsSold: sold.length,
      occupancyBps: roomsAvailable > 0 ? Math.round((sold.length * 10_000) / roomsAvailable) : 0,
      roomRevenueMinor: s(roomRevenue),
      dayUses: dayUses.length,
      dayUseRevenueMinor: s(dayUseRevenue),
      adrMinor: s(sold.length > 0 ? nightRevenue / BigInt(sold.length) : 0n),
      revparMinor: s(roomsAvailable > 0 ? nightRevenue / BigInt(roomsAvailable) : 0n),
      revenueByGroup: [...byGroup.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([group, amount]) => ({ group, amountMinor: s(amount) })),
      paymentsByMethod: byMethod(payments),
      arrivals,
      departures,
      noShows: args.noShows,
    },
    trialBalance: {
      chargesMinor: s(charges),
      paymentsMinor: s(paid),
      arTransfersMinor: s(ar),
      guestLedgerOpeningMinor: s(open.guest),
      guestLedgerClosingMinor: s(close.guest),
      depositLedgerOpeningMinor: s(open.deposit),
      depositLedgerClosingMinor: s(close.deposit),
      differenceMinor: s(difference),
      balanced: difference === 0n,
      openingMatchesPreviousClose:
        args.previousGuestLedgerClosing === null
          ? null
          : args.previousGuestLedgerClosing === open.guest,
    },
    cashier: {
      shifts: shifts.map((sh) => ({
        cashier: sh.user?.name ?? '',
        status: sh.status,
        openedAt: sh.openedAt.toISOString(),
        closedAt: sh.closedAt ? sh.closedAt.toISOString() : null,
        payments: byMethod(sh.payments.filter((p) => day(p.businessDate) === args.date)),
        counts: sh.counts.map((c) => ({
          method: c.method,
          expectedMinor: s(c.expectedMinor),
          countedMinor: s(c.countedMinor),
          varianceMinor: s(c.varianceMinor),
        })),
      })),
    },
    highBalance: {
      thresholdMinor: s(args.highBalanceMinor),
      folios: high.map(({ f, balance }) => ({
        number: f.number,
        name: f.name,
        room: f.stays[0]?.room?.number ?? null,
        balanceMinor: s(balance),
        creditLimitMinor: f.creditLimitMinor === null ? null : s(f.creditLimitMinor),
      })),
    },
    discrepancy: { rooms: args.discrepancies },
  };
}

// ── PDFs ────────────────────────────────────────────────────────────────────────────────

const TITLES: Record<NightAuditReportName, string> = {
  flash: 'Flash report',
  'trial-balance': 'Trial balance',
  cashier: 'Cashier summary',
  'high-balance': 'High balance report',
  discrepancy: 'Discrepancy report',
};
const GROUP: Record<string, string> = {
  ROOM: 'Rooms',
  FNB: 'Food and beverage',
  OTHER: 'Other',
  TAX: 'Taxes',
  SERVICE_CHARGE: 'Service charge',
  FX: 'Exchange difference',
  FEE: 'Fees',
};
const pct = (bps: number) => `${(bps / 100).toFixed(2)}%`;

/** One report of a closed day as a PDF, drawn from the run's snapshot. */
export async function reportPdf(
  property: Property,
  date: string,
  name: NightAuditReportName,
  r: AuditReports,
): Promise<{ filename: string; content: Uint8Array }> {
  const cur = property.baseCurrency;
  const m = (minor: string) => money(BigInt(minor), cur);
  const content = await render((doc) => {
    header(doc, property, TITLES[name]);
    facts(doc, [
      ['Business date', date],
      ['Currency', cur],
    ]);
    if (name === 'flash') {
      const f = r.flash;
      totals(
        doc,
        [
          ['Rooms', String(f.roomsTotal)],
          ['Out of order', String(f.outOfOrder)],
          ['Available', String(f.roomsAvailable)],
          ['Sold (room nights)', String(f.roomsSold)],
          ['Occupancy', pct(f.occupancyBps)],
          ['Room revenue', m(f.roomRevenueMinor)],
          ['of which day-use', `${m(f.dayUseRevenueMinor)} (${f.dayUses})`],
          ['ADR', m(f.adrMinor)],
          ['RevPAR', m(f.revparMinor)],
          ['Arrivals', String(f.arrivals)],
          ['Departures', String(f.departures)],
          ['No-shows', String(f.noShows)],
        ],
        false,
      );
      doc.moveDown(1);
      table(
        doc,
        [
          { title: 'Revenue', width: 300 },
          { title: 'Amount', width: 195, align: 'right' },
        ],
        f.revenueByGroup.map((g) => [GROUP[g.group] ?? g.group, m(g.amountMinor)]),
      );
      table(
        doc,
        [
          { title: 'Payments', width: 250 },
          { title: 'Count', width: 80, align: 'right' },
          { title: 'Amount', width: 165, align: 'right' },
        ],
        f.paymentsByMethod.map((p) => [
          METHOD[p.method] ?? p.method,
          String(p.count),
          m(p.amountMinor),
        ]),
      );
      footer(
        doc,
        'Rooms sold: overnight room nights posted by night audit for this date. Room revenue: every room-revenue line of the date (charges, discounts and reversals), day-use included. ADR = room revenue without day-use ÷ rooms sold; RevPAR = the same ÷ rooms available; occupancy = rooms sold ÷ rooms available. Out of order: rooms out of order or service, or blocked, that night. Amounts before tax.',
      );
    } else if (name === 'trial-balance') {
      const t = r.trialBalance;
      totals(
        doc,
        [
          ['Charges', m(t.chargesMinor)],
          ['Payments', m(t.paymentsMinor)],
          ['Company account transfers', m(t.arTransfersMinor)],
          ['Guest ledger, opening', m(t.guestLedgerOpeningMinor)],
          ['Guest ledger, closing', m(t.guestLedgerClosingMinor)],
          ['Deposit ledger, opening', m(t.depositLedgerOpeningMinor)],
          ['Deposit ledger, closing', m(t.depositLedgerClosingMinor)],
          ['Difference', m(t.differenceMinor)],
        ],
        true,
      );
      doc.moveDown(1);
      doc
        .font('Helvetica-Bold')
        .fontSize(11)
        .text(t.balanced ? 'Balanced.' : 'NOT BALANCED: investigate before the next day closes.');
      footer(
        doc,
        'Charges − payments − company account transfers = change in guest ledger + change in deposit ledger. The guest ledger is every folio’s balance; the deposit ledger counts advance deposits held as owed to guests (negative). Base currency.' +
          (t.openingMatchesPreviousClose === false
            ? ' The opening guest ledger differs from the previous audit’s closing: something was posted to an earlier day.'
            : ''),
      );
    } else if (name === 'cashier') {
      for (const sh of r.cashier.shifts) {
        doc.font('Helvetica-Bold').fontSize(10).text(`${sh.cashier} (${sh.status.toLowerCase()})`);
        doc.font('Helvetica').fontSize(9);
        table(
          doc,
          [
            { title: 'Method', width: 250 },
            { title: 'Count', width: 80, align: 'right' },
            { title: 'Taken', width: 165, align: 'right' },
          ],
          sh.payments.map((p) => [METHOD[p.method] ?? p.method, String(p.count), m(p.amountMinor)]),
        );
        if (sh.counts.length > 0) {
          table(
            doc,
            [
              { title: 'Counted', width: 155 },
              { title: 'Expected', width: 115, align: 'right' },
              { title: 'Counted', width: 115, align: 'right' },
              { title: 'Variance', width: 110, align: 'right' },
            ],
            sh.counts.map((c) => [
              METHOD[c.method] ?? c.method,
              m(c.expectedMinor),
              m(c.countedMinor),
              m(c.varianceMinor),
            ]),
          );
        }
      }
      if (r.cashier.shifts.length === 0) doc.text('No payments on this date.');
    } else if (name === 'high-balance') {
      table(
        doc,
        [
          { title: 'Folio', width: 70 },
          { title: 'Name', width: 175 },
          { title: 'Room', width: 60 },
          { title: 'Credit limit', width: 95, align: 'right' },
          { title: 'Balance', width: 95, align: 'right' },
        ],
        r.highBalance.folios.map((f) => [
          f.number,
          f.name,
          f.room ?? '',
          f.creditLimitMinor === null ? '' : m(f.creditLimitMinor),
          m(f.balanceMinor),
        ]),
      );
      if (r.highBalance.folios.length === 0) doc.text('No open folio above the line.');
      footer(
        doc,
        `Open folios with a balance of ${m(r.highBalance.thresholdMinor)} or more, or above their credit limit, at the close of the day.`,
      );
    } else {
      table(
        doc,
        [
          { title: 'Room', width: 80 },
          { title: 'Front office against housekeeping', width: 415 },
        ],
        r.discrepancy.rooms.map((d) => [d.room, d.message]),
      );
      if (r.discrepancy.rooms.length === 0) doc.text('No discrepancies.');
      footer(
        doc,
        'Rooms where the front office and housekeeping disagree at night audit (step 3). Until housekeeping room reports exist, housekeeping’s view is the room’s own status and blocks.',
      );
    }
  });
  return { filename: `${name}-${date}.pdf`, content };
}
