import PDFDocument from 'pdfkit';
import type { Property } from '../../generated/prisma/client.ts';
import { recordAudit } from '../../core/audit.ts';
import { businessDate } from '../../core/business-day.ts';
import { AppError } from '../../core/errors.ts';
import type { TenantDb } from '../../core/tenant-db.ts';
import { ordered } from '../folios/service.ts';
import type { PaymentDeps } from './service.ts';

// Folio documents as PDF (PRD M4 "I issue a receipt, an invoice and a proforma invoice"; tab 4
// GET /folios/{id}/invoice.pdf and /receipt.pdf; T-062). Built with pdfkit's standard fonts,
// which have no ₦ sign, so amounts print with the currency code ("NGN 12,500.00"). Each
// document issued is audited. Invoices are numbered by their folio (and window); the
// e-invoicing reference and QR code come with the tax authority integration.

type Doc = PDFKit.PDFDocument;

const day = (d: Date) => d.toISOString().slice(0, 10);
const METHOD: Record<string, string> = {
  CASH: 'Cash',
  BANK_TRANSFER: 'Bank transfer',
  POS_TERMINAL: 'POS terminal',
  CARD_ONLINE: 'Online card',
  VIRTUAL_ACCOUNT: 'Virtual account',
  MOBILE_MONEY: 'Mobile money',
  VOUCHER: 'Voucher',
  AR_TRANSFER: 'Company account',
};

/** "NGN 1,234.50", "-NGN 10.00": exact, from minor units. */
export function money(minor: bigint, currency: string): string {
  const negative = minor < 0n;
  const abs = negative ? -minor : minor;
  const whole = (abs / 100n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const cents = (abs % 100n).toString().padStart(2, '0');
  return `${negative ? '-' : ''}${currency} ${whole}.${cents}`;
}

function render(build: (doc: Doc) => void): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 50, info: { Producer: 'Hotel platform' } });
    const chunks: Buffer[] = [];
    doc.on('data', (c: Buffer) => chunks.push(c));
    doc.on('end', () => resolve(new Uint8Array(Buffer.concat(chunks))));
    doc.on('error', reject);
    build(doc);
    doc.end();
  });
}

const LEFT = 50;
const RIGHT = 545;

function header(doc: Doc, property: Property, title: string) {
  const address = (property.address ?? {}) as Record<string, string | null>;
  const tax = (property.taxRegistration ?? {}) as Record<string, string | null>;
  doc.font('Helvetica-Bold').fontSize(16).text(property.name, LEFT, 50);
  doc.font('Helvetica').fontSize(9);
  const lines = [
    [address['line1'], address['line2']].filter(Boolean).join(', '),
    [address['city'], address['state'], address['country']].filter(Boolean).join(', '),
    [property.phone, property.email].filter(Boolean).join(' · '),
    [tax['tin'] ? `TIN ${tax['tin']}` : null, tax['vatNumber'] ? `VAT ${tax['vatNumber']}` : null]
      .filter(Boolean)
      .join(' · '),
  ].filter((l) => l !== '');
  for (const l of lines) doc.text(l);
  doc
    .font('Helvetica-Bold')
    .fontSize(14)
    .text(title, LEFT, 50, { width: RIGHT - LEFT, align: 'right' });
  doc.moveDown(0.2).font('Helvetica').fontSize(9);
  doc.y = Math.max(doc.y, 130);
}

/** Label / value pairs, two columns. */
function facts(doc: Doc, rows: [string, string][]) {
  const top = doc.y;
  rows.forEach(([label, value], i) => {
    const x = i % 2 === 0 ? LEFT : 300;
    const y = top + Math.floor(i / 2) * 14;
    doc.font('Helvetica-Bold').fontSize(9).text(label, x, y, { width: 90 });
    doc.font('Helvetica').text(value, x + 90, y, { width: 150 });
  });
  doc.y = top + Math.ceil(rows.length / 2) * 14 + 12;
}

interface Column {
  title: string;
  width: number;
  align?: 'left' | 'right';
}

function table(doc: Doc, columns: Column[], rows: string[][], bold: Set<number> = new Set()) {
  const row = (cells: string[], font: string) => {
    if (doc.y > 760) doc.addPage();
    const y = doc.y;
    let x = LEFT;
    let height = 0;
    cells.forEach((cell, i) => {
      const col = columns[i] as Column;
      doc.font(font).fontSize(9);
      height = Math.max(height, doc.heightOfString(cell, { width: col.width - 6 }));
      doc.text(cell, x, y, { width: col.width - 6, align: col.align ?? 'left' });
      x += col.width;
    });
    doc.y = y + height + 4;
  };
  row(
    columns.map((c) => c.title),
    'Helvetica-Bold',
  );
  doc
    .moveTo(LEFT, doc.y - 2)
    .lineTo(RIGHT, doc.y - 2)
    .lineWidth(0.5)
    .stroke();
  rows.forEach((r, i) => row(r, bold.has(i) ? 'Helvetica-Bold' : 'Helvetica'));
  doc.moveDown(0.5);
}

function totals(doc: Doc, rows: [string, string][], strongLast = true) {
  rows.forEach(([label, value], i) => {
    if (doc.y > 770) doc.addPage();
    const font = strongLast && i === rows.length - 1 ? 'Helvetica-Bold' : 'Helvetica';
    const y = doc.y;
    doc.font(font).fontSize(10).text(label, 300, y, { width: 140 });
    doc.text(value, 440, y, { width: RIGHT - 440, align: 'right' });
    doc.y = y + 15;
  });
}

function footer(doc: Doc, text: string) {
  doc
    .moveDown(1)
    .font('Helvetica')
    .fontSize(8)
    .fillColor('#555555')
    .text(text, LEFT, doc.y, {
      width: RIGHT - LEFT,
    });
  doc.fillColor('#000000');
}

const safeName = (s: string) => s.replace(/[^\w-]/g, '_');

// ── Invoice ─────────────────────────────────────────────────────────────────────────────

async function loadFolio(db: TenantDb, folioId: string) {
  const folio = await db.folio.findUnique({
    where: { id: folioId },
    include: {
      property: true,
      windows: { include: { payerGuest: true, company: true }, orderBy: { number: 'asc' } },
      lines: {
        include: { window: true, taxRuleVersion: { select: { sequence: true } } },
        orderBy: [{ postedAt: 'asc' }, { id: 'asc' }],
      },
      payments: {
        include: { window: true, receivedBy: { select: { name: true } } },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      },
      reservation: { include: { company: true } },
      stays: { include: { room: true, roomType: true } },
    },
  });
  if (!folio) throw new AppError('NOT_FOUND', 'Folio not found');
  return folio;
}

type LoadedFolio = Awaited<ReturnType<typeof loadFolio>>;

function payerOf(folio: LoadedFolio, windowNumber: number): string {
  const w = folio.windows.find((x) => x.number === windowNumber);
  if (w?.company) return w.company.name;
  if (w?.payerGuest) return `${w.payerGuest.firstName} ${w.payerGuest.lastName}`.trim();
  return folio.name;
}

function stayFacts(folio: LoadedFolio): [string, string][] {
  const stay = folio.stays[0];
  return [
    ['Room', stay?.room?.number ?? '—'],
    ['Stay', stay ? `${day(stay.arrival)} to ${day(stay.departure)}` : '—'],
    ['Confirmation', folio.reservation?.confirmationNo ?? '—'],
  ];
}

export async function folioInvoice(deps: PaymentDeps, folioId: string, windowNumber?: number) {
  const db = deps.tenantDb;
  const folio = await loadFolio(db, folioId);
  if (windowNumber !== undefined && !folio.windows.some((w) => w.number === windowNumber)) {
    throw new AppError('VALIDATION_ERROR', 'This folio has no such window', {
      issues: [{ path: 'query.window', code: 'custom', message: 'This folio has no such window' }],
    });
  }
  const inWindow = (w: { number: number } | null) =>
    windowNumber === undefined || (w?.number ?? 1) === windowNumber;
  const lines = ordered(folio.lines.filter((l) => inWindow(l.window)));
  const payments = folio.payments.filter((p) => inWindow(p.window));
  const cur = folio.currency;
  const number =
    windowNumber && windowNumber > 1 ? `${folio.number}-${windowNumber}` : folio.number;
  const date = await businessDate(db, folio.propertyId, deps.clock);

  const charges = lines
    .filter((l) => l.kind !== 'DEPOSIT_APPLY')
    .reduce((s, l) => s + l.amountMinor, 0n);
  const deposits = lines
    .filter((l) => l.kind === 'DEPOSIT_APPLY')
    .reduce((s, l) => s + l.amountMinor, 0n);
  const received = payments.reduce((s, p) => s + p.baseAmountMinor, 0n);
  const balance = charges + deposits - received;
  const taxes = new Map<string, bigint>();
  for (const l of lines.filter(
    (x) => x.kind === 'TAX' || (x.kind === 'REVERSAL' && x.taxRuleVersionId),
  )) {
    taxes.set(
      l.description.replace(/^Reversal: /, ''),
      (taxes.get(l.description.replace(/^Reversal: /, '')) ?? 0n) + l.amountMinor,
    );
  }
  const taxTotal = [...taxes.values()].reduce((s, v) => s + v, 0n);

  const content = await render((doc) => {
    header(doc, folio.property, 'INVOICE');
    facts(doc, [
      ['Invoice no.', number],
      ['Date', date],
      ['Bill to', payerOf(folio, windowNumber ?? 1)],
      ['Guest', folio.name],
      ...stayFacts(folio),
    ]);
    table(
      doc,
      [
        { title: 'Date', width: 70 },
        { title: 'Description', width: 265 },
        { title: 'Qty', width: 40, align: 'right' },
        { title: 'Amount', width: 120, align: 'right' },
      ],
      lines
        .filter((l) => l.kind !== 'DEPOSIT_APPLY')
        .map((l) => [
          day(l.businessDate),
          l.kind === 'TAX' ? `   ${l.description}` : l.description,
          l.kind === 'TAX' ? '' : String(l.quantity),
          money(l.amountMinor, cur),
        ]),
    );
    if (payments.length > 0) {
      table(
        doc,
        [
          { title: 'Date', width: 70 },
          { title: 'Payment', width: 305 },
          { title: 'Amount', width: 120, align: 'right' },
        ],
        payments.map((p) => [
          day(p.businessDate),
          [METHOD[p.method] ?? p.method, p.externalRef].filter(Boolean).join(' · '),
          money(-p.baseAmountMinor, cur),
        ]),
      );
    }
    totals(doc, [
      ['Charges before tax', money(charges - taxTotal, cur)],
      ...[...taxes.entries()].map(([name, amount]): [string, string] => [name, money(amount, cur)]),
      ['Total charges', money(charges, cur)],
      ...(deposits !== 0n ? [['Advance deposit', money(deposits, cur)] as [string, string]] : []),
      ['Payments', money(-received, cur)],
      ['Balance due', money(balance, cur)],
    ]);
    footer(doc, `Folio ${folio.number}. Amounts in ${cur}. Thank you for staying with us.`);
  });
  await recordAudit(db, {
    action: 'folio.invoice_issued',
    entityType: 'folio',
    entityId: folio.id,
    after: { number, window: windowNumber ?? null, balanceMinor: balance.toString() },
  });
  return { filename: `invoice-${safeName(number)}.pdf`, content };
}

// ── Receipt ─────────────────────────────────────────────────────────────────────────────

export async function folioReceipt(deps: PaymentDeps, folioId: string, paymentId: string) {
  const db = deps.tenantDb;
  const folio = await loadFolio(db, folioId);
  const payment = folio.payments.find((p) => p.id === paymentId);
  if (!payment) throw new AppError('NOT_FOUND', 'Payment not found');
  const cur = payment.currency;
  const number = payment.id.slice(0, 8).toUpperCase();
  const charges = folio.lines.reduce((s, l) => s + l.amountMinor, 0n);
  const received = folio.payments.reduce((s, p) => s + p.baseAmountMinor, 0n);
  const content = await render((doc) => {
    header(doc, folio.property, 'RECEIPT');
    facts(doc, [
      ['Receipt no.', number],
      ['Date', day(payment.businessDate)],
      ['Received from', payerOf(folio, payment.window?.number ?? 1)],
      ['Folio', folio.number],
      ...stayFacts(folio),
    ]);
    table(
      doc,
      [
        { title: 'Method', width: 140 },
        { title: 'Reference', width: 235 },
        { title: 'Amount', width: 120, align: 'right' },
      ],
      [
        [
          METHOD[payment.method] ?? payment.method,
          payment.externalRef ?? '—',
          money(payment.amountMinor, cur),
        ],
      ],
    );
    totals(doc, [
      ['Amount received', money(payment.amountMinor, cur)],
      ['Folio balance now', money(charges - received, folio.currency)],
    ]);
    footer(
      doc,
      [
        payment.receivedBy ? `Received by ${payment.receivedBy.name}.` : null,
        payment.note ? `Note: ${payment.note}.` : null,
        `Payment ${payment.id}.`,
      ]
        .filter(Boolean)
        .join(' '),
    );
  });
  await recordAudit(db, {
    action: 'payment.receipt_issued',
    entityType: 'payment',
    entityId: payment.id,
    after: { folioId: folio.id, number },
  });
  return { filename: `receipt-${number}.pdf`, content };
}

// ── Proforma ────────────────────────────────────────────────────────────────────────────

interface StoredNight {
  date: string;
  amountMinor: string;
}
interface StoredTax {
  code: string;
  name: string;
  amountMinor: string;
}

export async function proforma(deps: PaymentDeps, reservationId: string) {
  const db = deps.tenantDb;
  const reservation = await db.reservation.findUnique({
    where: { id: reservationId },
    include: {
      property: true,
      booker: true,
      company: true,
      stays: {
        include: { quote: true, roomType: true, ratePlan: true, guest: true },
        orderBy: { arrival: 'asc' },
      },
      depositEntries: true,
    },
  });
  if (!reservation) throw new AppError('NOT_FOUND', 'Reservation not found');
  const depositHeldMinor = reservation.depositEntries.reduce((s, e) => s + e.amountMinor, 0n);
  const stays = reservation.stays.filter(
    (s) => !['CANCELLED', 'NO_SHOW'].includes(s.status) && s.quote !== null,
  );
  if (stays.length === 0) {
    throw new AppError('STATE_TRANSITION_INVALID', 'This booking has no stays to quote', {
      status: reservation.status,
    });
  }
  const cur = reservation.property.baseCurrency;
  const date = await businessDate(db, reservation.propertyId, deps.clock);
  const taxes = new Map<string, bigint>();
  let total = 0n;
  const rows: string[][] = [];
  for (const stay of stays) {
    const quote = stay.quote;
    if (!quote) continue;
    const nights = quote.nights as unknown as StoredNight[];
    for (const n of nights) {
      rows.push([
        n.date,
        `${stay.roomType.name} · ${stay.ratePlan.name}${stays.length > 1 ? ` · ${stay.guest.firstName} ${stay.guest.lastName}` : ''}`,
        money(BigInt(n.amountMinor), cur),
      ]);
    }
    for (const t of quote.taxes as unknown as StoredTax[]) {
      taxes.set(t.name, (taxes.get(t.name) ?? 0n) + BigInt(t.amountMinor));
    }
    total += quote.totalMinor;
  }
  const taxTotal = [...taxes.values()].reduce((s, v) => s + v, 0n);
  const booker = reservation.booker;
  const content = await render((doc) => {
    header(doc, reservation.property, 'PROFORMA INVOICE');
    facts(doc, [
      ['Reference', reservation.confirmationNo],
      ['Date', date],
      ['Bill to', reservation.company?.name ?? `${booker.firstName} ${booker.lastName}`.trim()],
      ['Booked by', `${booker.firstName} ${booker.lastName}`.trim()],
      ['Stays', String(stays.length)],
      [
        'Dates',
        `${day(stays[0]?.arrival ?? new Date())} to ${day(stays.reduce((d, s) => (s.departure > d ? s.departure : d), stays[0]?.departure ?? new Date()))}`,
      ],
    ]);
    table(
      doc,
      [
        { title: 'Night', width: 80 },
        { title: 'Room and rate', width: 295 },
        { title: 'Rate', width: 120, align: 'right' },
      ],
      rows,
    );
    totals(doc, [
      ['Rooms before tax', money(total - taxTotal, cur)],
      ...[...taxes.entries()].map(([name, amount]): [string, string] => [name, money(amount, cur)]),
      ['Total', money(total, cur)],
      ...(depositHeldMinor > 0n
        ? ([
            ['Deposit received', money(-depositHeldMinor, cur)],
            ['To pay', money(total - depositHeldMinor, cur)],
          ] as [string, string][])
        : []),
    ]);
    footer(
      doc,
      `This is not a tax invoice. Prices as quoted when the booking was made, in ${cur}. Please quote ${reservation.confirmationNo} with your payment.`,
    );
  });
  await recordAudit(db, {
    action: 'reservation.proforma_issued',
    entityType: 'reservation',
    entityId: reservation.id,
    after: { totalMinor: total.toString(), depositHeldMinor: depositHeldMinor.toString() },
  });
  return { filename: `proforma-${safeName(reservation.confirmationNo)}.pdf`, content };
}

// ── Deposit receipt (M4-13; T-063) ───────────────────────────────────────────────────────

export async function depositReceipt(deps: PaymentDeps, reservationId: string, paymentId: string) {
  const db = deps.tenantDb;
  const reservation = await db.reservation.findUnique({
    where: { id: reservationId },
    include: {
      property: true,
      booker: true,
      company: true,
      depositEntries: true,
      payments: { include: { receivedBy: { select: { name: true } } } },
      stays: { orderBy: { arrival: 'asc' } },
    },
  });
  if (!reservation) throw new AppError('NOT_FOUND', 'Reservation not found');
  const payment = reservation.payments.find((p) => p.id === paymentId);
  if (!payment) throw new AppError('NOT_FOUND', 'Payment not found');
  const cur = payment.currency;
  const number = payment.id.slice(0, 8).toUpperCase();
  const held = reservation.depositEntries.reduce((s, e) => s + e.amountMinor, 0n);
  const booker = reservation.booker;
  const first = reservation.stays[0];
  const content = await render((doc) => {
    header(doc, reservation.property, 'DEPOSIT RECEIPT');
    facts(doc, [
      ['Receipt no.', number],
      ['Date', day(payment.businessDate)],
      [
        'Received from',
        reservation.company?.name ?? `${booker.firstName} ${booker.lastName}`.trim(),
      ],
      ['Booking', reservation.confirmationNo],
      ['Arrival', first ? day(first.arrival) : '—'],
      ['Stays', String(reservation.stays.length)],
    ]);
    table(
      doc,
      [
        { title: 'Method', width: 140 },
        { title: 'Reference', width: 235 },
        { title: 'Amount', width: 120, align: 'right' },
      ],
      [
        [
          METHOD[payment.method] ?? payment.method,
          payment.externalRef ?? '—',
          money(payment.amountMinor, cur),
        ],
      ],
    );
    totals(doc, [
      ['Amount received', money(payment.amountMinor, cur)],
      ['Deposit held for this booking', money(held, cur)],
    ]);
    footer(
      doc,
      [
        'An advance deposit: it is credited to the guest bill at check-in.',
        payment.receivedBy ? `Received by ${payment.receivedBy.name}.` : null,
        payment.note ? `Note: ${payment.note}.` : null,
        `Payment ${payment.id}.`,
      ]
        .filter(Boolean)
        .join(' '),
    );
  });
  await recordAudit(db, {
    action: 'payment.receipt_issued',
    entityType: 'payment',
    entityId: payment.id,
    after: { reservationId: reservation.id, number },
  });
  return { filename: `receipt-${number}.pdf`, content };
}
